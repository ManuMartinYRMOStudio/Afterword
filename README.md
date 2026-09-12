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
| `src/bridge.mjs` | The Node bridge: calls the engine, writes `web/actions.json`, sends held actions to Telegram, serves `web/` and `GET /api/status/:id`. |
| `src/demo.mjs` | One fixed card to Telegram, with no engine, no bridge and no web. |
| `services/extractor/` | The Python extraction engine: normalization, two model calls, validation, policy derivation, the canonical string and its SHA-256, and a pytest suite. |
| `scripts/preflight.mjs` | Seven checks to run before a demo. |

## Current state

`services/extractor/app.py` raises `NotImplementedError` in `create_app()`, and so does
`run_extraction()` in `services/extractor/pipeline.py`. The engine's stages exist as functions with
tests; there is no HTTP endpoint, so nothing answers `POST /extract`. The bridge therefore runs from
`web/actions.json` on disk: when `ENGINE_URL` is unset or fails its six attempts, `processTranscript()`
reads that file, logs `[executed]` for the auto-execute actions and sends the held ones to Telegram.

As committed, `web/actions.json` is the page's fixture: `seconds` and `actions`, no `transcript` key,
no `canonical` or `hash` on its two held actions (`r4`, `r5`). The bridge's `validateSnapshot()` needs
`transcript` and `sendProposal()` needs `canonical` as a string, so that file drives the page but not
the bridge. A file with `transcript`, plus `canonical` and `hash` on every held action, drives both;
the page accepts that shape too (`normalise()` in `web/app.js`). The page fetches `transcript.json`
and `actions.json` only and does not call `GET /api/status/:id`.

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
  Match: status `approved`, card edited to APROBADO. Mismatch: status `refused`, card edited to
  RECHAZADO showing both hashes (`decidedText()`). Only presses whose `chat_id` and `from.id` both
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

   `TG_TOKEN` and `TG_CHAT` are needed by everything below. `ENGINE_URL` and `PRINCIPAL` are read by
   the bridge; with no endpoint to call, leave `ENGINE_URL` empty and the bridge falls back to the file
   without attempting a call. `TRANSCRIPT_PATH` defaults to `web/sample.txt`, not in the repository;
   when it is missing the bridge says so and falls back the same way. `.env` is ignored by git.

2. Preflight.

       node scripts/preflight.mjs

   Seven checks: the `.env` keys, Telegram `getMe` and `getChat`, `ENGINE_URL` reachability, port 8080
   free, `web/actions.json` well formed, both Node modules present. Spanish output; exit code 0 only when
   all seven pass. Today `ENGINE_URL` fails by construction and the `.env` check counts it as required,
   so expect five of seven at best.

3. The fastest way to see the hold work, with nothing else running.

       node src/demo.mjs

   Sends one fixed card, the demo email, to `TG_CHAT`. Press Aprobar on the phone: the card is edited in
   place to APROBADO. Then press Enter in the terminal, or type `/tamper a4` in the bot chat: the card is
   edited to RECHAZADO with both hashes, printed in the terminal too. Retener ends the run without releasing.

4. The bridge and the page.

       node src/bridge.mjs

   Serves `web/` on `http://127.0.0.1:8080` and `GET /api/status/:id` (`pending`, `approved`, `refused`,
   or 404 for an unknown id), then loads `web/actions.json` as described under Current state. Console
   commands: `tamper <id>`, `list`, `quit`. On the page, "Turn this meeting into work" reveals the cards
   one by one: DONE for auto-execute actions, WAITING FOR YOU plus the hold reason for held ones, weakly
   supported values flagged, hover to highlight the turns in `action_evidence`. The counter's seconds
   come from `actions.json`. The Guardrail toggle renders the same actions with nothing held.

5. Tests.

       node --test src/hold.test.mjs
       python3 -m pytest services/extractor/tests

   The Node suite is 27 tests against a fake Telegram, no network, no real `.env`. The Python suite
   needs the packages in `services/extractor/requirements.txt`; it covers normalization, validation,
   derivation and the model-call contract.

## One limitation, stated plainly

Approving an email does not send an email. No email provider is wired and none will be added. The
bridge marks auto-execute actions with `[executed]` in the console and does nothing else; the page's
DONE badge is a label derived from `auto_execute`, not an effect; approving a held action grants or
refuses release and nothing else. What is demonstrated is that release is granted or refused, bound
to the exact bytes a human saw.

## Credits

- Manu Martín: repository, the Node bridge, the Telegram hold, the hash verification and deployment.
- Aarón Nuñez Tejado: the page under `web/`, its transcript and action fixtures, and the video.
- Tomer Messinger Carmeli: the extraction engine under `services/extractor/`, a separate Python service.

Built on 12 September 2026 at the AI Tinkerers "Agents, Everywhere" hackathon in Valencia.
