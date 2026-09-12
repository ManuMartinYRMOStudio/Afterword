# AfterWord

AfterWord takes the transcript of a meeting and turns it into typed actions: calendar events, tasks,
notes, emails and listing publications. Reversible actions go through without asking; irreversible,
unrecognised or incomplete ones are held and sent to one person's phone as a Telegram card with two
buttons. A human approval releases exactly the bytes that were shown, bound by a SHA-256 hash, and
nothing else.

## What is in the repository

| Path | What it is |
|---|---|
| `web/` | The two-pane page: `index.html`, `app.js`, `styles.css`, `transcript.json` (the demo meeting, turns `L01` to `L14`) and `actions.json` (the five actions the page shows). |
| `src/hold.mjs` | The Telegram hold: cards, long polling, the hash check, `tamperTest()`. Tests in `src/hold.test.mjs`. |
| `src/bridge.mjs` | The Node bridge: calls the engine, writes `web/actions.json`, sends held actions to Telegram, serves `web/` and `GET /api/status/:id`. Tests in `src/bridge.test.mjs`. |
| `src/demo.mjs` | One fixed card to Telegram, with no engine, no bridge and no web. |
| `services/extractor/` | The Python extraction engine: normalization, two model calls, validation, policy derivation, the canonical string and its SHA-256, a FastAPI boundary and a pytest suite. |
| `scripts/preflight.mjs` | Seven checks to run before a demo. |
| `scripts/seal_actions.py` | Seals an actions file by calling the engine's own `canonicalize_execution()` and `hash_execution()`. Never reimplements them. |

## Current state

The engine is complete and callable. `create_app()` in `services/extractor/app.py` builds the FastAPI
application and the module ends in `app = create_app()`; `run_extraction()` in
`services/extractor/pipeline.py` is implemented, and a `Procfile` and a root `requirements.txt` are in
place for deployment. Whether an instance is serving at any given moment is a deployment question, not
a repository one: point `ENGINE_URL` and `ENGINE_TOKEN` at a running instance and the bridge calls it,
sending the token as `Authorization: Bearer`.

The bridge does not depend on that. When `ENGINE_URL` is unset, `ENGINE_TOKEN` is missing, or the six
attempts fail, `processTranscript()` falls back to `web/actions.json` on disk, logs `[executed]` for the
auto-execute actions and sends the held ones to Telegram. That fallback is not a stub: it is the path
the recorded demo runs on, and it is tested against the real Telegram API, not a mock.

`web/actions.json` as committed is a sealed snapshot, not a hand-written fixture. It carries
`transcript` and five actions, each with `canonical` and `hash`. Those two fields were produced by
`scripts/seal_actions.py`, which imports `canonicalize_execution()` and `hash_execution()` from
`services/extractor/derivation.py` and calls them unchanged. No JavaScript in this repository ever
builds a canonical string; the seal always comes from the engine's own code, whether it arrives over
HTTP or is written to disk ahead of time.

The page reads `transcript.json` and `actions.json` on load, then polls `GET /api/status/:id` every two
seconds for every card still held, moving it to done or refused on its own. A failed poll is ignored and
retried; polling stops when nothing is held. Served as static files with no bridge behind them, held
cards simply stay amber.

## The thesis

The model predicts the action and its type. It never decides whether an action may run.
Deterministic code maps the type to an execution policy. In `services/extractor/action_specs.py` the
`REVERSIBILITY` table says `calendar_event`, `task` and `note` are reversible, `email` and
`listing_publish` are not, and `unknown` is neither. In `services/extractor/derivation.py`,
`build_resolved_actions()` derives the hold reason in a fixed order: `unknown_type`, then
`irreversible_type`, then `missing_required_parameter` when a required field of `ACTION_SPECS` is
`null`; `auto_execute` is true only when no reason applies. A misclassification changes which policy
applies. It never changes what a policy permits.

Nothing downstream recomputes that decision: `src/bridge.mjs` reads only the `auto_execute` boolean and
`src/hold.mjs` translates `hold_reason` into plain language (`HOLD_REASON_TEXT`, mirrored in English by
`web/app.js`). Confidence plays no part in the stop: an email at 1.0 is held, a task at 0.3 runs.

## The hash rule

Approval proves that a human said yes. The hash proves that what they said yes to is what runs.

The engine emits, for every action, a canonical JSON string covering `type` and `payload` together,
plus its SHA-256. The approval layer never re-serialises that string: it stores the bytes as they
arrived and re-hashes those same bytes when the human approves. Two implementations of "canonical" in
two languages agree in tests and disagree on real data; SHA-256 over identical bytes is identical
everywhere. Where this happens:

- `services/extractor/derivation.py`, `canonicalize_execution()`: `json.dumps` of `{"type", "payload"}`
  with `sort_keys=True`, `separators=(",", ":")`, `ensure_ascii=False`; `hash_execution()`: SHA-256 of
  that string as UTF-8. `ExtractionResult` in `models.py` carries them under `execution_integrity` as
  `canonical_execution` and `execution_sha256`; the approval layer reads `canonical` and `hash` on the
  action itself. No code in the repository maps one shape to the other.
