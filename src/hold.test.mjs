// src/hold.test.mjs — prueba del freno sin red.
//
//   node --test src/hold.test.mjs
//
// La cadena canónica del ejemplo va escrita literal, y su SHA-256 se calculó
// una sola vez a partir de esa cadena (Node y Python dan el mismo valor).
// `fetch` se sustituye por un Telegram de mentira que registra cada llamada;
// nada sale a la red y no se lee ningún .env real.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.TG_TOKEN = 'TEST_TOKEN_NOT_REAL_123456';
process.env.TG_CHAT = '123456789'; // id ficticio: el real vive solo en .env
const CHAT = Number(process.env.TG_CHAT);
const TOKEN = process.env.TG_TOKEN;

// --- La acción de ejemplo: la tarjeta de correo de la demo ---------------------

const CANONICAL =
  '{"payload":{"body":"3% + VAT, 90 days exclusive, asking price approx. €329,000","subject":"Listing agreement — Ruzafa","to":"david.whitmore@example.com"},"type":"email"}';
const HASH = 'd5ccca115a92dfaa5da6418f91ad8c6b7dcd6c335e4221c96b33c60e90450ae2';

function emailAction(id, overrides = {}) {
  return {
    id,
    type: 'email',
    title: 'Send listing agreement to David Whitmore',
    summary: '3% + VAT, 90 days exclusive, approx. €329,000',
    payload: {
      to: 'david.whitmore@example.com',
      subject: 'Listing agreement — Ruzafa',
      body: '3% + VAT, 90 days exclusive, asking price approx. €329,000',
    },
    action_evidence: ['L03'],
    support: 'weak',
    confidence: 0.3,
    auto_execute: false,
    hold_reason: 'irreversible_type',
    canonical: CANONICAL,
    hash: HASH,
    ...overrides,
  };
}

/** Una acción cuya cadena canónica se escribe aquí mismo, con su hash calculado de esa cadena. */
function sealedAction(id, canonical, overrides = {}) {
  const parsed = JSON.parse(canonical);
  return emailAction(id, { canonical, hash: sha256(canonical), type: parsed.type, payload: parsed.payload, ...overrides });
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- Telegram de mentira --------------------------------------------------------

const calls = []; // { method, params }
const queue = []; // updates que devolverá el próximo getUpdates
let nextMessageId = 100;
let conflictsPending = 0; // cuántos getUpdates seguidos contestan 409
let failDeleteWebhookOnce = false;
const failAnswerFor = new Map(); // callback id → error que lanza answerCallbackQuery
const hooks = { onAnswer: null }; // observa el estado en el instante del answerCallbackQuery

function reply(status, body) {
  return { status, ok: status < 400, json: async () => body };
}

globalThis.fetch = async (url, init = {}) => {
  const method = String(url).split('/').pop();
  const params = init.body ? JSON.parse(init.body) : {};
  calls.push({ method, params });
  switch (method) {
    case 'sendMessage':
      nextMessageId += 1;
      return reply(200, { ok: true, result: { message_id: nextMessageId, chat: { id: params.chat_id } } });
    case 'answerCallbackQuery':
      hooks.onAnswer?.(params);
      if (failAnswerFor.has(params.callback_query_id)) throw failAnswerFor.get(params.callback_query_id);
      return reply(200, { ok: true, result: true });
    case 'deleteWebhook':
      if (failDeleteWebhookOnce) {
        failDeleteWebhookOnce = false;
        throw new TypeError('fetch failed');
      }
      return reply(200, { ok: true, result: true });
    case 'getUpdates': {
      if (conflictsPending > 0) {
        conflictsPending -= 1;
        return reply(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
      }
      if (queue.length) return reply(200, { ok: true, result: queue.splice(0) });
      // long polling simulado: vacío enseguida, o abortado por stop()
      await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) return abort();
        const timer = setTimeout(resolve, 5);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); abort(); }, { once: true });
      });
      return reply(200, { ok: true, result: [] });
    }
    default:
      return reply(200, { ok: true, result: true });
  }
};

