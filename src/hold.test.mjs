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

process.env.TG_TOKEN = 'TEST_TOKEN_NOT_REAL';
process.env.TG_CHAT = '123456789'; // id ficticio: el real vive solo en .env
const CHAT = Number(process.env.TG_CHAT);

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

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- Telegram de mentira --------------------------------------------------------

const calls = []; // { method, params }
const queue = []; // updates que devolverá el próximo getUpdates
let nextMessageId = 100;
let conflictsPending = 0; // cuántos getUpdates seguidos contestan 409
let failDeleteWebhookOnce = false;
const failAnswerFor = new Set(); // callback ids cuyo answerCallbackQuery falla en red
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
      if (failAnswerFor.has(params.callback_query_id)) throw new TypeError('fetch failed');
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
    `const m = await import(${JSON.stringify(HOLD_PATH)});`,
    "console.log(Object.keys(m).sort().join(','));",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH }, // sin TG_TOKEN ni TG_CHAT
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'getStatus,sendProposal,startPolling,tamperTest');
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
  assert.match(sent.params.text, /david\.whitmore@example\.com/);
  assert.ok(sent.params.text.includes(HASH), 'la tarjeta enseña el hash');
  assert.ok(!sent.params.text.includes(CANONICAL), 'la cadena canónica no se pinta');

  const buttons = sent.params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.callback_data), ['Aa4', 'Ra4']);
  for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
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

