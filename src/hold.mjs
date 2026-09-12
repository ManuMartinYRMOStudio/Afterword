// src/hold.mjs — AfterWord's Telegram hold.
//
// A held action (auto_execute: false) arrives from the engine with two fields
// already computed: `canonical`, the canonical JSON string over type + payload,
// and `hash`, its SHA-256. This module stores that string EXACTLY AS IT ARRIVED,
// shows it in Telegram with two buttons and, on approval, re-hashes THAT SAME
// stored string. Match → APPROVED. Mismatch → REJECTED, with both hashes.
//
// What is shown and what is sealed are the same bytes: the card is rendered by
// READING the stored canonical string (JSON.parse, read-only), never from the
// `payload` object. If a value does not fit in Telegram, the card says so and
// reminds that the seal covers the full content.
//
// Non-negotiable rules (00-BRIEF-AGENTES.md §4, §6 and §7):
//   · NEVER serialises. No JSON.stringify over `canonical` or over the action
//     in the verification path. JSON.stringify appears exactly once, to encode
//     the body of requests to the Telegram API.
//   · answerCallbackQuery goes first, before touching state or editing anything.
//   · The getUpdates offset is ALWAYS advanced, also on ignored or failing
//     updates. timeout=30. On a 409, one deleteWebhook and retry.
//   · callback_data = one-letter verb + id, within the 64-byte cap.
//   · A press is accepted only if chat_id AND from.id both equal TG_CHAT.
//   · The hold reason is shown in plain English, never the raw code.
//
// To force the refusal on camera without touching the bridge: type
// "/tamper a4" in the bot chat (or bare "/tamper", which alters the last
// decided proposal). Only the configured chat is accepted.
//
// The console never prints the token, the chat, the canonical string or
// unfiltered exceptions: that terminal is on camera.
//
// Importing this module has no side effects: nothing reads .env, nothing opens
// the network and nothing starts until sendProposal() or startPolling() is called.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TELEGRAM_API = 'https://api.telegram.org';
const CALLBACK_DATA_MAX_BYTES = 64; // Telegram's cap: 1–64 bytes
const LONG_POLL_TIMEOUT_S = 30;
const LONG_POLL_ABORT_MS = (LONG_POLL_TIMEOUT_S + 15) * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const CONFLICT_DELAY_MS = 3_000;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 4_000; // Telegram cuts at 4096
const TAMPER_COMMAND = '/tamper';

// The engine's code never reaches the screen: it is translated here.
const HOLD_REASON_TEXT = {
  irreversible_type: 'This cannot be undone',
  unknown_type: 'I do not know what this is',
  missing_required_parameter: 'A required value was not supplied in the meeting',
};
const HOLD_REASON_FALLBACK = 'Held for a person to review';

const TYPE_LABEL = {
  email: 'Email',
  listing_publish: 'Listing publication',
  calendar_event: 'Calendar event',
  task: 'Task',
  note: 'Note',
  unknown: 'Unknown action',
};

/**
 * @typedef {object} Proposal
 * @property {string} id
 * @property {string} canonical   The string exactly as it arrived from the engine. Never rebuilt.
 * @property {string} hash        The SHA-256 that arrived with it.
 * @property {object} action      The full action: title, summary and reason (presentation metadata).
 * @property {{type:string, payload:object}} sealed   Read from the canonical string: what gets rendered.
 * @property {'pending'|'approved'|'refused'} status
 * @property {number|null} message_id   Telegram message that showed the card.
 * @property {string|number|null} chat_id
 * @property {{ok:boolean, expected:string, actual:string}|null} check
 * @property {'approved'|'retained'|'mismatch'|'tampered'|null} decision
 */

/** @type {Map<string, Proposal>} */
const proposals = new Map();
let env = null;
let poller = null;
let lastOffset = 0; // survives stop()/startPolling() within the same process
let lastProposedId = null;
let lastDecidedId = null;

