# AfterWord

AfterWord takes the transcript of a meeting and turns it into typed actions: calendar events,
tasks, notes, emails and listing publications. Reversible actions go through without asking;
irreversible, unrecognised or incomplete ones are held and sent to one person's phone as a
Telegram card with two buttons. A human approval releases exactly the bytes that were shown,
bound by a SHA-256 hash, and nothing else.

## The thesis

The model predicts the action and its type. It never decides whether an action may run.
Deterministic code maps the type to an execution policy: `calendar_event`, `task` and `note`
are reversible and auto-execute; `email` and `listing_publish` are irreversible and always
held; `unknown` fails closed down the same path; a required value the meeting never supplied
arrives as `null` and forces a hold of its own. A misclassification changes which policy
applies. It never changes what a policy permits.

That derivation happens in the extraction engine, which returns every action with
`auto_execute` and `hold_reason` already set. Nothing in this repository recomputes them:
`src/bridge.mjs` reads only the `auto_execute` boolean (`processTranscript()`), and
`src/hold.mjs` translates `hold_reason` into plain language for the card (`HOLD_REASON_TEXT`).
Confidence plays no part in the stop: an email at confidence 1.0 is held, a task at 0.3 runs.

## The hash rule

Approval proves that a human said yes. The hash proves that what they said yes to is what runs.

For every action the engine emits a canonical JSON string covering `type` and `payload`
together, plus its SHA-256. The approval layer never re-serialises that string. It stores the
bytes as they arrived and re-hashes those same bytes when the human approves. Two
implementations of "canonical" in two languages agree in tests and disagree on real data;
SHA-256 over identical bytes is identical everywhere.

Where this happens:

- `src/bridge.mjs`, `extract()` and `processTranscript()`: the `POST /extract` response is
  written to `web/actions.json` as received, and each action with `auto_execute: false` is
  handed to `sendProposal()`. The bridge neither canonicalises nor hashes anything.
- `src/hold.mjs`, `sendProposal()`: stores `{ id, canonical, hash, status: 'pending' }` with
  `canonical` exactly as it arrived, and refuses an action whose `canonical` is not a string.
- `src/hold.mjs`, `verify()`: `createHash('sha256').update(proposal.canonical, 'utf8')`,
  compared with the stored `hash`. Four lines. The only `JSON.stringify` in the file encodes
  Telegram request bodies.
- `src/hold.mjs`, `handleUpdate()`: on Approve, `answerCallbackQuery` goes first, then
  `verify()`. Match: status `approved` and the card is edited to APROBADO. Mismatch: status
  `refused` and the card is edited to RECHAZADO showing both hashes (`decidedText()`).
- `src/hold.mjs`, `readSealed()`: the card is rendered by parsing the stored canonical string,
  never from the `payload` object, so what is shown and what is sealed are the same bytes.
  Parsing is read-only; hashing still uses the raw string.
- `src/hold.mjs`, `tamperTest()`: changes one character of the recipient inside the stored
  string and runs the same `verify()`. This is the refusal shown on camera.

Because `type` is inside the hashed bytes, approving a note body and executing it as an email
body is refused too. The hash is an approval-integrity check, not an idempotency key: two
meetings can legitimately produce the same action.

Only presses whose `chat_id` and `from.id` both equal `TG_CHAT` are accepted, and only from
the message that showed the card. Anything else is answered so the button stops spinning, then
ignored.

## How to run it

Prerequisites: Node 22 or newer. There are no dependencies and no `package.json`, so there is
nothing to install; `fetch`, `node:crypto`, `process.loadEnvFile` and `util.parseEnv` are
built in. You need a Telegram bot token from BotFather and the private chat id of the person
who approves. That person must have opened the bot and pressed Start, or Telegram answers 403.

1. Configuration.

       cp .env.example .env

   `TG_TOKEN` and `TG_CHAT` are needed by everything below. `ENGINE_URL` and `PRINCIPAL` are
   needed by the bridge. `TRANSCRIPT_PATH` is optional and defaults to `web/sample.txt`.
   `.env` is ignored by git (see `.gitignore`); only `.env.example` is committed.

2. Preflight.

       node scripts/preflight.mjs

   Seven checks: the `.env` keys, Telegram `getMe`, Telegram `getChat`, `ENGINE_URL`
   reachability, port 8080 free, `web/actions.json` well formed, and both modules present.
   Output is in Spanish; the exit code is 0 only when all seven pass. For the demo in the
   next step only the first three matter.

3. The fastest way to see the hold work, with nothing else running.

       node src/demo.mjs

   Sends one fixed card, the demo email, to `TG_CHAT`. Press Aprobar on the phone and the card
   is edited in place to APROBADO. Then press Enter in the terminal, or type `/tamper a4` in
   the bot chat: the card is edited to RECHAZADO with both hashes, and the terminal prints
   them too. Retener ends the run without releasing anything.

4. The whole path.

       node src/bridge.mjs

   Reads the transcript, posts `{ transcript, principal }` to `ENGINE_URL` (six attempts, two
   seconds apart), writes `web/actions.json` as `{ transcript, actions }`, logs `[executed]`
   for every auto-execute action, sends every held action to Telegram, and serves `web/` on
   `http://127.0.0.1:8080` with `GET /api/status/:id` returning `pending`, `approved` or
   `refused` (404 for an unknown id). Console commands: `tamper <id>`, `list`, `quit`. If the
   engine does not answer, the server stays up and `web/actions.json` can be written by hand.
   The engine and the page under `web/` are separate deliverables and are not in this
   repository.

5. Tests.

       node --test src/hold.test.mjs

   27 tests against a fake Telegram, no network and no real `.env`: a clean string verifies,
   one altered character is refused with both hashes, a canonical string that is not its own
   JavaScript re-serialisation still verifies, presses from any other chat or user are
   ignored, and the `getUpdates` offset advances on every update, including ones that fail.

## One limitation, stated plainly

Approving an email does not send an email. No email provider is wired and none will be added.
In this repository the bridge marks auto-execute actions with `[executed]` in the console and
does nothing else, and approving a held action grants or refuses release and nothing else.
What is demonstrated is that release is granted or refused, bound to the exact bytes a human
saw.

## Credits

- Manu Martín: repository, the Node bridge, the Telegram hold, the hash verification and
  deployment.
- Aarón Nuñez Tejado: the two-column page that reads `web/actions.json`, and the video.
  Delivered separately; not in this repository.
- Tomer Messinger Carmeli: the extraction engine, a separate Python service on Google Cloud Run
  that answers `POST /extract` with resolved actions, each carrying `canonical` and `hash`.
  Not in this repository.

Built on 12 September 2026 at the AI Tinkerers "Agents, Everywhere" hackathon in Valencia.
