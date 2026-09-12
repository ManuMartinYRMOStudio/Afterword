// src/hold.test.mjs — tests for the hold, with no network.
//
//   node --test src/hold.test.mjs
//
// The example canonical string is written literally, and its SHA-256 was
// computed once from that string (Node and Python give the same value).
// `fetch` is replaced by a fake Telegram that records every call; nothing
// goes out to the network and no real .env is read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.TG_TOKEN = 'TEST_TOKEN_NOT_REAL_123456';
process.env.TG_CHAT = '123456789'; // fictitious id: the real one lives only in .env
const CHAT = Number(process.env.TG_CHAT);
const TOKEN = process.env.TG_TOKEN;

// --- The example action: the demo's email card ---------------------------------

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

/** An action whose canonical string is written right here, with its hash computed from that string. */
function sealedAction(id, canonical, overrides = {}) {
  const parsed = JSON.parse(canonical);
  return emailAction(id, { canonical, hash: sha256(canonical), type: parsed.type, payload: parsed.payload, ...overrides });
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// --- Fake Telegram ---------------------------------------------------------------

const calls = []; // { method, params }
const queue = []; // updates the next getUpdates will return
let nextMessageId = 100;
let conflictsPending = 0; // how many consecutive getUpdates answer 409
let failDeleteWebhookOnce = false;
const failAnswerFor = new Map(); // callback id → error thrown by answerCallbackQuery
const hooks = { onAnswer: null }; // observes state at the instant of answerCallbackQuery

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
      // simulated long polling: empty right away, or aborted by stop()
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
    if (Date.now() - start > ms) throw new Error(`timeout waiting for: ${label}`);
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

/** Captures what the module writes to the console while `fn` runs. */
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

// --- The module under test: imported after the environment is prepared ------------

const { sendProposal, getStatus, startPolling, tamperTest } = await import('./hold.mjs');
const HOLD_PATH = fileURLToPath(new URL('./hold.mjs', import.meta.url));

let stop;
before(() => {
  stop = startPolling();
});
after(() => {
  stop();
});

// --- Tests -------------------------------------------------------------------------

test('the literal hash of the example is the SHA-256 of the literal string', () => {
  assert.equal(sha256(CANONICAL), HASH);
});

test('importing the module has no side effects: no .env, no network, and exactly four exports', () => {
  const code = [
    "globalThis.fetch = () => { throw new Error('fetch during import'); };",
    "process.loadEnvFile = () => { throw new Error('.env read during import'); };",
    `const m = await import(${JSON.stringify(HOLD_PATH)});`,
    "console.log(Object.keys(m).sort().join(','), 'TG_TOKEN' in process.env, 'TG_CHAT' in process.env);",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH }, // no TG_TOKEN or TG_CHAT
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'getStatus,sendProposal,startPolling,tamperTest false false');
});

let a4Message;
test('the card: reason in plain English, two buttons, one-letter verb + id callback_data within 64 bytes', async () => {
  const from = calls.length;
  const out = await sendProposal(emailAction('a4'));
  a4Message = out.message_id;
  assert.equal(out.status, 'pending');
  assert.equal(getStatus('a4'), 'pending');

  const [sent] = since(from, 'sendMessage');
  assert.ok(sent, 'the card was sent');
  assert.equal(String(sent.params.chat_id), process.env.TG_CHAT);
  assert.match(sent.params.text, /^🔒 HELD · a4\n/);
  assert.match(sent.params.text, /Why this is held: This cannot be undone/);
  assert.doesNotMatch(sent.params.text, /irreversible_type/);
  assert.match(sent.params.text, /What would happen if approved \(read from sealed bytes\):/);
  assert.match(sent.params.text, /· to: david\.whitmore@example\.com/);
  assert.match(sent.params.text, /· body: 3% \+ VAT, 90 days exclusive, asking price approx\. €329,000/);
  assert.match(sent.params.text, /SHA-256 of what you approve:/);
  assert.ok(sent.params.text.includes(HASH), 'the card shows the hash');
  assert.ok(!sent.params.text.includes(CANONICAL), 'the raw canonical string is not rendered');
  assert.doesNotMatch(sent.params.text, /Truncated/);

  const buttons = sent.params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['✅ APPROVE', '⛔ HOLD']);
  assert.deepEqual(buttons.map((b) => b.callback_data), ['Aa4', 'Ra4']);
  for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('the card is rendered from the sealed string, not from the payload object', async () => {
  const from = calls.length;
  const lines = await captureLogs(() =>
    sendProposal(emailAction('a4s', { payload: { to: 'other@example.com', subject: 'Other subject', body: 'other body' } })),
  );
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· to: david\.whitmore@example\.com/, 'shows the sealed recipient');
  assert.doesNotMatch(sent.params.text, /other@example\.com/, 'does not show the object value');
  assert.ok(lines.some((l) => /differ at payload\./.test(l)), 'warns on the console about the discrepancy');
  assert.ok(!lines.some((l) => l.includes('other@example.com') || l.includes('david.whitmore')), 'no values on the console');
});

