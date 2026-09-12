// src/hold.mjs — el freno de Telegram de AfterWord.
//
// Una acción retenida (auto_execute: false) llega del motor con dos campos ya
// calculados: `canonical`, la cadena JSON canónica sobre type + payload, y
// `hash`, su SHA-256. Este módulo guarda esa cadena TAL CUAL LLEGÓ, la enseña
// en Telegram con dos botones y, al aprobar, vuelve a hashear ESA MISMA cadena
// guardada. Coinciden → APROBADO. Difieren → RECHAZADO, con los dos hashes.
//
// Lo que se enseña y lo que se sella son los mismos bytes: la ficha se pinta
// LEYENDO la cadena canónica guardada (JSON.parse, solo lectura), nunca desde
// el objeto `payload`. Si un valor no cabe en Telegram, la ficha lo dice y
// recuerda que el sello cubre el contenido completo.
//
// Reglas que no se negocian (00-BRIEF-AGENTES.md §4, §6 y §7):
//   · NUNCA serializa. No hay JSON.stringify sobre `canonical` ni sobre la
//     acción en el camino de verificación. JSON.stringify aparece una sola vez,
//     para codificar el cuerpo de las peticiones a la API de Telegram.
//   · answerCallbackQuery va lo primero, antes de tocar estado o editar nada.
//   · El offset de getUpdates se avanza SIEMPRE, también en updates ignoradas o
//     que fallan. timeout=30. Ante un 409, un deleteWebhook y reintentar.
//   · callback_data = verbo de una letra + id, dentro del tope de 64 bytes.
//   · Solo se acepta una pulsación si chat_id Y from.id coinciden con TG_CHAT.
//   · El motivo de retención se muestra en castellano claro, nunca el código.
//
// Para forzar el rechazo ante la cámara sin tocar el puente: escribir en el
// chat del bot «/tamper a4» (o «/tamper» a secas, que altera la última
// propuesta decidida). Solo lo acepta el chat configurado.
//
// La consola no imprime el token, el chat, la cadena canónica ni excepciones
// sin filtrar: ese terminal sale en el vídeo.
//
// Importar este módulo no tiene efectos: nada lee .env, nada abre red y nada
// arranca hasta que se llama a sendProposal() o startPolling().

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TELEGRAM_API = 'https://api.telegram.org';
const CALLBACK_DATA_MAX_BYTES = 64; // tope de Telegram: 1–64 bytes
const LONG_POLL_TIMEOUT_S = 30;
const LONG_POLL_ABORT_MS = (LONG_POLL_TIMEOUT_S + 15) * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const CONFLICT_DELAY_MS = 3_000;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 4_000; // Telegram corta en 4096
const TAMPER_COMMAND = '/tamper';

// El código del motor nunca llega a la pantalla: se traduce aquí.
const HOLD_REASON_TEXT = {
  irreversible_type: 'Esto no se puede deshacer',
  unknown_type: 'No sé qué es esto',
  missing_required_parameter: 'Falta un dato que la reunión no dio',
};
const HOLD_REASON_FALLBACK = 'Retenida para que la revise una persona';

const TYPE_LABEL = {
  email: 'Correo',
  listing_publish: 'Publicación de anuncio',
  calendar_event: 'Cita',
  task: 'Tarea',
  note: 'Nota',
  unknown: 'Acción desconocida',
};

/**
 * @typedef {object} Proposal
 * @property {string} id
 * @property {string} canonical   La cadena tal cual llegó del motor. Nunca se reconstruye.
 * @property {string} hash        El SHA-256 que llegó con ella.
 * @property {object} action      La acción completa: título, resumen y motivo (metadatos de presentación).
 * @property {{type:string, payload:object}} sealed   Lectura de la cadena canónica: lo que se pinta.
 * @property {'pending'|'approved'|'refused'} status
 * @property {number|null} message_id   Mensaje de Telegram que enseñó la ficha.
 * @property {string|number|null} chat_id
 * @property {{ok:boolean, expected:string, actual:string}|null} check
 * @property {'approved'|'retained'|'mismatch'|'tampered'|null} decision
 */

