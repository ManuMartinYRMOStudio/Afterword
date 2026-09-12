// src/demo.mjs — the hold, rehearsed on camera. No engine, no bridge, no web.
//
//   cd /Users/yrmostudio/afterword && node src/demo.mjs
//
// 1. Sends ONE fixed card (the demo's email) to the TG_CHAT chat.
// 2. On the phone: ✅ APPROVE → the card is edited in place to APPROVED.
// 3. To force the refusal: ENTER in this terminal, or "/tamper a4" in the chat.
//    The card turns into REJECTED with both hashes, and the console shows them.
//
// Reads TG_TOKEN and TG_CHAT from the .env at the repository root, through hold.mjs.

import { createHash } from 'node:crypto';
import { sendProposal, getStatus, startPolling, tamperTest } from './hold.mjs';

const ID = 'a4';

// The canonical string is written literally, as the engine would emit it, and
// its hash was computed once from it. Both are checked at startup.
const CANONICAL =
  '{"payload":{"body":"3% + VAT, 90 days exclusive, asking price approx. €329,000","subject":"Listing agreement — Ruzafa","to":"david.whitmore@example.com"},"type":"email"}';
const HASH = 'd5ccca115a92dfaa5da6418f91ad8c6b7dcd6c335e4221c96b33c60e90450ae2';

const ACTION = {
  id: ID,
  type: 'email',
  title: 'Send listing agreement to David Whitmore',
  summary: '3% + VAT, 90 days exclusive, approx. €329,000',
  payload: {
    to: 'david.whitmore@example.com',
    subject: 'Listing agreement — Ruzafa',
    body: '3% + VAT, 90 days exclusive, asking price approx. €329,000',
  },
  action_evidence: ['L03'],
  action_support: 'explicit',
  support: 'weak',
  confidence: 0.3,
  auto_execute: false,
  hold_reason: 'irreversible_type',
  canonical: CANONICAL,
  hash: HASH,
};

const say = (...parts) => console.log('[demo]', ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (createHash('sha256').update(CANONICAL, 'utf8').digest('hex') !== HASH) {
  console.error('[demo] The literal string and its hash do not match: nothing is sent. Check CANONICAL and HASH.');
  process.exit(1);
}

let stop = null;
const bye = (code) => {
  stop?.();
  process.exit(code);
};
process.on('SIGINT', () => {
  say('interrupted.');
  bye(130);
});

try {
  stop = startPolling(); // before sending the card, so the press is not missed
  await sendProposal(ACTION);
} catch (err) {
  console.error('[demo]', err?.message ?? err);
  if (/403/.test(String(err?.message))) {
    console.error('[demo] A bot cannot message someone who has never messaged it: open the bot chat on the phone and press Start.');
  }
  bye(1);
}

say('Card sent. On the phone: press ✅ APPROVE (or ⛔ HOLD).');

let status = 'pending';
while (status === 'pending') {
  await sleep(400);
  status = getStatus(ID);
}

if (status === 'refused') {
  say('Held from the phone. Done.');
  bye(0);
}

say('APPROVED on the phone: the card has been edited in place.');
say('To force the refusal: press ENTER here, or type /tamper a4 in the bot chat.');

const fromKeyboard = new Promise((resolve) => {
  if (!process.stdin.isTTY) return; // without a terminal, only the chat command works
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.once('data', () => resolve('keyboard'));
});
const fromChat = (async () => {
  while (getStatus(ID) === 'approved') await sleep(400);
  return 'chat';
})();

const who = await Promise.race([fromKeyboard, fromChat]);
if (who === 'keyboard') {
  await tamperTest(ID);
} else {
  say('Refusal forced from the chat.');
}
say(`Final status of ${ID}: ${getStatus(ID)}. Both hashes are on the card on the phone and in this console. Done.`);
bye(0);