test('a canonical string that does not describe {type, payload}: no card is sent', async () => {
  const from = calls.length;
  const noType = '{"payload":{"to":"x"}}';
  await assert.rejects(() => sendProposal(emailAction('a4t', { canonical: noType, hash: sha256(noType) })), /does not describe/);
  await assert.rejects(() => sendProposal(emailAction('a4u', { canonical: 'not json', hash: sha256('not json') })), /does not describe/);
  assert.equal(since(from, 'sendMessage').length, 0);
  assert.equal(getStatus('a4t'), null);
});

test('clean string: approving re-hashes the stored string and APPROVES; answerCallbackQuery comes before state and edit', async () => {
  const from = calls.length;
  let statusAtAnswer = null;
  const { callbackId } = press('Aa4', { messageId: a4Message });
  hooks.onAnswer = (params) => {
    if (params.callback_query_id === callbackId) statusAtAnswer = getStatus('a4');
  };
  await waitFor(() => getStatus('a4') !== 'pending', 'decision on a4');
  hooks.onAnswer = null;
  assert.equal(getStatus('a4'), 'approved');
  assert.equal(statusAtAnswer, 'pending', 'when the press was answered the state had not been touched yet');

  const answerAt = indexAfter(from, (c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === callbackId);
  const editAt = indexAfter(from, (c) => c.method === 'editMessageText' && c.params.message_id === a4Message);
  assert.ok(answerAt !== -1, 'the press was answered');
  assert.ok(editAt !== -1, 'the card was edited');
  assert.ok(answerAt < editAt, 'answerCallbackQuery comes before the edit');

  const edit = calls[editAt].params;
  assert.match(edit.text, /^✅ APPROVED · a4\n/);
  assert.match(edit.text, /Released: what was approved is exactly what was shown\./);
  assert.ok(edit.text.includes(HASH));
  assert.equal(edit.reply_markup, undefined, 'the buttons disappear');
});

test('never serialises: a string that is NOT its own JS re-serialisation is approved all the same', async () => {
  // With spaces and with "€" escaped the way Python's json.dumps(ensure_ascii=True) does:
  // JSON.stringify(JSON.parse(x)) would give other bytes and another hash.
  const pythonish = '{"payload": {"body": "\\u20ac329,000", "subject": "x", "to": "a@example.com"}, "type": "email"}';
  assert.notEqual(JSON.stringify(JSON.parse(pythonish)), pythonish);
  const from = calls.length;
  const out = await sendProposal(sealedAction('a4p', pythonish));
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· body: €329,000/, 'the card shows the decoded value of the string');
  press('Aa4p', { messageId: out.message_id });
  await waitFor(() => getStatus('a4p') !== 'pending', 'decision on a4p');
  assert.equal(getStatus('a4p'), 'approved');
});