/** @type {Map<string, Proposal>} */
const proposals = new Map();
let env = null;
let poller = null;
let lastOffset = 0; // sobrevive a stop()/startPolling() dentro del mismo proceso
let lastProposedId = null;
let lastDecidedId = null;

const log = (...parts) => console.log('[hold]', ...parts);
const sameId = (a, b) => a !== undefined && a !== null && String(a) === String(b);
const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/** Resumen de un error apto para una consola que sale en cámara: sin token, sin URL, acotado. */
function describeError(err) {
  let text = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
  if (env?.token) text = text.split(env.token).join('<token>');
  text = text.replace(/https?:\/\/\S+/g, '<url>');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Espera `ms`, o menos si la señal se aborta (así stop() no deja esperas colgando). */
function sleep(ms, signal) {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
}

// ---------------------------------------------------------------------------
// .env — se lee la primera vez que hace falta, nunca al importar.
// ---------------------------------------------------------------------------

function loadEnv() {
  if (env) return env;
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) {
    const candidates = [resolve(ROOT, '.env'), resolve(process.cwd(), '.env')];
    const file = candidates.find((path) => existsSync(path));
    if (!file) {
      throw new Error(
        `Falta el fichero .env (buscado en ${candidates[0]}). ` +
          'Copia .env.example a .env y rellena TG_TOKEN y TG_CHAT.',
      );
    }
    try {
      process.loadEnvFile(file); // no pisa variables que ya vengan del entorno
    } catch (err) {
      throw new Error(`No se pudo leer ${file}: ${err?.message ?? err}`);
    }
  }
  const token = String(process.env.TG_TOKEN ?? '').trim();
  const chat = String(process.env.TG_CHAT ?? '').trim();
  if (!token) throw new Error('TG_TOKEN está vacío (en .env o en el entorno del proceso): es el token del bot que da @BotFather.');
  if (!chat) throw new Error('TG_CHAT está vacío (en .env o en el entorno del proceso): es el id del chat privado que aprueba.');
  if (chat.startsWith('-')) {
    log('aviso: TG_CHAT parece un grupo. La regla exige chat privado (chat_id y from.id iguales a TG_CHAT); en un grupo ninguna pulsación se aceptará.');
  }
  env = { token, chat };
  return env;
}

// ---------------------------------------------------------------------------
// Telegram — una sola función habla con la API. El token nunca se imprime.
// ---------------------------------------------------------------------------

async function tgRequest(method, params = {}, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  const { token } = loadEnv();
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params), // el cuerpo de la petición; aquí nunca viaja `canonical`
    signal,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function tg(method, params) {
  const { status, body } = await tgRequest(method, params);
  if (!body || body.ok !== true) {
    throw new Error(`Telegram ${method} → HTTP ${status}: ${body?.description ?? 'respuesta no válida'}`);
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// La atadura por hash. Esta es la tesis del proyecto y son cuatro líneas.
// ---------------------------------------------------------------------------

/**
 * Re-hashea la cadena guardada, tal cual llegó, y la compara con el hash que
 * llegó con ella. Nada se reconstruye ni se reserializa.
 */
function verify(proposal) {
  const actual = createHash('sha256').update(proposal.canonical, 'utf8').digest('hex');
  const expected = proposal.hash;
  return { ok: actual === expected.toLowerCase(), expected, actual };
}

/**
 * Lee type + payload DE la cadena canónica. Solo se parsea para pintar la
 * ficha; el hash sigue calculándose sobre la cadena guardada. Devuelve null si
 * la cadena no describe {type, payload}: entonces no hay nada que enseñar y la
 * propuesta se rechaza antes de mandar ninguna tarjeta.
 */
function readSealed(canonical) {
  let parsed;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.type !== 'string') return null;
  if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) return null;
  return { type: parsed.type, payload: parsed.payload };
}