const log = (...parts) => console.log('[hold]', ...parts);
const sameId = (a, b) => a !== undefined && a !== null && String(a) === String(b);
const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/** Error summary fit for a console that is on camera: no token, no URL, bounded. */
function describeError(err) {
  let text = `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
  if (env?.token) text = text.split(env.token).join('<token>');
  text = text.replace(/https?:\/\/\S+/g, '<url>');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Waits `ms`, or less if the signal aborts (so stop() leaves no waits hanging). */
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
// .env — read the first time it is needed, never on import.
// ---------------------------------------------------------------------------

function loadEnv() {
  if (env) return env;
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) {
    const candidates = [resolve(ROOT, '.env'), resolve(process.cwd(), '.env')];
    const file = candidates.find((path) => existsSync(path));
    if (!file) {
      throw new Error(
        `Missing .env file (looked in ${candidates[0]}). ` +
          'Copy .env.example to .env and fill in TG_TOKEN and TG_CHAT.',
      );
    }
    try {
      process.loadEnvFile(file); // does not override variables already in the environment
    } catch (err) {
      throw new Error(`Could not read ${file}: ${err?.message ?? err}`);
    }
  }
  const token = String(process.env.TG_TOKEN ?? '').trim();
  const chat = String(process.env.TG_CHAT ?? '').trim();
  if (!token) throw new Error('TG_TOKEN is empty (in .env or in the process environment): it is the bot token from @BotFather.');
  if (!chat) throw new Error('TG_CHAT is empty (in .env or in the process environment): it is the id of the private chat that approves.');
  if (chat.startsWith('-')) {
    log('warning: TG_CHAT looks like a group. The rule requires a private chat (chat_id and from.id equal to TG_CHAT); in a group no press will be accepted.');
  }
  env = { token, chat };
  return env;
}

// ---------------------------------------------------------------------------
// Telegram — one function talks to the API. The token is never printed.
// ---------------------------------------------------------------------------

async function tgRequest(method, params = {}, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) {
  const { token } = loadEnv();
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params), // the request body; `canonical` never travels here
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
    throw new Error(`Telegram ${method} → HTTP ${status}: ${body?.description ?? 'invalid response'}`);
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// The hash binding. This is the project's thesis and it is four lines.
// ---------------------------------------------------------------------------

/**
 * Re-hashes the stored string, exactly as it arrived, and compares it with the
 * hash that arrived with it. Nothing is rebuilt or re-serialised.
 */
function verify(proposal) {
  const actual = createHash('sha256').update(proposal.canonical, 'utf8').digest('hex');
  const expected = proposal.hash;
  return { ok: actual === expected.toLowerCase(), expected, actual };
}

/**
 * Reads type + payload FROM the canonical string. It is only parsed to render
 * the card; the hash is still computed over the stored string. Returns null if
 * the string does not describe {type, payload}: then there is nothing to show
 * and the proposal is refused before any card is sent.
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

/** Informational comparison between what the object carries and what the string binds. */
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
// Card text, in plain English.
// ---------------------------------------------------------------------------

/** Cuts without splitting a surrogate pair (half an emoji would make sendMessage fail). */
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

/** One line only: no line break (ASCII or Unicode) can fake a section of the card. */
function oneLine(value) {
  return String(value).replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, ' ⏎ ');
}

function describe(proposal) {
  const label = lookup(TYPE_LABEL, proposal.sealed.type) ?? 'Action';
  const title = proposal.action?.title ?? proposal.sealed.type;
  return `${label} — ${clip(oneLine(title), MAX_TITLE_CHARS)}`;
}

function holdReasonText(action, sealedPayload) {
  const base = lookup(HOLD_REASON_TEXT, action?.hold_reason) ?? HOLD_REASON_FALLBACK;
  if (action?.hold_reason === 'missing_required_parameter') {
    const missing = Object.entries(sealedPayload)
      .filter(([, value]) => value === null || value === undefined)
      .map(([key]) => oneLine(key));
    if (missing.length) return `${base} (missing: ${missing.join(', ')})`;
  }
  return base;
}

/** Flattens nested values into [path, value] pairs so nothing is left as "[object Object]". */
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

/** Values are shown in full, read from the sealed string. */
function payloadLines(sealedPayload) {
  const pairs = [];
  for (const [key, value] of Object.entries(sealedPayload)) flatten(key, value, pairs);
  if (!pairs.length) return ['· (no data)'];
  return pairs.map(([path, value]) => (value === null ? `· ${oneLine(path)}: — missing` : `· ${oneLine(path)}: ${oneLine(value)}`));
}

/**
 * Joins head, body and tail. If the body does not fit in Telegram it is cut and
 * the card says so out loud: nothing is silently approved that was not seen.
 * The hash lives in the tail and is never cut.
 */
function assemble(head, middle, tail) {
  const headText = head.join('\n');
  const tailText = tail.join('\n');
  let middleText = middle.join('\n');
  const budget = Math.max(MAX_TEXT_CHARS - headText.length - tailText.length - 2, 80);
  if (middleText.length > budget) {
    const note = (hidden) =>
      `\n⚠️ Truncated to fit Telegram: ${hidden} characters not shown. The SHA-256 seal covers the full content.`;
    const kept = Math.max(budget - note(middleText.length).length - 1, 0);
    const shown = cutAt(middleText, kept);
    middleText = `${shown}…${note(middleText.length - shown.length)}`;
  }
  return middleText ? `${headText}\n${middleText}\n${tailText}` : `${headText}\n${tailText}`;
}

function cardText(proposal) {
  const head = [`🔒 HELD · ${oneLine(proposal.id)}`, describe(proposal)];
  if (proposal.action?.summary) head.push(clip(oneLine(proposal.action.summary), MAX_TITLE_CHARS));
  const middle = [
    '',
    `Why this is held: ${holdReasonText(proposal.action, proposal.sealed.payload)}`,
    '',
    'What would happen if approved (read from sealed bytes):',
    ...payloadLines(proposal.sealed.payload),
  ];
  const tail = ['', 'SHA-256 of what you approve:', proposal.hash];
  return assemble(head, middle, tail);
}

function decidedText(proposal) {
  const id = oneLine(proposal.id);
  const head = [];
  const tail = [];
  if (proposal.status === 'approved') {
    head.push(`✅ APPROVED · ${id}`, describe(proposal));
    tail.push('', 'Released: what was approved is exactly what was shown.', 'SHA-256:', proposal.check.expected);
  } else if (proposal.decision === 'retained') {
    head.push(`⛔ HELD · ${id}`, describe(proposal));
    tail.push('', 'Not released. You chose to hold it.');
  } else {
    head.push(`⛔ REJECTED · ${id}`, describe(proposal));
    tail.push(
      '',
      'What would run is no longer what was shown. Not released.',
      'Expected hash (shown):',
      proposal.check.expected,
      'Actual hash (recomputed):',
      proposal.check.actual,
    );
  }
  return assemble(head, [], tail);
}

/** Edits the card with the verdict. Without reply_markup the buttons disappear. */
async function editCard(proposal) {
  if (proposal.message_id === null || proposal.message_id === undefined) {
    log(`${proposal.id}: no card to edit (the Telegram send did not complete)`);
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
    log(`could not edit card ${proposal.id}: ${describeError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Public API — exactly four things.
// ---------------------------------------------------------------------------

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new TypeError('sendProposal: expected the resolved action emitted by the engine');
  }
  const { id, canonical, hash } = action;
  if (typeof id !== 'string' || id === '' || !/^[^\s\p{C}]+$/u.test(id)) {
    throw new TypeError('sendProposal: the action has no valid `id` (no whitespace or control characters); without an id there is no approve button');
  }
  if (typeof canonical !== 'string' || canonical === '') {
    throw new TypeError(
      `sendProposal(${id}): \`canonical\` must arrive as a string from the engine. ` +
        'The bridge never serialises: it is not rebuilt from the object.',
    );
  }
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new TypeError(`sendProposal(${id}): \`hash\` must be the hexadecimal SHA-256 (64 characters) of \`canonical\``);
  }
  const sealed = readSealed(canonical);
  if (!sealed) {
    throw new TypeError(
      `sendProposal(${id}): the canonical string does not describe {type, payload}; what would be sealed cannot be shown, so no card is sent`,
    );
  }
  return { id, canonical, hash, sealed };
}