test('one character altered in the stored string: tamperTest REJECTS and the card shows both hashes', async () => {
  const from = calls.length;
  let r;
  const logs = await captureLogs(async () => {
    r = await tamperTest('a4');
  });

  assert.equal(r.status, 'refused');
  assert.equal(getStatus('a4'), 'refused');
  assert.equal(r.expected, HASH);
  assert.notEqual(r.actual, HASH);
  assert.equal(r.actual, sha256(r.after), 'the actual hash is that of the altered stored string');

  // exactly one character differs, and inside the recipient
  assert.equal(r.before, CANONICAL);
  assert.equal(r.after.length, r.before.length);
  const diffs = [...r.before].map((ch, i) => (ch === r.after[i] ? null : i)).filter((i) => i !== null);
  assert.equal(diffs.length, 1);
  assert.equal(r.before.indexOf('"to":"') + '"to":"'.length, diffs[0]);

  const [edit] = since(from, 'editMessageText');
  assert.ok(edit, 'the card was edited');
  assert.equal(edit.params.message_id, a4Message);
  assert.match(edit.params.text, /^⛔ REJECTED · a4\n/);
  assert.match(edit.params.text, /Expected hash \(shown\):\n[0-9a-f]{64}\nActual hash \(recomputed\):\n[0-9a-f]{64}/);
  assert.ok(edit.params.text.includes(r.expected), 'shows the expected hash');
  assert.ok(edit.params.text.includes(r.actual), 'shows the recomputed hash');

  // The console shows both hashes but never the canonical string.
  assert.ok(logs.some((l) => l.includes(r.expected)) && logs.some((l) => l.includes(r.actual)));
  assert.ok(!logs.some((l) => l.includes('david.whitmore') || l.includes(r.after) || l.includes(r.before)), 'the string does not reach the console');

  // Altering the ALREADY altered string again: the stored string was tampered with, not a copy.
  const again = await tamperTest('a4');
  assert.equal(again.before, r.after);
  await assert.rejects(() => tamperTest('never'), /no proposal with that id/);
});

test('one character altered at the source (different string, same hash): approving REJECTS with both hashes', async () => {
  const altered = CANONICAL.replace('329,000', '329,001');
  assert.equal(altered.length, CANONICAL.length);
  const from = calls.length;
  const out = await sendProposal(emailAction('a5', { canonical: altered }));
  press('Aa5', { messageId: out.message_id });
  await waitFor(() => getStatus('a5') !== 'pending', 'decision on a5');
  assert.equal(getStatus('a5'), 'refused');

  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /REJECTED/);
  assert.ok(edit.params.text.includes(HASH));
  assert.ok(edit.params.text.includes(sha256(altered)));
});

test('a press from another user or another chat: answered first, ignored, and no ids are printed', async () => {
  const out = await sendProposal(emailAction('a6'));
  const from = calls.length;
  const stranger = press('Aa6', { messageId: out.message_id, fromId: 42 });
  const otherChat = press('Aa6', { messageId: out.message_id, chatId: 43 });
  const logs = await captureLogs(async () => {
    await waitFor(() => answered(from, stranger.callbackId) && answered(from, otherChat.callbackId), 'two answerCallbackQuery calls');
    await settle();
  });
  assert.equal(getStatus('a6'), 'pending');
  assert.equal(since(from, 'editMessageText').length, 0);
  assert.ok(logs.some((l) => /not authorised/.test(l)));
  assert.ok(!logs.some((l) => /\b(42|43|123456789)\b/.test(l)), 'no chat or user id on the console');
});

test('a stale card (other message_id) does not approve; the right card does', async () => {
  const out = await sendProposal(emailAction('a7'));
  const from = calls.length;
  const stale = press('Aa7', { messageId: out.message_id - 1 });
  await waitFor(() => answered(from, stale.callbackId), 'answer to the stale card');
  await settle();
  assert.equal(getStatus('a7'), 'pending');

  press('Aa7', { messageId: out.message_id });
  await waitFor(() => getStatus('a7') !== 'pending', 'decision on a7');
  assert.equal(getStatus('a7'), 'approved');
});

test('a second press on an already decided card: answered and nothing changes', async () => {
  const out = await sendProposal(emailAction('a7b'));
  press('Aa7b', { messageId: out.message_id });
  await waitFor(() => getStatus('a7b') === 'approved', 'a7b approved');
  const from = calls.length;
  const again = press('Ra7b', { messageId: out.message_id });
  await waitFor(() => answered(from, again.callbackId), 'answer to the second press');
  await settle();
  assert.equal(getStatus('a7b'), 'approved');
  assert.equal(since(from, 'editMessageText').length, 0);
});