/** Comparación informativa entre lo que trae el objeto y lo que ata la cadena. */
function sealedMismatch(sealed, action) {
  if (sealed.type !== action.type) return 'type';
  const shown = action.payload && typeof action.payload === 'object' ? action.payload : {};
  for (const key of new Set([...Object.keys(shown), ...Object.keys(sealed.payload)])) {
    if (!sameValue(shown[key], sealed.payload[key])) return `payload.${key}`;
  }
  return null;
}

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Texto de las fichas, en castellano claro.
// ---------------------------------------------------------------------------

/** Recorta sin partir un par sustituto (un emoji a medias haría fallar sendMessage). */
function cutAt(text, max) {
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${cutAt(s, max - 1)}…`;
}

/** Una sola línea: ningún salto (ASCII o Unicode) puede fingir secciones de la ficha. */
function oneLine(value) {
  return String(value).replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, ' ⏎ ');
}

function describe(proposal) {
  const label = lookup(TYPE_LABEL, proposal.sealed.type) ?? 'Acción';
  const title = proposal.action?.title ?? proposal.sealed.type;
  return `${label} — ${clip(oneLine(title), MAX_TITLE_CHARS)}`;
}

function holdReasonText(action, sealedPayload) {
  const base = lookup(HOLD_REASON_TEXT, action?.hold_reason) ?? HOLD_REASON_FALLBACK;
  if (action?.hold_reason === 'missing_required_parameter') {
    const missing = Object.entries(sealedPayload)
      .filter(([, value]) => value === null || value === undefined)
      .map(([key]) => oneLine(key));
    if (missing.length) return `${base} (falta: ${missing.join(', ')})`;
  }
  return base;
}

/** Aplana valores anidados en pares [ruta, valor] para que nada quede como "[object Object]". */
function flatten(prefix, value, out) {
  if (value === null || value === undefined) {
    out.push([prefix, null]);
  } else if (Array.isArray(value)) {
    if (!value.length) out.push([prefix, '[]']);
    value.forEach((item, i) => flatten(`${prefix}[${i}]`, item, out));
  } else if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out.push([prefix, '{}']);
    for (const key of keys) flatten(`${prefix}.${key}`, value[key], out);
  } else {
    out.push([prefix, String(value)]);
  }
}

/** Los valores se enseñan completos, leídos de la cadena sellada. */
function payloadLines(sealedPayload) {
  const pairs = [];
  for (const [key, value] of Object.entries(sealedPayload)) flatten(key, value, pairs);
  if (!pairs.length) return ['· (sin datos)'];
  return pairs.map(([path, value]) => (value === null ? `· ${oneLine(path)}: — falta` : `· ${oneLine(path)}: ${oneLine(value)}`));
}

/**
 * Une cabecera, cuerpo y cola. Si el cuerpo no cabe en Telegram, se recorta y
 * la ficha lo dice en voz alta: nunca se aprueba en silencio algo que no se vio.
 * El hash va en la cola y no se corta jamás.
 */
function assemble(head, middle, tail) {
  const headText = head.join('\n');
  const tailText = tail.join('\n');
  let middleText = middle.join('\n');
  const budget = Math.max(MAX_TEXT_CHARS - headText.length - tailText.length - 2, 80);
  if (middleText.length > budget) {
    const note = (hidden) =>
      `\n⚠️ Recortado para caber en Telegram: ${hidden} caracteres no se muestran. El sello SHA-256 cubre el contenido completo.`;
    const kept = Math.max(budget - note(middleText.length).length - 1, 0);
    const shown = cutAt(middleText, kept);
    middleText = `${shown}…${note(middleText.length - shown.length)}`;
  }
  return middleText ? `${headText}\n${middleText}\n${tailText}` : `${headText}\n${tailText}`;
}

function cardText(proposal) {
  const head = [`🔒 RETENIDA · ${oneLine(proposal.id)}`, describe(proposal)];
  if (proposal.action?.summary) head.push(clip(oneLine(proposal.action.summary), MAX_TITLE_CHARS));
  const middle = [
    '',
    `Por qué se retiene: ${holdReasonText(proposal.action, proposal.sealed.payload)}`,
    '',
    'Lo que haría si se aprueba (leído de los bytes sellados):',
    ...payloadLines(proposal.sealed.payload),
  ];
  const tail = ['', 'SHA-256 de lo que se aprueba:', proposal.hash];
  return assemble(head, middle, tail);
}

function decidedText(proposal) {
  const id = oneLine(proposal.id);
  const head = [];
  const tail = [];
  if (proposal.status === 'approved') {
    head.push(`✅ APROBADO · ${id}`, describe(proposal));
    tail.push('', 'Liberado: lo aprobado es exactamente lo que se mostró.', 'SHA-256:', proposal.check.expected);
  } else if (proposal.decision === 'retained') {
    head.push(`⛔ RETENIDO · ${id}`, describe(proposal));
    tail.push('', 'No se libera. Lo ha retenido la persona.');
  } else {
    head.push(`⛔ RECHAZADO · ${id}`, describe(proposal));
    tail.push(
      '',
      'Lo que se iba a ejecutar ya no es lo que se mostró. No se libera.',
      'Hash mostrado (esperado):',
      proposal.check.expected,
      'Hash actual (recalculado):',
      proposal.check.actual,
    );
  }
  return assemble(head, [], tail);
}

/** Edita la ficha con el veredicto. Sin reply_markup, los botones desaparecen. */
async function editCard(proposal) {
  if (proposal.message_id === null || proposal.message_id === undefined) {
    log(`${proposal.id}: no hay tarjeta que editar (el envío a Telegram no llegó a completarse)`);
    return;
  }
  try {
    await tg('editMessageText', {
      chat_id: proposal.chat_id,
      message_id: proposal.message_id,
      text: decidedText(proposal),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log(`no se pudo editar la tarjeta ${proposal.id}: ${describeError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// API pública — exactamente cuatro cosas.
// ---------------------------------------------------------------------------

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('sendProposal: se esperaba la acción resuelta que emite el motor');
  }
  const { id, canonical, hash } = action;
  if (typeof id !== 'string' || id === '' || !/^[^\s\p{C}]+$/u.test(id)) {
    throw new TypeError('sendProposal: la acción no trae un `id` válido (sin espacios ni caracteres de control); sin id no hay botón de aprobar');
  }
  if (typeof canonical !== 'string' || canonical === '') {
    throw new TypeError(
      `sendProposal(${id}): \`canonical\` tiene que llegar como cadena desde el motor. ` +
        'El puente nunca serializa: no se reconstruye desde el objeto.',
    );
  }
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new TypeError(`sendProposal(${id}): \`hash\` tiene que ser el SHA-256 hexadecimal (64 caracteres) de \`canonical\``);
  }
  const sealed = readSealed(canonical);
  if (!sealed) {
    throw new TypeError(
      `sendProposal(${id}): la cadena canónica no describe {type, payload}; no se puede enseñar lo que se sellaría, así que no se manda ninguna tarjeta`,
    );
  }
  return { id, canonical, hash, sealed };
}