/**
 * Stores {id, canonical, hash, status:'pending'} with the string exactly as it
 * arrived and sends the card to Telegram with the APPROVE and HOLD buttons. The
 * card is rendered by reading the canonical string: what is shown and what is
 * sealed are the same bytes.
 *
 * If Telegram fails, the proposal stays stored as `pending` without a card and
 * the error propagates so the bridge sees it. If the id already existed, the
 * new proposal replaces the previous one and the old card no longer counts
 * (every press is bound to the message_id of the card that showed those bytes).
 *
 * @param {object} action  Resolved action from the engine (with `canonical` and `hash`).
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
        `sendProposal(${id}): callback_data of ${bytes} bytes exceeds the ${CALLBACK_DATA_MAX_BYTES}-byte cap; ` +
          'Telegram would reject the whole message, not the button',
      );
    }
  }

  if (proposals.has(id)) {
    log(`proposal ${id} replaced by a new one; the previous card no longer counts`);
  }

  /** @type {Proposal} */
  const proposal = {
    id,
    canonical, // exactly as it arrived
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
    log(`warning ${id}: the received hash is not the SHA-256 of the received canonical string; approval will be rejected`);
    log(`  received hash:   ${early.expected}`);
    log(`  recomputed hash: ${early.actual}`);
  }
  const mismatch = sealedMismatch(sealed, action);
  if (mismatch) {
    log(`warning ${id}: the action object and the canonical string differ at ${mismatch}. The card shows the sealed string, which is what you approve.`);
  }

  const sent = await tg('sendMessage', {
    chat_id: chat,
    text: cardText(proposal),
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ APPROVE', callback_data: approveData },
          { text: '⛔ HOLD', callback_data: retainData },
        ],
      ],
    },
  });
  proposal.message_id = sent?.message_id ?? null;
  proposal.chat_id = sent?.chat?.id ?? chat;
  log(`card ${id} sent (message ${proposal.message_id})`);

  return { id, status: proposal.status, hash, message_id: proposal.message_id };
}