test('unknown verb or unknown id: answered and ignored', async () => {
  const out = await sendProposal(emailAction('a7c'));
  const from = calls.length;
  const badVerb = press('Za7c', { messageId: out.message_id });
  const badId = press('Anobody', { messageId: out.message_id });
  await waitFor(() => answered(from, badVerb.callbackId) && answered(from, badId.callbackId), 'two answers');
  await settle();
  assert.equal(getStatus('a7c'), 'pending');
  assert.equal(getStatus('nobody'), null);
  assert.equal(since(from, 'editMessageText').length, 0);
});

test('HOLD button: refused without touching the hash, and the card says so', async () => {
  const out = await sendProposal(emailAction('a8'));
  const from = calls.length;
  press('Ra8', { messageId: out.message_id });
  await waitFor(() => getStatus('a8') !== 'pending', 'decision on a8');
  assert.equal(getStatus('a8'), 'refused');
  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /^⛔ HELD · a8\n/);
  assert.match(edit.params.text, /Not released\. You chose to hold it\./);
});

test('the offset always advances, update by update: no press, malformed, throwing, or with a failed answer', async () => {
  const out = await sendProposal(emailAction('a9'));
  let from = calls.length;

  // 1 · any text message, alone in this batch
  const plain = say('hello');
  await waitOffset(from, plain.updateId + 1, 'offset after a message without a press');

  // 2 · a malformed press, alone
  from = calls.length;
  nextUpdateId += 1;
  const malformed = nextUpdateId;
  queue.push({ update_id: malformed, callback_query: { id: 'odd', from: null, message: null, data: 7 } });
  await waitOffset(from, malformed + 1, 'offset after a malformed update');

  // 3 · an update that throws inside handling (a getter that throws), alone
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
  const logs = await captureLogs(() => waitOffset(from, exploding + 1, 'offset after a throwing update'));
  assert.ok(logs.some((l) => /ignored after an error/.test(l)));
  assert.equal(getStatus('a9'), 'pending');

  // 4 · answerCallbackQuery fails on the network: the press is handled anyway
  from = calls.length;
  failAnswerFor.set('net-fail', new TypeError('fetch failed'));
  const failing = press('Aa9', { messageId: out.message_id, callbackId: 'net-fail' });
  await waitOffset(from, failing.updateId + 1, 'offset after a failed answer');
  assert.equal(getStatus('a9'), 'approved', 'the press is handled even if answerCallbackQuery fails');

  for (const c of since(from, 'getUpdates')) {
    assert.equal(c.params.timeout, 30);
    assert.ok(c.params.allowed_updates.includes('callback_query'));
    assert.ok(c.params.allowed_updates.includes('message'));
  }
});

test('409 on getUpdates: one deleteWebhook and retry; with the webhook already deleted it is not repeated', async () => {
  const from = calls.length;
  conflictsPending = 2; // two consecutive 409s
  await waitFor(() => since(from, 'deleteWebhook').length === 1, 'deleteWebhook');
  await waitFor(() => conflictsPending === 0, 'second 409 consumed');
  await waitFor(() => {
    const at = indexAfter(from, (c) => c.method === 'deleteWebhook');
    return since(at + 1, 'getUpdates').length >= 2;
  }, 'getUpdates after deleteWebhook', 5000);
  assert.equal(since(from, 'deleteWebhook').length, 1, 'a single deleteWebhook even though the 409 repeats');
});

test('stopping and restarting keeps the offset', async () => {
  const last = nextUpdateId; // last consumed update
  stop();
  await settle();
  const from = calls.length;
  stop = startPolling();
  await waitFor(() => since(from, 'getUpdates').length >= 1, 'getUpdates after restart');
  assert.equal(since(from, 'getUpdates')[0].params.offset, last + 1);
});

test('409 with deleteWebhook failing on the network: deleteWebhook is repeated on the next 409', async () => {
  const from = calls.length;
  failDeleteWebhookOnce = true;
  conflictsPending = 2;
  await waitFor(() => since(from, 'deleteWebhook').length === 2, 'second deleteWebhook', 5000);
  const deletes = calls.map((c, i) => (i >= from && c.method === 'deleteWebhook' ? i : -1)).filter((i) => i !== -1);
  const secondDelete = deletes[1];
  await waitFor(() => since(secondDelete + 1, 'getUpdates').length >= 1, 'getUpdates after the second deleteWebhook');
  assert.equal(conflictsPending, 0);
});