/**
 * Guarda {id, canonical, hash, status:'pending'} con la cadena tal cual llegó y
 * manda la ficha a Telegram con los botones Aprobar y Retener. La ficha se
 * pinta leyendo la cadena canónica: lo mostrado y lo sellado son los mismos bytes.
 *
 * Si Telegram falla, la propuesta queda guardada como `pending` sin tarjeta y
 * el error se propaga para que el puente lo vea. Si el id ya existía, la
 * propuesta nueva sustituye a la anterior y la tarjeta vieja deja de valer
 * (cada pulsación se ata al message_id de la tarjeta que enseñó esos bytes).
 *
 * @param {object} action  Acción resuelta del motor (con `canonical` y `hash`).
 * @returns {Promise<{id:string, status:'pending', hash:string, message_id:number|null}>}
 */
export async function sendProposal(action) {
  const { id, canonical, hash, sealed } = validateAction(action);
  const { chat } = loadEnv();

  const approveData = `A${id}`;
  const retainData = `R${id}`;
  for (const data of [approveData, retainData]) {
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > CALLBACK_DATA_MAX_BYTES) {
      throw new RangeError(
        `sendProposal(${id}): callback_data de ${bytes} bytes supera el tope de ${CALLBACK_DATA_MAX_BYTES}; ` +
          'Telegram rechazaría el mensaje entero, no el botón',
      );
    }
  }

  if (proposals.has(id)) {
    log(`propuesta ${id} sustituida por una nueva; la tarjeta anterior queda sin efecto`);
  }

  /** @type {Proposal} */
  const proposal = {
    id,
    canonical, // tal cual llegó
    hash,
    action,
    sealed,
    status: 'pending',
    message_id: null,
    chat_id: null,
    check: null,
    decision: null,
  };
  proposals.set(id, proposal);
  lastProposedId = id;

  const early = verify(proposal);
  if (!early.ok) {
    log(`aviso ${id}: el hash recibido no es el SHA-256 de la cadena canónica recibida; la aprobación se rechazará`);
    log(`  hash recibido:    ${early.expected}`);
    log(`  hash recalculado: ${early.actual}`);
  }
  const mismatch = sealedMismatch(sealed, action);
  if (mismatch) {
    log(`aviso ${id}: el objeto de la acción y la cadena canónica no coinciden en ${mismatch}. La ficha enseña la cadena sellada, que es lo que se aprueba.`);
  }

  const sent = await tg('sendMessage', {
    chat_id: chat,
    text: cardText(proposal),
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Aprobar', callback_data: approveData },
          { text: '⛔ Retener', callback_data: retainData },
        ],
      ],
    },
  });
  proposal.message_id = sent?.message_id ?? null;
  proposal.chat_id = sent?.chat?.id ?? chat;
  log(`tarjeta ${id} enviada (mensaje ${proposal.message_id})`);

  return { id, status: proposal.status, hash, message_id: proposal.message_id };
}