let nextUpdateId = 1000;
let nextCallbackId = 1;
function press(data, { fromId = CHAT, chatId = CHAT, messageId, callbackId } = {}) {
  nextUpdateId += 1;
  nextCallbackId += 1;
  const id = callbackId ?? `cb-${nextCallbackId}`;
  queue.push({
    update_id: nextUpdateId,
    callback_query: {
      id,
      from: { id: fromId, is_bot: false, first_name: 'Manu' },
      message: { message_id: messageId, chat: { id: chatId, type: 'private' } },
      chat_instance: '1',
      data,
    },
  });
  return { updateId: nextUpdateId, callbackId: id };
}
function say(text, { fromId = CHAT, chatId = CHAT } = {}) {
  nextUpdateId += 1;
  queue.push({
    update_id: nextUpdateId,
    message: { message_id: 1, from: { id: fromId, is_bot: false }, chat: { id: chatId, type: 'private' }, text },
  });
  return { updateId: nextUpdateId };
}

async function waitFor(predicate, label, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timeout esperando: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 30));

const since = (from, method) => calls.slice(from).filter((c) => c.method === method);
const indexAfter = (from, pred) => {
  const i = calls.slice(from).findIndex(pred);
  return i === -1 ? -1 : from + i;
};
const answered = (from, callbackId) => since(from, 'answerCallbackQuery').some((c) => c.params.callback_query_id === callbackId);
const waitOffset = (from, offset, label) => waitFor(() => since(from, 'getUpdates').some((c) => c.params.offset === offset), label);