test('canonical that is not a string, invalid hash or invalid id: sendProposal refuses without serialising or calling Telegram', async () => {
  const from = calls.length;
  await assert.rejects(
    () => sendProposal(emailAction('a10', { canonical: { payload: {}, type: 'email' } })),
    /never serialises/,
  );
  await assert.rejects(() => sendProposal(emailAction('a11', { hash: 'nope' })), /SHA-256/);
  await assert.rejects(() => sendProposal(emailAction('a12', { id: '' })), /id/);
  await assert.rejects(() => sendProposal(emailAction('a12\n✅ APPROVED')), /id/);
  assert.equal(since(from, 'sendMessage').length, 0);
  assert.equal(getStatus('a10'), null);
});

test('callback_data: exactly 64 bytes pass, 65 bytes (multibyte included) are refused before sending', async () => {
  const from = calls.length;
  await assert.rejects(() => sendProposal(emailAction('x'.repeat(64))), /64/);
  await assert.rejects(() => sendProposal(emailAction('é'.repeat(32))), /64/); // 32 characters, 65 bytes with the verb
  assert.equal(since(from, 'sendMessage').length, 0);
  const out = await sendProposal(emailAction('x'.repeat(63)));
  assert.equal(out.status, 'pending');
  assert.equal(since(from, 'sendMessage').length, 1);
});

test('hold reasons in plain English: missing value (naming it), unknown, and never the raw code', async () => {
  const from = calls.length;
  await sendProposal(sealedAction('a13', '{"payload":{"body":"x","subject":null,"to":"david.whitmore@example.com"},"type":"email"}', { hold_reason: 'missing_required_parameter' }));
  await sendProposal(sealedAction('a14', '{"payload":{"description":"Something about the storage room"},"type":"unknown"}', { title: 'Something about the storage room', hold_reason: 'unknown_type' }));
  await sendProposal(sealedAction('a15', '{"payload":{"body":"x"},"type":"constructor"}', { hold_reason: 'constructor' }));
  const [missing, unknown, weird] = since(from, 'sendMessage');
  assert.match(missing.params.text, /Why this is held: A required value was not supplied in the meeting \(missing: subject\)/);
  assert.match(missing.params.text, /· subject: — missing/);
  assert.doesNotMatch(missing.params.text, /missing_required_parameter/);
  assert.match(unknown.params.text, /Why this is held: I do not know what this is/);
  assert.match(unknown.params.text, /Unknown action — /);
  assert.doesNotMatch(unknown.params.text, /unknown_type/);
  assert.match(weird.params.text, /Held for a person to review/);
  assert.match(weird.params.text, /Action — /);
  assert.doesNotMatch(weird.params.text, /function|native code/);
});