/**
 * Estado de una propuesta. `null` si nunca se propuso ese id.
 * @param {string} id
 * @returns {'pending'|'approved'|'refused'|null}
 */
export function getStatus(id) {
  const proposal = proposals.get(id);
  return proposal ? proposal.status : null;
}

/** Comando de texto «/tamper [id]» desde el chat configurado: fuerza el rechazo ante la cámara. */
async function handleCommand(message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const [word, ...rest] = text.split(/\s+/);
  if (!word || word.split('@')[0] !== TAMPER_COMMAND) return; // cualquier otro mensaje se ignora

  const { chat } = loadEnv();
  if (!sameId(message.chat?.id, chat) || !sameId(message.from?.id, chat)) {
    log('comando rechazado: chat o usuario no autorizado');
    return;
  }
  const wanted = rest[0] ?? '';
  const id = wanted || lastDecidedId || lastProposedId;
  if (!id || !proposals.has(id)) {
    log(`comando ${TAMPER_COMMAND}: no hay propuesta que manipular`);
    try {
      await tg('sendMessage', {
        chat_id: chat,
        text: wanted ? `No conozco ninguna propuesta «${clip(oneLine(wanted), 40)}».` : 'Aún no hay ninguna propuesta que manipular.',
      });
    } catch (err) {
      log(`no se pudo contestar al comando: ${describeError(err)}`);
    }
    return;
  }
  await tamperTest(id);
}

/**
 * Trata una update de getUpdates. Cuando entra aquí, el offset ya está avanzado.
 */