/** Captura lo que el módulo escribe por consola mientras corre `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// --- El módulo bajo prueba: se importa después de preparar el entorno -------------

const { sendProposal, getStatus, startPolling, tamperTest } = await import('./hold.mjs');
const HOLD_PATH = fileURLToPath(new URL('./hold.mjs', import.meta.url));

let stop;
before(() => {
  stop = startPolling();
});
after(() => {
  stop();
});

// --- Pruebas -------------------------------------------------------------------

test('el hash literal del ejemplo es el SHA-256 de la cadena literal', () => {
  assert.equal(sha256(CANONICAL), HASH);
});

test('importar el módulo no tiene efectos: sin .env, sin red, y exactamente cuatro exports', () => {
  const code = [
    "globalThis.fetch = () => { throw new Error('fetch en la importación'); };",
    "process.loadEnvFile = () => { throw new Error('.env leído en la importación'); };",
    `const m = await import(${JSON.stringify(HOLD_PATH)});`,
    "console.log(Object.keys(m).sort().join(','), 'TG_TOKEN' in process.env, 'TG_CHAT' in process.env);",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH }, // sin TG_TOKEN ni TG_CHAT
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'getStatus,sendProposal,startPolling,tamperTest false false');
});

let a4Message;
test('la ficha: motivo en castellano, dos botones, callback_data de una letra + id y bajo 64 bytes', async () => {
  const from = calls.length;
  const out = await sendProposal(emailAction('a4'));
  a4Message = out.message_id;
  assert.equal(out.status, 'pending');
  assert.equal(getStatus('a4'), 'pending');

  const [sent] = since(from, 'sendMessage');
  assert.ok(sent, 'se envió la tarjeta');
  assert.equal(String(sent.params.chat_id), process.env.TG_CHAT);
  assert.match(sent.params.text, /Esto no se puede deshacer/);
  assert.doesNotMatch(sent.params.text, /irreversible_type/);
  assert.match(sent.params.text, /· to: david\.whitmore@example\.com/);
  assert.match(sent.params.text, /· body: 3% \+ VAT, 90 days exclusive, asking price approx\. €329,000/);
  assert.ok(sent.params.text.includes(HASH), 'la tarjeta enseña el hash');
  assert.ok(!sent.params.text.includes(CANONICAL), 'la cadena canónica no se pinta en bruto');
  assert.doesNotMatch(sent.params.text, /Recortado/);

  const buttons = sent.params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.callback_data), ['Aa4', 'Ra4']);
  for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('la ficha se pinta desde la cadena sellada, no desde el objeto payload', async () => {
  const from = calls.length;
  const lines = await captureLogs(() =>
    sendProposal(emailAction('a4s', { payload: { to: 'otro@example.com', subject: 'Otro asunto', body: 'otro cuerpo' } })),
  );
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· to: david\.whitmore@example\.com/, 'enseña el destinatario sellado');
  assert.doesNotMatch(sent.params.text, /otro@example\.com/, 'no enseña el del objeto');
  assert.ok(lines.some((l) => /no coinciden en payload\./.test(l)), 'avisa por consola de la discrepancia');
  assert.ok(!lines.some((l) => l.includes('otro@example.com') || l.includes('david.whitmore')), 'sin valores en consola');
});

test('cadena canónica que no describe {type, payload}: no se manda tarjeta', async () => {
  const from = calls.length;
  const noType = '{"payload":{"to":"x"}}';
  await assert.rejects(() => sendProposal(emailAction('a4t', { canonical: noType, hash: sha256(noType) })), /no describe/);
  await assert.rejects(() => sendProposal(emailAction('a4u', { canonical: 'no es json', hash: sha256('no es json') })), /no describe/);
  assert.equal(since(from, 'sendMessage').length, 0);
  assert.equal(getStatus('a4t'), null);
});

test('cadena limpia: aprobar re-hashea la cadena guardada y APRUEBA; answerCallbackQuery va antes que el estado y que la edición', async () => {
  const from = calls.length;
  let statusAtAnswer = null;
  const { callbackId } = press('Aa4', { messageId: a4Message });
  hooks.onAnswer = (params) => {
    if (params.callback_query_id === callbackId) statusAtAnswer = getStatus('a4');
  };
  await waitFor(() => getStatus('a4') !== 'pending', 'decisión de a4');
  hooks.onAnswer = null;
  assert.equal(getStatus('a4'), 'approved');
  assert.equal(statusAtAnswer, 'pending', 'al contestar la pulsación el estado aún no se había tocado');

  const answerAt = indexAfter(from, (c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === callbackId);
  const editAt = indexAfter(from, (c) => c.method === 'editMessageText' && c.params.message_id === a4Message);
  assert.ok(answerAt !== -1, 'se contestó la pulsación');
  assert.ok(editAt !== -1, 'se editó la tarjeta');
  assert.ok(answerAt < editAt, 'answerCallbackQuery va antes de editar');

  const edit = calls[editAt].params;
  assert.match(edit.text, /APROBADO/);
  assert.ok(edit.text.includes(HASH));
  assert.equal(edit.reply_markup, undefined, 'los botones desaparecen');
});

test('nunca serializa: una cadena que NO es su propia reserialización en JS se aprueba igual', async () => {
  // Con espacios y con «€» escapado al estilo json.dumps(ensure_ascii=True) de Python:
  // JSON.stringify(JSON.parse(x)) daría otros bytes y otro hash.
  const pythonish = '{"payload": {"body": "\\u20ac329,000", "subject": "x", "to": "a@example.com"}, "type": "email"}';
  assert.notEqual(JSON.stringify(JSON.parse(pythonish)), pythonish);
  const from = calls.length;
  const out = await sendProposal(sealedAction('a4p', pythonish));
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· body: €329,000/, 'la ficha enseña el valor decodificado de la cadena');
  press('Aa4p', { messageId: out.message_id });
  await waitFor(() => getStatus('a4p') !== 'pending', 'decisión de a4p');
  assert.equal(getStatus('a4p'), 'approved');
});

test('un carácter alterado en la cadena guardada: tamperTest RECHAZA y la tarjeta enseña los dos hashes', async () => {
  const from = calls.length;
  let r;
  const logs = await captureLogs(async () => {
    r = await tamperTest('a4');
  });

  assert.equal(r.status, 'refused');
  assert.equal(getStatus('a4'), 'refused');
  assert.equal(r.expected, HASH);
  assert.notEqual(r.actual, HASH);
  assert.equal(r.actual, sha256(r.after), 'el hash real es el de la cadena guardada alterada');

  // exactamente un carácter distinto, y dentro del destinatario
  assert.equal(r.before, CANONICAL);
  assert.equal(r.after.length, r.before.length);
  const diffs = [...r.before].map((ch, i) => (ch === r.after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 1);
  assert.equal(r.before.indexOf('"to":"') + '"to":"'.length, diffs[0]);

  const [edit] = since(from, 'editMessageText');
  assert.ok(edit, 'se editó la tarjeta');
  assert.equal(edit.params.message_id, a4Message);
  assert.match(edit.params.text, /RECHAZADO/);
  assert.ok(edit.params.text.includes(r.expected), 'enseña el hash esperado');
  assert.ok(edit.params.text.includes(r.actual), 'enseña el hash recalculado');

  // La consola enseña los dos hashes pero nunca la cadena canónica.
  assert.ok(logs.some((l) => l.includes(r.expected)) && logs.some((l) => l.includes(r.actual)));
  assert.ok(!logs.some((l) => l.includes('david.whitmore') || l.includes(r.after) || l.includes(r.before)), 'la cadena no sale por consola');

  // Alterar de nuevo parte de la cadena YA alterada: se manipuló lo guardado, no una copia.
  const again = await tamperTest('a4');
  assert.equal(again.before, r.after);
  await assert.rejects(() => tamperTest('nunca'), /no hay ninguna propuesta/);
});

test('un carácter alterado en origen (cadena distinta, mismo hash): aprobar RECHAZA con los dos hashes', async () => {
  const altered = CANONICAL.replace('329,000', '329,001');
  assert.equal(altered.length, CANONICAL.length);
  const from = calls.length;
  const out = await sendProposal(emailAction('a5', { canonical: altered }));
  press('Aa5', { messageId: out.message_id });
  await waitFor(() => getStatus('a5') !== 'pending', 'decisión de a5');
  assert.equal(getStatus('a5'), 'refused');

  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /RECHAZADO/);
  assert.ok(edit.params.text.includes(HASH));
  assert.ok(edit.params.text.includes(sha256(altered)));
});

test('pulsación de otro usuario o de otro chat: se contesta primero, se ignora y no se imprimen ids', async () => {
  const out = await sendProposal(emailAction('a6'));
  const from = calls.length;
  const stranger = press('Aa6', { messageId: out.message_id, fromId: 42 });
  const otherChat = press('Aa6', { messageId: out.message_id, chatId: 43 });
  const logs = await captureLogs(async () => {
    await waitFor(() => answered(from, stranger.callbackId) && answered(from, otherChat.callbackId), 'dos answerCallbackQuery');
    await settle();
  });
  assert.equal(getStatus('a6'), 'pending');
  assert.equal(since(from, 'editMessageText').length, 0);
  assert.ok(logs.some((l) => /no autorizado/.test(l)));
  assert.ok(!logs.some((l) => /\b(42|43|123456789)\b/.test(l)), 'ningún id de chat o usuario en consola');
});

test('tarjeta antigua (otro message_id) no aprueba; la tarjeta correcta sí', async () => {
  const out = await sendProposal(emailAction('a7'));
  const from = calls.length;
  const stale = press('Aa7', { messageId: out.message_id - 1 });
  await waitFor(() => answered(from, stale.callbackId), 'respuesta a la tarjeta antigua');
  await settle();
  assert.equal(getStatus('a7'), 'pending');

  press('Aa7', { messageId: out.message_id });
  await waitFor(() => getStatus('a7') !== 'pending', 'decisión de a7');
  assert.equal(getStatus('a7'), 'approved');
});

test('segunda pulsación sobre una tarjeta ya decidida: se contesta y no cambia nada', async () => {
  const out = await sendProposal(emailAction('a7b'));
  press('Aa7b', { messageId: out.message_id });
  await waitFor(() => getStatus('a7b') === 'approved', 'a7b aprobada');
  const from = calls.length;
  const again = press('Ra7b', { messageId: out.message_id });
  await waitFor(() => answered(from, again.callbackId), 'respuesta a la segunda pulsación');
  await settle();
  assert.equal(getStatus('a7b'), 'approved');
  assert.equal(since(from, 'editMessageText').length, 0);
});

test('verbo desconocido o id desconocido: se contesta y se ignora', async () => {
  const out = await sendProposal(emailAction('a7c'));
  const from = calls.length;
  const badVerb = press('Za7c', { messageId: out.message_id });
  const badId = press('Anadie', { messageId: out.message_id });
  await waitFor(() => answered(from, badVerb.callbackId) && answered(from, badId.callbackId), 'dos respuestas');
  await settle();
  assert.equal(getStatus('a7c'), 'pending');
  assert.equal(getStatus('nadie'), null);
  assert.equal(since(from, 'editMessageText').length, 0);
});

test('botón Retener: refused sin tocar el hash, y la tarjeta lo dice', async () => {
  const out = await sendProposal(emailAction('a8'));
  const from = calls.length;
  press('Ra8', { messageId: out.message_id });
  await waitFor(() => getStatus('a8') !== 'pending', 'decisión de a8');
  assert.equal(getStatus('a8'), 'refused');
  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /RETENIDO/);
});

test('el offset avanza siempre, update a update: sin pulsación, mal formada, que revienta, o con answer fallido', async () => {
  const out = await sendProposal(emailAction('a9'));
  let from = calls.length;

  // 1 · un mensaje de texto cualquiera, solo en este lote
  const plain = say('hola');
  await waitOffset(from, plain.updateId + 1, 'offset tras mensaje sin pulsación');

  // 2 · una pulsación mal formada, sola
  from = calls.length;
  nextUpdateId += 1;
  const malformed = nextUpdateId;
  queue.push({ update_id: malformed, callback_query: { id: 'raro', from: null, message: null, data: 7 } });
  await waitOffset(from, malformed + 1, 'offset tras update mal formada');

  // 3 · una update que revienta dentro del tratamiento (getter que lanza), sola
  from = calls.length;
  nextUpdateId += 1;
  const exploding = nextUpdateId;
  queue.push({
    update_id: exploding,
    callback_query: {
      id: 'boom',
      get from() {
        throw new Error('boom');
      },
      message: { message_id: out.message_id, chat: { id: CHAT } },
      data: 'Aa9',
    },
  });
  const logs = await captureLogs(() => waitOffset(from, exploding + 1, 'offset tras update que revienta'));
  assert.ok(logs.some((l) => /ignorada por error/.test(l)));
  assert.equal(getStatus('a9'), 'pending');

  // 4 · answerCallbackQuery falla en red: la pulsación se trata igual
  from = calls.length;
  failAnswerFor.set('net-fail', new TypeError('fetch failed'));
  const failing = press('Aa9', { messageId: out.message_id, callbackId: 'net-fail' });
  await waitOffset(from, failing.updateId + 1, 'offset tras answer fallido');
  assert.equal(getStatus('a9'), 'approved', 'la pulsación se trata aunque answerCallbackQuery falle');

  for (const c of since(from, 'getUpdates')) {
    assert.equal(c.params.timeout, 30);
    assert.ok(c.params.allowed_updates.includes('callback_query'));
    assert.ok(c.params.allowed_updates.includes('message'));
  }
});

test('409 en getUpdates: un deleteWebhook y se reintenta; con el webhook ya borrado no se repite', async () => {
  const from = calls.length;
  conflictsPending = 2; // dos 409 seguidos
  await waitFor(() => since(from, 'deleteWebhook').length === 1, 'deleteWebhook');
  await waitFor(() => conflictsPending === 0, 'segundo 409 consumido');
  await waitFor(() => {
    const at = indexAfter(from, (c) => c.method === 'deleteWebhook');
    return since(at + 1, 'getUpdates').length >= 2;
  }, 'getUpdates tras deleteWebhook', 5000);
  assert.equal(since(from, 'deleteWebhook').length, 1, 'un solo deleteWebhook aunque el 409 se repita');
});

test('parar y volver a arrancar conserva el offset', async () => {
  const last = nextUpdateId; // última update consumida
  stop();
  await settle();
  const from = calls.length;
  stop = startPolling();
  await waitFor(() => since(from, 'getUpdates').length >= 1, 'getUpdates tras rearrancar');
  assert.equal(since(from, 'getUpdates')[0].params.offset, last + 1);
});

test('409 con deleteWebhook fallido en red: se repite el deleteWebhook en el siguiente 409', async () => {
  const from = calls.length;
  failDeleteWebhookOnce = true;
  conflictsPending = 2;
  await waitFor(() => since(from, 'deleteWebhook').length === 2, 'segundo deleteWebhook', 5000);
  const deletes = calls.map((c, i) => (i >= from && c.method === 'deleteWebhook' ? i : -1)).filter((i) => i !== -1);
  const secondDelete = deletes[1];
  await waitFor(() => since(secondDelete + 1, 'getUpdates').length >= 1, 'getUpdates tras el segundo deleteWebhook');
  assert.equal(conflictsPending, 0);
});

test('canonical que no es cadena, hash inválido o id inválido: sendProposal se niega sin serializar ni llamar a Telegram', async () => {
  const from = calls.length;
  await assert.rejects(
    () => sendProposal(emailAction('a10', { canonical: { payload: {}, type: 'email' } })),
    /nunca serializa/,
  );
  await assert.rejects(() => sendProposal(emailAction('a11', { hash: 'nope' })), /SHA-256/);
  await assert.rejects(() => sendProposal(emailAction('a12', { id: '' })), /id/);
  await assert.rejects(() => sendProposal(emailAction('a12\n✅ APROBADO')), /id/);
  assert.equal(since(from, 'sendMessage').length, 0);
  assert.equal(getStatus('a10'), null);
});

test('callback_data: 64 bytes exactos pasan, 65 bytes (multibyte incluido) se rechazan antes de enviar', async () => {
  const from = calls.length;
  await assert.rejects(() => sendProposal(emailAction('x'.repeat(64))), /64/);
  await assert.rejects(() => sendProposal(emailAction('é'.repeat(32))), /64/); // 32 caracteres, 65 bytes con el verbo
  assert.equal(since(from, 'sendMessage').length, 0);
  const out = await sendProposal(emailAction('x'.repeat(63)));
  assert.equal(out.status, 'pending');
  assert.equal(since(from, 'sendMessage').length, 1);
});

test('motivos de retención en claro: dato que falta (diciendo cuál), desconocido, y nunca el código', async () => {
  const from = calls.length;
  await sendProposal(sealedAction('a13', '{"payload":{"body":"x","subject":null,"to":"david.whitmore@example.com"},"type":"email"}', { hold_reason: 'missing_required_parameter' }));
  await sendProposal(sealedAction('a14', '{"payload":{"description":"Something about the storage room"},"type":"unknown"}', { title: 'Something about the storage room', hold_reason: 'unknown_type' }));
  await sendProposal(sealedAction('a15', '{"payload":{"body":"x"},"type":"constructor"}', { hold_reason: 'constructor' }));
  const [missing, unknown, weird] = since(from, 'sendMessage');
  assert.match(missing.params.text, /Falta un dato que la reunión no dio/);
  assert.match(missing.params.text, /falta: subject/);
  assert.match(missing.params.text, /· subject: — falta/);
  assert.doesNotMatch(missing.params.text, /missing_required_parameter/);
  assert.match(unknown.params.text, /No sé qué es esto/);
  assert.match(unknown.params.text, /Acción desconocida/);
  assert.doesNotMatch(unknown.params.text, /unknown_type/);
  assert.match(weird.params.text, /Retenida para que la revise una persona/);
  assert.match(weird.params.text, /Acción — /);
  assert.doesNotMatch(weird.params.text, /function|native code/);
});

test('los valores del payload no pueden fingir secciones de la ficha (saltos ASCII y Unicode) ni partir un emoji', async () => {
  const from = calls.length;
  const canonical =
    '{"payload":{"body":"línea 1\\n✅ APROBADO · a16\\nSHA-256:\\n0000","subject":"a\\u2028✅ APROBADO\\u2029b\\u0085c","to":"a@example.com"},"type":"email"}';
  await sendProposal(sealedAction('a16', canonical, { title: `${'t'.repeat(198)}😀 final` }));
  const [sent] = since(from, 'sendMessage');
  assert.ok(!sent.params.text.includes('\n✅ APROBADO'), 'el salto de línea del valor se aplana');
  assert.match(sent.params.text, /línea 1 ⏎ ✅ APROBADO/);
  assert.match(sent.params.text, /a ⏎ ✅ APROBADO ⏎ b ⏎ c/);
  assert.doesNotMatch(sent.params.text, /[\u0085\u2028\u2029]/, 'sin separadores Unicode en la ficha');
  assert.doesNotMatch(sent.params.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'sin sustitutos sueltos');
  assert.doesNotMatch(sent.params.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'sin sustitutos sueltos');
});

test('valores anidados se enseñan campo a campo, nunca como [object Object]', async () => {
  const from = calls.length;
  const canonical = '{"payload":{"attendees":[{"email":"a@x.com"},{"email":"b@x.com"}],"title":"Call","when":{"end":"13:00","start":"12:00"}},"type":"calendar_event"}';
  await sendProposal(sealedAction('a17', canonical));
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· attendees\[0\]\.email: a@x\.com/);
  assert.match(sent.params.text, /· attendees\[1\]\.email: b@x\.com/);
  assert.match(sent.params.text, /· when\.start: 12:00/);
  assert.match(sent.params.text, /· title: Call/);
  assert.match(sent.params.text, /Cita — /);
  assert.doesNotMatch(sent.params.text, /\[object Object\]/);
});

test('un valor que no cabe en Telegram se recorta diciéndolo, y el hash nunca se corta', async () => {
  const from = calls.length;
  const long = 'L'.repeat(6000);
  const canonical = `{"payload":{"body":"${long}","subject":"s","to":"a@example.com"},"type":"email"}`;
  await sendProposal(sealedAction('a18', canonical));
  const [sent] = since(from, 'sendMessage');
  assert.ok(sent.params.text.length <= 4096, `cabe en Telegram (${sent.params.text.length})`);
  assert.match(sent.params.text, /Recortado para caber en Telegram: \d+ caracteres no se muestran\. El sello SHA-256 cubre el contenido completo\./);
  assert.ok(sent.params.text.endsWith(sha256(canonical)), 'el hash cierra la ficha intacto');
});

test('/tamper desde el chat configurado fuerza el rechazo; desde otro usuario se ignora; id desconocido se contesta', async () => {
  const out = await sendProposal(emailAction('a19'));
  press('Aa19', { messageId: out.message_id });
  await waitFor(() => getStatus('a19') === 'approved', 'a19 aprobada');

  let from = calls.length;
  const stranger = say('/tamper a19', { fromId: 42 });
  await waitOffset(from, stranger.updateId + 1, 'comando de extraño consumido');
  assert.equal(getStatus('a19'), 'approved', 'un extraño no puede manipular');

  from = calls.length;
  say('/tamper a19');
  await waitFor(() => getStatus('a19') === 'refused', 'a19 rechazada por /tamper');
  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /RECHAZADO/);
  assert.ok(edit.params.text.includes(HASH));
  assert.ok(/Hash actual \(recalculado\):\n[0-9a-f]{64}/.test(edit.params.text));

  // «/tamper» a secas actúa sobre la última propuesta decidida
  const out2 = await sendProposal(emailAction('a19b'));
  press('Aa19b', { messageId: out2.message_id });
  await waitFor(() => getStatus('a19b') === 'approved', 'a19b aprobada');
  say('/tamper@afterword_bot');
  await waitFor(() => getStatus('a19b') === 'refused', 'a19b rechazada por /tamper a secas');

  // id desconocido: se contesta en el chat, no revienta
  from = calls.length;
  const unknown = say('/tamper zzz');
  await waitOffset(from, unknown.updateId + 1, 'comando con id desconocido consumido');
  const [replyMsg] = since(from, 'sendMessage');
  assert.match(replyMsg.params.text, /No conozco ninguna propuesta «zzz»/);
});

test('el token nunca sale por consola, ni dentro de una excepción de red', async () => {
  const out = await sendProposal(emailAction('a20'));
  const from = calls.length;
  failAnswerFor.set('leak', new TypeError(`request to https://api.telegram.org/bot${TOKEN}/answerCallbackQuery failed, reason: ECONNRESET`));
  const logs = await captureLogs(async () => {
    press('Aa20', { messageId: out.message_id, callbackId: 'leak' });
    await waitFor(() => getStatus('a20') !== 'pending', 'decisión de a20');
  });
  assert.equal(getStatus('a20'), 'approved');
  assert.ok(logs.some((l) => /answerCallbackQuery falló/.test(l)));
  assert.ok(!logs.some((l) => l.includes(TOKEN)), 'el token no aparece');
  assert.ok(!logs.some((l) => l.includes('api.telegram.org')), 'la URL no aparece');
  assert.equal(since(from, 'sendMessage').length, 0);
});

test('getStatus de un id desconocido es null', () => {
  assert.equal(getStatus('nunca'), null);
});