test('payload values cannot fake card sections (ASCII and Unicode line breaks) or split an emoji', async () => {
  const from = calls.length;
  const canonical =
    '{"payload":{"body":"line 1\\n✅ APPROVED · a16\\nSHA-256:\\n0000","subject":"a\\u2028✅ APPROVED\\u2029b\\u0085c","to":"a@example.com"},"type":"email"}';
  await sendProposal(sealedAction('a16', canonical, { title: `${'t'.repeat(198)}😀 end` }));
  const [sent] = since(from, 'sendMessage');
  assert.ok(!sent.params.text.includes('\n✅ APPROVED'), 'the line break inside the value is flattened');
  assert.match(sent.params.text, /line 1 ⏎ ✅ APPROVED/);
  assert.match(sent.params.text, /a ⏎ ✅ APPROVED ⏎ b ⏎ c/);
  assert.doesNotMatch(sent.params.text, /[\u0085\u2028\u2029]/, 'no Unicode separators on the card');
  assert.doesNotMatch(sent.params.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone surrogates');
  assert.doesNotMatch(sent.params.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogates');
});

test('nested values are shown field by field, never as [object Object]', async () => {
  const from = calls.length;
  const canonical = '{"payload":{"attendees":[{"email":"a@x.com"},{"email":"b@x.com"}],"title":"Call","when":{"end":"13:00","start":"12:00"}},"type":"calendar_event"}';
  await sendProposal(sealedAction('a17', canonical));
  const [sent] = since(from, 'sendMessage');
  assert.match(sent.params.text, /· attendees\[0\]\.email: a@x\.com/);
  assert.match(sent.params.text, /· attendees\[1\]\.email: b@x\.com/);
  assert.match(sent.params.text, /· when\.start: 12:00/);
  assert.match(sent.params.text, /· title: Call/);
  assert.match(sent.params.text, /Calendar event — /);
  assert.doesNotMatch(sent.params.text, /\[object Object\]/);
});

test('a value that does not fit in Telegram is truncated out loud, and the hash is never cut', async () => {
  const from = calls.length;
  const long = 'L'.repeat(6000);
  const canonical = `{"payload":{"body":"${long}","subject":"s","to":"a@example.com"},"type":"email"}`;
  await sendProposal(sealedAction('a18', canonical));
  const [sent] = since(from, 'sendMessage');
  assert.ok(sent.params.text.length <= 4096, `fits in Telegram (${sent.params.text.length})`);
  assert.match(sent.params.text, /Truncated to fit Telegram: \d+ characters not shown\. The SHA-256 seal covers the full content\./);
  assert.ok(sent.params.text.endsWith(sha256(canonical)), 'the hash closes the card intact');
});

test('/tamper from the configured chat forces the refusal; from another user it is ignored; an unknown id is answered', async () => {
  const out = await sendProposal(emailAction('a19'));
  press('Aa19', { messageId: out.message_id });
  await waitFor(() => getStatus('a19') === 'approved', 'a19 approved');

  let from = calls.length;
  const stranger = say('/tamper a19', { fromId: 42 });
  await waitOffset(from, stranger.updateId + 1, "stranger's command consumed");
  assert.equal(getStatus('a19'), 'approved', 'a stranger cannot tamper');

  from = calls.length;
  say('/tamper a19');
  await waitFor(() => getStatus('a19') === 'refused', 'a19 rejected by /tamper');
  const [edit] = since(from, 'editMessageText');
  assert.match(edit.params.text, /REJECTED/);
  assert.ok(edit.params.text.includes(HASH));
  assert.ok(/Actual hash \(recomputed\):\n[0-9a-f]{64}/.test(edit.params.text));

  // bare "/tamper" acts on the last decided proposal
  const out2 = await sendProposal(emailAction('a19b'));
  press('Aa19b', { messageId: out2.message_id });
  await waitFor(() => getStatus('a19b') === 'approved', 'a19b approved');
  say('/tamper@afterword_bot');
  await waitFor(() => getStatus('a19b') === 'refused', 'a19b rejected by bare /tamper');

  // unknown id: answered in the chat, does not blow up
  from = calls.length;
  const unknown = say('/tamper zzz');
  await waitOffset(from, unknown.updateId + 1, 'command with unknown id consumed');
  const [replyMsg] = since(from, 'sendMessage');
  assert.match(replyMsg.params.text, /No proposal named "zzz"\./);
});

test('the token never reaches the console, not even inside a network exception', async () => {
  const out = await sendProposal(emailAction('a20'));
  const from = calls.length;
  failAnswerFor.set('leak', new TypeError(`request to https://api.telegram.org/bot${TOKEN}/answerCallbackQuery failed, reason: ECONNRESET`));
  const logs = await captureLogs(async () => {
    press('Aa20', { messageId: out.message_id, callbackId: 'leak' });
    await waitFor(() => getStatus('a20') !== 'pending', 'decision on a20');
  });
  assert.equal(getStatus('a20'), 'approved');
  assert.ok(logs.some((l) => /answerCallbackQuery failed/.test(l)));
  assert.ok(!logs.some((l) => l.includes(TOKEN)), 'the token does not appear');
  assert.ok(!logs.some((l) => l.includes('api.telegram.org')), 'the URL does not appear');
  assert.equal(since(from, 'sendMessage').length, 0);
});

test('getStatus of an unknown id is null', () => {
  assert.equal(getStatus('never'), null);
});