async function handleUpdate(update) {
  const press = update?.callback_query;
  if (!press) {
    if (update?.message) await handleCommand(update.message);
    return; // no es una pulsación: ignorada
  }

  // 1 · LO PRIMERO: contestar, para que el botón deje de girar. Aún no se ha
  //     tocado estado ni se ha editado nada.
  try {
    await tg('answerCallbackQuery', { callback_query_id: press.id });
  } catch (err) {
    log(`answerCallbackQuery falló (${describeError(err)}); la pulsación se trata igual`);
  }

  // 2 · Solo decide el chat configurado: chat_id Y from.id iguales a TG_CHAT.
  const { chat } = loadEnv();
  if (!sameId(press.message?.chat?.id, chat) || !sameId(press.from?.id, chat)) {
    log('pulsación rechazada: chat o usuario no autorizado');
    return;
  }

  // 3 · Verbo de una letra + id.
  const data = typeof press.data === 'string' ? press.data : '';
  const verb = data.slice(0, 1);
  const id = data.slice(1);
  if ((verb !== 'A' && verb !== 'R') || !id) {
    log('pulsación ignorada: callback_data no reconocido');
    return;
  }

  const proposal = proposals.get(id);
  if (!proposal) {
    log(`pulsación ignorada: propuesta ${clip(oneLine(id), 40)} desconocida`);
    return;
  }
  // La pulsación tiene que venir de la tarjeta que enseñó estos bytes.
  if (proposal.message_id === null || !sameId(press.message?.message_id, proposal.message_id)) {
    log(`pulsación ignorada: tarjeta antigua para ${id}`);
    return;
  }
  if (proposal.status !== 'pending') {
    log(`pulsación ignorada: ${id} ya está ${proposal.status}`);
    return;
  }

  if (verb === 'R') {
    proposal.status = 'refused';
    proposal.decision = 'retained';
    lastDecidedId = id;
    log(`${id}: RETENIDO por la persona`);
    await editCard(proposal);
    return;
  }

  // 4 · Aprobar. Lo único que libera es el hash de la cadena guardada.
  const check = verify(proposal);
  proposal.check = check;
  proposal.status = check.ok ? 'approved' : 'refused';
  proposal.decision = check.ok ? 'approved' : 'mismatch';
  lastDecidedId = id;
  if (check.ok) {
    log(`${id}: APROBADO (sha256 ${check.actual})`);
  } else {
    log(`${id}: RECHAZADO — los bytes no coinciden`);
    log(`  hash mostrado (esperado): ${check.expected}`);
    log(`  hash actual (recalculado): ${check.actual}`);
  }
  await editCard(proposal);
}

async function pollLoop(state) {
  let webhookCleared = false; // un deleteWebhook que haya llegado a Telegram desde el último 409
  log(`sondeo iniciado (getUpdates, timeout=${LONG_POLL_TIMEOUT_S}s, offset=${lastOffset})`);

  while (state.running) {
    state.controller = new AbortController();
    const { signal } = state.controller;
    let res;
    try {
      res = await tgRequest(
        'getUpdates',
        { timeout: LONG_POLL_TIMEOUT_S, offset: lastOffset, allowed_updates: ['callback_query', 'message'] },
        AbortSignal.any([signal, AbortSignal.timeout(LONG_POLL_ABORT_MS)]),
      );
    } catch (err) {
      if (!state.running) break;
      log(`getUpdates falló (${describeError(err)}); reintento en ${RETRY_DELAY_MS} ms`);
      await sleep(RETRY_DELAY_MS, signal);
      continue;
    }
    if (!state.running) break;

    if (res.status === 409) {
      if (!webhookCleared) {
        // Un deleteWebhook y reintentar. Si la llamada no llegó, se repite en el siguiente 409.
        log('getUpdates devolvió 409 (había un webhook activo): deleteWebhook y reintento');
        try {
          await tg('deleteWebhook', { drop_pending_updates: false });
          webhookCleared = true;
        } catch (err) {
          log(`deleteWebhook falló (${describeError(err)}); se repetirá si el 409 persiste`);
          await sleep(RETRY_DELAY_MS, signal);
        }
      } else {
        log(`getUpdates sigue en 409 tras borrar el webhook: otro proceso sondea con este token. Reintento en ${CONFLICT_DELAY_MS} ms`);
        await sleep(CONFLICT_DELAY_MS, signal);
      }
      continue;
    }
    webhookCleared = false; // cualquier respuesta que no sea 409 rearma el deleteWebhook

    if (!res.body || res.body.ok !== true || !Array.isArray(res.body.result)) {
      log(`getUpdates → HTTP ${res.status}: ${clip(oneLine(res.body?.description ?? 'respuesta no válida'), 120)}; reintento en ${RETRY_DELAY_MS} ms`);
      await sleep(RETRY_DELAY_MS, signal);
      continue;
    }

    for (const update of res.body.result) {
      // SIEMPRE se avanza el offset, antes de tratar la update y pase lo que pase.
      if (Number.isInteger(update?.update_id)) lastOffset = update.update_id + 1;
      try {
        await handleUpdate(update);
      } catch (err) {
        log(`update ${update?.update_id ?? '?'} ignorada por error: ${describeError(err)}`);
      }
    }
  }
  log('sondeo terminado');
}