- `src/bridge.mjs`, `extract()` and `processTranscript()`: the engine's response, or the file on disk,
  is passed through as received; each action with `auto_execute: false` goes to `sendProposal()`. The
  bridge neither canonicalises nor hashes anything.
- `src/hold.mjs`, `sendProposal()` stores `{ id, canonical, hash, status: 'pending' }` with `canonical`
  exactly as it arrived and refuses an action whose `canonical` is not a string. `verify()` is
  `createHash('sha256').update(proposal.canonical, 'utf8')` compared with the stored `hash`. The only
  `JSON.stringify` in the file encodes Telegram request bodies.
- `src/hold.mjs`, `handleUpdate()`: on Approve, `answerCallbackQuery` goes first, then `verify()`.
  Match: status `approved`, card edited to APPROVED. Mismatch: status `refused`, card edited to
  REJECTED showing both hashes (`decidedText()`). Only presses whose `chat_id` and `from.id` both
  equal `TG_CHAT` are accepted, and only from the message that showed the card.
- `src/hold.mjs`, `readSealed()` renders the card by parsing the stored canonical string, never from
  the `payload` object, so what is shown is what is sealed; hashing still uses the raw string.
  `tamperTest()` alters one character of the recipient inside the stored string and runs the same
  `verify()`: the refusal shown on camera.

Because `type` is inside the hashed bytes, approving a note body and executing it as an email body is
refused too. The hash is an approval-integrity check, not an idempotency key.

## How to run it

Node 22 or newer, no dependencies and no `package.json`. A Telegram bot token from BotFather and the
private chat id of the approver, who must have opened the bot and pressed Start, or Telegram answers 403.

1. Configuration.

       cp .env.example .env

   `TG_TOKEN` and `TG_CHAT` are needed by everything below. `ENGINE_URL`, `ENGINE_TOKEN` and
   `PRINCIPAL` are read by the bridge; with no instance to call, leave `ENGINE_URL` empty and the
   bridge falls back to the file without attempting a call. `TRANSCRIPT_PATH` defaults to
   `web/transcript.json`; when the file is missing the bridge says so and falls back the same way.
   `.env` is ignored by git and no value in it is ever printed.

2. Preflight.

       node scripts/preflight.mjs

   Seven checks: the `.env` keys, Telegram `getMe` and `getChat`, `ENGINE_URL` reachability, port 8080
   free, `web/actions.json` well formed, both Node modules present. Exit code 0 only when all seven pass.
   Two of them report the environment rather than the code: `ENGINE_URL` fails whenever no engine
   instance is reachable, and port 8080 fails once the bridge is already running on it. Read the lines,
   not the score.

3. The fastest way to see the hold work, with nothing else running.

       node src/demo.mjs

   Sends one fixed card, the demo email, to `TG_CHAT`. Press APPROVE on the phone: the card is edited in
   place to APPROVED. Then press Enter in the terminal, or type `/tamper a4` in the bot chat: the card is
   edited to REJECTED with both hashes, printed in the terminal too. HOLD ends the run without releasing.

4. The bridge and the page.

       node src/bridge.mjs

   Serves `web/` on `http://127.0.0.1:8080` and `GET /api/status/:id` (`pending`, `approved`, `refused`,
   or 404 for an unknown id), then loads `web/actions.json` as described under Current state. Console
   commands: `tamper <id>`, `list`, `quit`. On the page, "Turn this meeting into work" reveals the cards
   one by one: DONE for auto-execute actions, WAITING FOR YOU plus the hold reason for held ones, weakly
   supported values flagged, hover to highlight the turns in `action_evidence`. Approve a card on the
   phone and its card on the page turns green within two seconds without a reload; force a refusal and it
   turns red. The counter's seconds come from `actions.json`. The Guardrail toggle renders the same
   actions with nothing held.

5. Tests.

       node --test src/hold.test.mjs
       node --test src/bridge.test.mjs
       python3 -m pytest services/extractor/tests

   The hold suite is 27 tests against a fake Telegram: no network, no real `.env`, and one fixture that a
   re-serialising verifier would reject, so the rule is tested and not merely stated. The Python suite
   needs the packages in `services/extractor/requirements.txt`; it covers normalization, validation,
   derivation, the model-call contract and the HTTP boundary.

## One limitation, stated plainly

Approving an email does not send an email. No email provider is wired and none will be added. The
bridge marks auto-execute actions with `[executed]` in the console and does nothing else; the page's
DONE badge is a label derived from `auto_execute`, not an effect; approving a held action grants or
refuses release and nothing else. What is demonstrated is that release is granted or refused, bound
to the exact bytes a human saw.

## Credits

- Manu Martín: repository, the Node bridge, the Telegram hold, the hash verification and deployment.
- Aarón Nuñez Tejado: the page under `web/`, the demo transcript, and the video.
- Tomer Messinger Carmeli: the extraction engine under `services/extractor/`, a separate Python service,
  and its canonicalization, which is the only source of every seal in this repository.

Built on 12 September 2026 at the AI Tinkerers "Agents, Everywhere" hackathon in Valencia.