/**
 * Status of a proposal. `null` if that id was never proposed.
 * @param {string} id
 * @returns {'pending'|'approved'|'refused'|null}
 */
export function getStatus(id) {
  const proposal = proposals.get(id);
  return proposal ? proposal.status : null;
}

/** Text command "/tamper [id]" from the configured chat: forces the refusal on camera. */
async function handleCommand(message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const [word, ...rest] = text.split(/\s+/);
  if (!word || word.split('@')[0] !== TAMPER_COMMAND) return; // any other message is ignored

  const { chat } = loadEnv();
  if (!sameId(message.chat?.id, chat) || !sameId(message.from?.id, chat)) {
    log('command rejected: chat or user not authorised');
    return;
  }
  const wanted = rest[0] ?? '';
  const id = wanted || lastDecidedId || lastProposedId;
  if (!id || !proposals.has(id)) {
    log(`command ${TAMPER_COMMAND}: no proposal to tamper with`);
    try {
      await tg('sendMessage', {
        chat_id: chat,
        text: wanted ? `No proposal named "${clip(oneLine(wanted), 40)}".` : 'There is no proposal to tamper with yet.',
      });
    } catch (err) {
      log(`could not answer the command: ${describeError(err)}`);
    }
    return;
  }
  await tamperTest(id);
}

/**
 * Handles one getUpdates update. By the time it gets here, the offset is already advanced.
 */
async function handleUpdate(update) {
  const press = update?.callback_query;
  if (!press) {
    if (update?.message) await handleCommand(update.message);
    return; // not a press: ignored
  }

  // 1 · FIRST: answer, so the button stops spinning. No state has been touched
  //     and nothing has been edited yet.
  try {
    await tg('answerCallbackQuery', { callback_query_id: press.id });
  } catch (err) {
    log(`answerCallbackQuery failed (${describeError(err)}); the press is handled anyway`);
  }

  // 2 · Only the configured chat decides: chat_id AND from.id equal to TG_CHAT.
  const { chat } = loadEnv();
  if (!sameId(press.message?.chat?.id, chat) || !sameId(press.from?.id, chat)) {
    log('press rejected: chat or user not authorised');
    return;
  }

  // 3 · One-letter verb + id.
  const data = typeof press.data === 'string' ? press.data : '';
  const verb = data.slice(0, 1);
  const id = data.slice(1);
  if ((verb !== 'A' && verb !== 'R') || !id) {
    log('press ignored: unrecognised callback_data');
    return;
  }

  const proposal = proposals.get(id);
  if (!proposal) {
    log(`press ignored: unknown proposal ${clip(oneLine(id), 40)}`);
    return;
  }
  // The press must come from the card that showed these bytes.
  if (proposal.message_id === null || !sameId(press.message?.message_id, proposal.message_id)) {
    log(`press ignored: stale card for ${id}`);
    return;
  }
  if (proposal.status !== 'pending') {
    log(`press ignored: ${id} is already ${proposal.status}`);
    return;
  }

  if (verb === 'R') {
    proposal.status = 'refused';
    proposal.decision = 'retained';
    lastDecidedId = id;
    log(`${id}: HELD by the person`);
    await editCard(proposal);
    return;
  }

  // 4 · Approve. The only thing that releases is the hash of the stored string.
  const check = verify(proposal);
  proposal.check = check;
  proposal.status = check.ok ? 'approved' : 'refused';
  proposal.decision = check.ok ? 'approved' : 'mismatch';
  lastDecidedId = id;
  if (check.ok) {
    log(`${id}: APPROVED (sha256 ${check.actual})`);
  } else {
    log(`${id}: REJECTED — the bytes do not match`);
    log(`  expected hash (shown): ${check.expected}`);
    log(`  actual hash (recomputed): ${check.actual}`);
  }
  await editCard(proposal);
}