/**
 * Arranca el bucle de getUpdates (long polling, timeout=30). Devuelve la
 * función que lo para. Llamarlo dos veces devuelve el mismo stop.
 * @returns {() => void}
 */
export function startPolling() {
  if (poller) return poller.stop;
  loadEnv(); // si falta el .env, falla aquí con un mensaje claro
  const state = { running: true, controller: null };
  const stop = () => {
    if (!state.running) return;
    state.running = false;
    state.controller?.abort();
    if (poller?.stop === stop) poller = null;
  };
  poller = { stop };
  void pollLoop(state);
  return stop;
}

/** Cambia un solo carácter del valor de `key` dentro de la cadena, por cirugía de texto. */
function alterOneCharacter(text, key) {
  const marker = `"${key}":"`;
  const at = text.indexOf(marker);
  let index = at >= 0 ? at + marker.length : -1;
  let where = key;
  if (index < 0 || index >= text.length) {
    const first = text.indexOf('":"'); // primer valor de texto que haya
    index = first >= 0 ? first + 3 : -1;
    where = 'el primer valor';
  }
  if (index < 0 || index >= text.length) {
    index = Math.floor(text.length / 2);
    where = 'la cadena';
  }
  const original = text[index];
  const replacement = original === 'x' ? 'y' : 'x';
  return { altered: `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`, where };
}

/**
 * Altera un carácter del destinatario DENTRO de la cadena canónica guardada y
 * repite la comprobación por el mismo camino que una aprobación real. La
 * cadena ya no es la que se mostró, así que el resultado es RECHAZADO y la
 * tarjeta se edita enseñando los dos hashes.
 *
 * También se dispara desde el chat con «/tamper [id]».
 *
 * @param {string} id
 * @returns {Promise<{id:string, status:'approved'|'refused', expected:string, actual:string, before:string, after:string}>}
 */
export async function tamperTest(id) {
  const proposal = proposals.get(id);
  if (!proposal) throw new Error(`tamperTest(${id}): no hay ninguna propuesta con ese id`);

  const before = proposal.canonical;
  const { altered: after, where } = alterOneCharacter(before, 'to');
  proposal.canonical = after; // se altera LA CADENA GUARDADA, que es lo que se re-hashea

  const check = verify(proposal);
  proposal.check = check;
  proposal.status = check.ok ? 'approved' : 'refused';
  proposal.decision = check.ok ? 'approved' : 'tampered';
  lastDecidedId = id;

  log(`tamperTest(${id}): un carácter alterado en ${where === 'to' ? 'el destinatario' : where} de la cadena guardada`);
  log(`  hash mostrado (esperado): ${check.expected}`);
  log(`  hash actual (recalculado): ${check.actual}`);
  log(`  resultado: ${proposal.status === 'refused' ? 'RECHAZADO' : 'APROBADO (no debería ocurrir)'}`);

  await editCard(proposal);
  return { id, status: proposal.status, expected: check.expected, actual: check.actual, before, after };
}