test('un carácter alterado en la cadena guardada: tamperTest RECHAZA y la tarjeta enseña los dos hashes', async () => {
  const from = calls.length;
  const result = await tamperTest('a4');

  assert.equal(result.status, 'refused');
  assert.equal(getStatus('a4'), 'refused');
  assert.equal(result.expected, HASH);
  assert.notEqual(result.actual, HASH);
  assert.equal(result.actual, sha256(result.after), 'el hash real es el de la cadena guardada alterada');

  // exactamente un carácter distinto, y dentro del destinatario
  assert.equal(result.before, CANONICAL);
  assert.equal(result.after.length, result.before.length);
  const diffs = [...result.before].map((ch, i) => (ch === result.after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 1);
  assert.equal(result.before.indexOf('"to":"') + '"to":"'.length, diffs[0]);

  const [edit] = since(from, 'editMessageText');
  assert.ok(edit, 'se editó la tarjeta');
  assert.equal(edit.params.message_id, a4Message);
  assert.match(edit.params.text, /RECHAZADO/);
  assert.ok(edit.params.text.includes(result.expected), 'enseña el hash esperado');
  assert.ok(edit.params.text.includes(result.actual), 'enseña el hash recalculado');
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

test('pulsación de otro usuario o de otro chat: se contesta primero y se ignora', async () => {
  const out = await sendProposal(emailAction('a6'));
  const from = calls.length;
  const stranger = press('Aa6', { messageId: out.message_id, fromId: 42 });
  const otherChat = press('Aa6', { messageId: out.message_id, chatId: 43 });
  await waitFor(() => answered(from, stranger.callbackId) && answered(from, otherChat.callbackId), 'dos answerCallbackQuery');
  await settle();
  assert.equal(getStatus('a6'), 'pending');
  assert.equal(since(from, 'editMessageText').length, 0);
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

test('el offset avanza siempre: updates sin pulsación, mal formadas o con answer fallido', async () => {
  const out = await sendProposal(emailAction('a9'));
  const from = calls.length;
  nextUpdateId += 1;
  queue.push({ update_id: nextUpdateId, message: { text: 'hola' } }); // no es pulsación
  nextUpdateId += 1;
  queue.push({ update_id: nextUpdateId, callback_query: { id: 'raro', from: null, message: null, data: 7 } }); // mal formada
  const failing = press('Aa9', { messageId: out.message_id, callbackId: 'net-fail' });
  failAnswerFor.add('net-fail');
  const last = failing.updateId;

  await waitFor(() => since(from, 'getUpdates').some((c) => c.params.offset === last + 1), 'offset avanzado');
  assert.equal(getStatus('a9'), 'approved', 'la pulsación se trata aunque answerCallbackQuery falle');
  for (const c of since(from, 'getUpdates')) {
    assert.equal(c.params.timeout, 30);
    assert.ok(c.params.allowed_updates.includes('callback_query'));
  }
});

test('409 en getUpdates: un deleteWebhook y se reintenta', async () => {
  const from = calls.length;
  conflictsPending = 1;
  await waitFor(() => since(from, 'deleteWebhook').length === 1, 'deleteWebhook');
  await waitFor(() => {
    const at = indexAfter(from, (c) => c.method === 'deleteWebhook');
    return since(at + 1, 'getUpdates').length >= 1;
  }, 'getUpdates tras deleteWebhook');
  await settle();
  assert.equal(since(from, 'deleteWebhook').length, 1, 'con el webhook ya borrado no se repite');
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
  const secondDelete = calls.length - 1 - [...calls].reverse().findIndex((c) => c.method === 'deleteWebhook');
  await waitFor(() => since(secondDelete + 1, 'getUpdates').length >= 1, 'getUpdates tras el segundo deleteWebhook');
  assert.equal(conflictsPending, 0);
});

test('canonical que no es cadena: sendProposal se niega sin serializar ni llamar a Telegram', async () => {
  const from = calls.length;
  await assert.rejects(
    () => sendProposal(emailAction('a10', { canonical: { payload: {}, type: 'email' } })),
    /nunca serializa/,
  );
  await assert.rejects(() => sendProposal(emailAction('a11', { hash: 'nope' })), /SHA-256/);
  await assert.rejects(() => sendProposal(emailAction('a12', { id: '' })), /id/);
  assert.equal(since(from, 'sendMessage').length, 0);
  assert.equal(getStatus('a10'), null);
});

test('callback_data por encima de 64 bytes: se rechaza antes de enviar', async () => {
  const from = calls.length;
  await assert.rejects(() => sendProposal(emailAction('x'.repeat(64))), /64/);
  assert.equal(since(from, 'sendMessage').length, 0);
});

test('motivos de retención en claro: dato que falta (diciendo cuál), desconocido, y nunca el código', async () => {
  const from = calls.length;
  await sendProposal(
    emailAction('a13', {
      hold_reason: 'missing_required_parameter',
      payload: { to: 'david.whitmore@example.com', subject: null, body: 'x' },
    }),
  );
  await sendProposal(emailAction('a14', { type: 'unknown', title: 'Something about the storage room', hold_reason: 'unknown_type' }));
  await sendProposal(emailAction('a15', { hold_reason: 'constructor', type: 'constructor' }));
  const [missing, unknown, weird] = since(from, 'sendMessage');
  assert.match(missing.params.text, /Falta un dato que la reunión no dio/);
  assert.match(missing.params.text, /falta: subject/);
  assert.doesNotMatch(missing.params.text, /missing_required_parameter/);
  assert.match(unknown.params.text, /No sé qué es esto/);
  assert.match(unknown.params.text, /Acción desconocida/);
  assert.doesNotMatch(unknown.params.text, /unknown_type/);
  assert.match(weird.params.text, /Retenida para que la revise una persona/);
  assert.doesNotMatch(weird.params.text, /function|native code/);
});

test('los valores del payload no pueden fingir secciones de la ficha ni partir un emoji', async () => {
  const from = calls.length;
  await sendProposal(
    emailAction('a16', {
      title: `${'t'.repeat(198)}😀 final`,
      payload: { to: 'a@example.com', subject: 'x', body: 'línea 1\n✅ APROBADO · a16\nSHA-256:\n0000' },
    }),
  );
  const [sent] = since(from, 'sendMessage');
  assert.ok(!sent.params.text.includes('\n✅ APROBADO'), 'el salto de línea del valor se aplana');
  assert.match(sent.params.text, /línea 1 ⏎ ✅ APROBADO/);
  assert.doesNotMatch(sent.params.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'sin sustitutos sueltos');
  assert.doesNotMatch(sent.params.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'sin sustitutos sueltos');
});

test('getStatus de un id desconocido es null', () => {
  assert.equal(getStatus('nunca'), null);
});