async function pollLoop(state) {
  let webhookCleared = false; // a deleteWebhook that reached Telegram since the last 409
  log(`polling started (getUpdates, timeout=${LONG_POLL_TIMEOUT_S}s, offset=${lastOffset})`);

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
      log(`getUpdates failed (${describeError(err)}); retrying in ${RETRY_DELAY_MS} ms`);
      await sleep(RETRY_DELAY_MS, signal);
      continue;
    }
    if (!state.running) break;

    if (res.status === 409) {
      if (!webhookCleared) {
        // One deleteWebhook and retry. If the call did not get through, it is repeated on the next 409.
        log('getUpdates returned 409 (a webhook was active): deleteWebhook and retry');
        try {
          await tg('deleteWebhook', { drop_pending_updates: false });
          webhookCleared = true;
        } catch (err) {
          log(`deleteWebhook failed (${describeError(err)}); it will be repeated if the 409 persists`);
          await sleep(RETRY_DELAY_MS, signal);
        }
      } else {
        log(`getUpdates still returns 409 after deleting the webhook: another process is polling with this token. Retrying in ${CONFLICT_DELAY_MS} ms`);
        await sleep(CONFLICT_DELAY_MS, signal);
      }
      continue;
    }
    webhookCleared = false; // any non-409 response re-arms the deleteWebhook

    if (!res.body || res.body.ok !== true || !Array.isArray(res.body.result)) {
      log(`getUpdates → HTTP ${res.status}: ${clip(oneLine(res.body?.description ?? 'invalid response'), 120)}; retrying in ${RETRY_DELAY_MS} ms`);
      await sleep(RETRY_DELAY_MS, signal);
      continue;
    }

    for (const update of res.body.result) {
      // The offset is ALWAYS advanced, before handling the update and whatever happens next.
      if (Number.isInteger(update?.update_id)) lastOffset = update.update_id + 1;
      try {
        await handleUpdate(update);
      } catch (err) {
        log(`update ${update?.update_id ?? '?'} ignored after an error: ${describeError(err)}`);
      }
    }
  }
  log('polling stopped');
}

/**
 * Starts the getUpdates loop (long polling, timeout=30). Returns the function
 * that stops it. Calling it twice returns the same stop.
 * @returns {() => void}
 */
export function startPolling() {
  if (poller) return poller.stop;
  loadEnv(); // if .env is missing, fail here with a clear message
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

/** Changes a single character of the value of `key` inside the string, by text surgery. */
function alterOneCharacter(text, key) {
  const marker = `"${key}":"`;
  const at = text.indexOf(marker);
  let index = at >= 0 ? at + marker.length : -1;
  let where = key;
  if (index < 0 || index >= text.length) {
    const first = text.indexOf('":"'); // the first string value there is
    index = first >= 0 ? first + 3 : -1;
    where = 'the first value';
  }
  if (index < 0 || index >= text.length) {
    index = Math.floor(text.length / 2);
    where = 'the string';
  }
  const original = text[index];
  const replacement = original === 'x' ? 'y' : 'x';
  return { altered: `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`, where };
}

/**
 * Alters one character of the recipient INSIDE the stored canonical string and
 * repeats the check through the same path as a real approval. The string is no
 * longer what was shown, so the result is REJECTED and the card is edited to
 * show both hashes.
 *
 * Can also be triggered from the chat with "/tamper [id]".
 *
 * @param {string} id
 * @returns {Promise<{id:string, status:'approved'|'refused', expected:string, actual:string, before:string, after:string}>}
 */
export async function tamperTest(id) {
  const proposal = proposals.get(id);
  if (!proposal) throw new Error(`tamperTest(${id}): no proposal with that id`);

  const before = proposal.canonical;
  const { altered: after, where } = alterOneCharacter(before, 'to');
  proposal.canonical = after; // THE STORED STRING is altered, which is what gets re-hashed

  const check = verify(proposal);
  proposal.check = check;
  proposal.status = check.ok ? 'approved' : 'refused';
  proposal.decision = check.ok ? 'approved' : 'tampered';
  lastDecidedId = id;

  log(`tamperTest(${id}): one character altered in ${where === 'to' ? 'the recipient' : where} of the stored string`);
  log(`  expected hash (shown): ${check.expected}`);
  log(`  actual hash (recomputed): ${check.actual}`);
  log(`  result: ${proposal.status === 'refused' ? 'REJECTED' : 'APPROVED (should not happen)'}`);

  await editCard(proposal);
  return { id, status: proposal.status, expected: check.expected, actual: check.actual, before, after };
}
