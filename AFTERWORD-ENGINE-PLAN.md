# Afterword — engine boundary and consumer notes

**Status: draft and reference, not frozen.**

**This document is no longer the implementation plan.** The authoritative implementation plan for
the Python extractor is `AFTERWORD-TECHNICAL-EXECUTION-PLAN.md`, owned by Tomer. Where the two
disagree about how the extractor works internally, that document wins and this one is stale.

What this document keeps is the part it uniquely owns: **what the engine hands to the rest of the
system, what the rest of the system may assume, and what it must not.** Written from the
consumer's side — the page, the executor, the approval layer.

Frozen above both: `AFTERWORD-CONTRACT.md`, the resolved action object.

No implementation code, fixtures, runner or scaffolding is written before the build window opens
on Saturday 2026-09-12.

---

## 1. What the engine is

```
extract(transcript_text, principal) -> (normalised_turns, [resolved_action], debug)
```

**A deterministic wrapper around two non-deterministic steps.** Calling it a pure function would
be wrong. Two batched model calls per transcript at most, and no per-action agent loop:

| # | Stage | Deterministic? |
|---|---|---|
| 0 | Transcript normalisation, speaker turns, `L01…` | yes |
| 1 | **Call 1 — commitment discovery** | no |
| 2 | Call-1 validation, `C01…` candidate IDs | yes |
| 3 | Principal filter | yes |
| 4 | **Call 2 — capability resolution and payload grounding** | no |
| 5 | Call-2 validation | yes |
| 6 | Payload, support, confidence and policy derivation | yes |
| 7 | Canonical `type + payload`, SHA-256 | yes |
| 8 | Emission | yes |

Every guarantee in §4 lives in the deterministic stages. The model's job is to observe; everything
with a consequence is decided by code around it.

**Two properties of the split matter to consumers.**

*Call 1 does not know the capability taxonomy.* It discovers commitments, who owns them and what
effect they intend, in open-world language. It is never shown the six action types, reversibility,
approval or risk. Capability resolution happens in Call 2, against a candidate set that has
already been validated and filtered.

*Ownership is resolved before capability.* Call 1 resolves pronouns to real speaker names, and
deterministic Python then keeps only candidates where `principal ∈ responsible_speakers`. A
commitment the other party made is correctly discovered and then correctly dropped. Consumers
therefore never see another participant's work presented as the user's.

**The engine executes nothing.** Not even reversible actions. It emits objects carrying
`auto_execute: true`, and a separate executor consumes them. The component that talks to the model
has no execution capability at all.

**One implementation, in Python.** FastAPI, Pydantic, Uvicorn, direct OpenAI API. There is no JS
twin. The public page and the Node side are consumers over HTTP; they never reimplement
normalisation, validation or derivation. Two extractors drifting apart is the failure that would
quietly invalidate every golden transcript, because the goldens would only ever be checked against
one of them.

---

## 2. Where each fact lives

To stop this document drifting from Tomer's, it does not restate the extractor's internals. Use
the authoritative plan for all of the following:

| Question | Section of `AFTERWORD-TECHNICAL-EXECUTION-PLAN.md` |
|---|---|
| End-to-end pipeline | §1 |
| Transcript normalisation and turn IDs | §3 |
| What counts as an extractable commitment | §5 |
| Call-1 output shape and fields | §6 |
| Ownership and principal semantics | §7, §9 |
| Call-1 validation | §8 |
| Capability definitions, `task` versus `unknown` | §11 |
| Per-type parameter matrix (`ACTION_SPECS`) | §12 |
| Call-2 output shape, one-to-one invariant | §14, §15 |
| Call-2 validation, duplicates, missing candidates | §16, §31 |
| Support, confidence and policy derivation | §18, §19 |
| Canonical representation and hashing | §21 |
| Debug surfaces | §22 |
| Prompts | §32, §33, §34 |
| Test strategy | §35 |
| Explicit non-goals | §25 |
| Runtime, endpoints, secrets, network path | §27 |
| Python module layout and dependency direction | §28 |
| Parallel development boundary | §29 |
| Pre-hackathon infrastructure preflight | §30 |
| Frozen duplicate-handling and ordering mechanics | §31 |

---

## 3. The executor-facing payload schema

Unchanged, and reviewed from the executor and UI side on 2026-09-11. `ACTION_SPECS` in the Python
service is the single source of truth for both Call-2 instructions and deterministic validation;
the table below is the same set, restated for consumers.

| `type` | required | optional |
|---|---|---|
| `calendar_event` | `title`, `datetime` | `attendees` |
| `task` | `title` | `due` |
| `note` | `body` | `record` |
| `email` | `to`, `subject`, `body` | — |
| `listing_publish` | `property_ref`, `price` | — |
| `unknown` | `description` | — |

All values are strings. Sender identity and portal target are server configuration, not per-action
state. Four consequences were accepted with this schema, recorded so nobody rediscovers them
mid-demo:

- **`email.subject` is almost never stated in a meeting.** It will be `contextual` at best in
  practically every real transcript, so nearly every email card will sit at `0.6` or below. That is
  the design working, not a defect. It stays required because an email card must show the human the
  complete message before they release it, and `email` is always held, so a composed subject is
  always reviewed before it can leave.
- **`calendar_event.datetime` is a free-text string**, so the calendar executor either stubs or
  writes an event without a real time slot. Accepted for Saturday. Do not let it turn into a
  date-parsing project on the day.
- **`note.record` is optional**, so a note with no record lands in a default one. Say "saved" in the
  demo, not "saved to David's file", unless `record` was actually extracted.
- **`listing_publish` targets a mock portal.** Nothing is published anywhere real.

### Grounded synthesis, and what it does not license

Parameter values need not be verbatim quotations. The model may normalise or compose a concise
executor-facing value from the turns it cites — "Thursday at twelve" to "Thursday 12:00", an email
subject from an established purpose, a body assembled from several supported facts.

It may not introduce a substantive fact the cited turns do not support: no invented recipients,
prices, dates, targets or obligations. A composed value is normally `contextual`, not `explicit`.
Where the transcript cannot support a required value, the model omits it and deterministic code
writes `null`.

For consumers this means one thing: **a value on a card is not necessarily a quote.** The evidence
IDs are the quote, and that is what the highlight should show.

---

## 4. What the engine guarantees

Testable claims, and a judge can check each one:

1. No action reaches emission without at least one real, existing supporting turn.
2. No action reaches emission unless the configured principal is among its responsible speakers.
3. No model output can set `auto_execute`, `hold_reason` or reversibility. The fields do not exist
   in either call's schema.
4. `email` and `listing_publish` never carry `auto_execute: true`. No input produces one.
5. `unknown` never carries `auto_execute: true`.
6. A required parameter with no source is `null`, and its action is held whatever its type.
7. Same input, same turn IDs, same candidate IDs, same final ordering — ordering follows validated
   Call-1 candidate order, never Call-2 return order.
8. Given the same model outputs, the same resolved objects. Validation and derivation are
   reproducible by construction.

What it does not guarantee, stated plainly because a judge will find it otherwise:

- **Reproducible extraction.** Temperature 0 and a pinned model reduce variance; they do not
  eliminate it. No claim anywhere should say otherwise.
- **Correct classification.** An injection or an odd phrasing can push Call 2 into the wrong
  `type`. That is a real failure and it changes which policy applies. It does not change what a
  policy permits: a mistyped `note` runs the note path.
- **Complete extraction.** The engine can miss a commitment, and deliberately prefers to. A
  candidate Call 2 fails to resolve produces no action and a warning rather than a guess.
  Under-extraction is the failure we accept; over-extraction is the one we design against.
- **Semantic validity of values.** A malformed address survives validation and is shown to the
  human on the card.

---

## 5. The boundary with execution

**Canonical serialisation lives in the engine and crosses the boundary as bytes.** The engine
emits, alongside `payload`, the canonical serialisation — key-sorted, UTF-8, no insignificant
whitespace — as a string, plus its SHA-256.

**The canonical representation covers `type` and `payload`, not `payload` alone.** `type` selects
which executor and which policy apply, so it is execution-relevant state and has to be bound to
the approval. Binding only the payload would leave a gap where the values a human approved stay
identical while the thing done with them changes — approve a `note` body, execute it as an `email`
body.

**Node never serialises.** If it recomputed the hash by re-serialising the payload with its own
canonicalisation, we would have two implementations of "canonical" in two languages, agreeing about
key ordering, unicode normalisation, number formatting and escaping. They would agree in testing
and disagree on something real. So Node hashes the exact string it was handed and compares to the
exact string it displayed. SHA-256 over identical bytes is identical in every language; canonical
JSON across two languages is a coin flip.

### The hash is an approval-integrity mechanism only

**It is not an idempotency key, and must not be described as one.** Two unrelated meetings can
legitimately produce identical `type + payload` — two people agreeing "I'll email the agreement to
david.whitmore@example.com" in two different calls is not a duplicate, it is two emails.

What the hash proves is narrow and worth exactly what it is worth: *what a human approved is what
ran*. Deduplication needs a separate meeting-and-action identity scheme, which is outside the
extractor's claim for Saturday. If the executor wants idempotency it has to build it, and say so.

`auto_execute` and `hold_reason` are transitively bound: both are pure functions of `type`, the
nulls in `payload` and the `ACTION_SPECS` schema, so neither can be altered between display and
execution without changing the hash. That holds while both sides share one schema version.

### What Node must not do

Execute `action.title` instead of `payload.title`. They are deliberately separate: the action-level
field is the card headline, the payload field is the value that executes and is hashed. The
executor reads `payload` and nothing else; the UI reads the rest.

How the card is rendered, how the release key is signed and where the wait is durable belong to
`AFTERWORD-EXECUTOR-PLAN.md`, and none of it is assumed here beyond the fact that something
downstream consumes `type`, `payload`, `auto_execute` and the canonical string.

---

## 6. Transport

The Python service exposes:

| Endpoint | Status |
|---|---|
| `POST /extract` | **canonical.** Returns the full resolved result. |
| `POST /extract/stream` | optional presentation path, SSE. |
| `GET /health` | liveness. |

**`/extract` is the contract. SSE is expendable.** If streaming becomes a time sink on Saturday it
is dropped and the interface renders from the single response; nothing in the guarantee depends on
it.

Where SSE is used, emission is progressive but **generation is not streamed**: both model calls
complete, validation and derivation run over the whole set, and only then are resolved actions sent
one at a time. No incremental structured-output parsing, and no card reaching the screen and then
being retracted because validation dropped it. Claiming live streaming from the model would be a
claim a judge can check.

The intended path is server to server: **browser → frontend/Node service → Python extractor →
OpenAI.** The extractor has no architectural dependency on Netlify, AG-UI, CopilotKit or Telegram.
Those are downstream consumers or hosting details for the page, not parts of the engine.

Deployment is Cloud Run, owned by Tomer, with preflight **before** Saturday. The local path is the
same service at a different address, so the base URL lives in one config value and switching takes
seconds.

---

## 7. Build order for Saturday

Sequential, each block ending in something demonstrable. The stop rules matter more than the
estimates.

| # | Block | Done when |
|---|---|---|
| B0 | Cloud Run preflight — **before Saturday** | a trivial service deploys, responds and answers `/health` |
| B1 | Normalisation, speakers, turn IDs | demo and all six goldens renumber to the IDs in their specs |
| B2 | Call 1 + Call-1 validation + candidate IDs + principal filter | G1 yields zero commitments; G3 discovers Pablo's forward and drops it |
| B3 | Call 2 + Call-2 validation | one-to-one invariant holds; illegal parameter names are dropped and warned |
| B4 | Derivation and policy | demo produces exactly 3 auto-execute, 2 held, with the frozen figures |
| B5 | Canonical bytes and hash | same `type + payload` gives the same hash; presentation fields do not affect it |
| B6 | `/extract` response, then SSE if time | `total: 0` renders for G1 |
| B7 | Demo and six goldens compared by eye | each divergence is either fixed or written down |

**Stop rule one: B1–B5 are the project.** The guarantee is in validation, derivation and the hash.

**Stop rule two: SSE is optional.** If B6's streaming half is slow, ship `/extract` and render from
one response.

**Stop rule three: if B0 has not gone clean before Saturday, start local and deploy later.** The
engine does not care where it runs. Nobody debugs Cloud Run at midday with the extractor unbuilt.

---

## 8. Decision trail

Settled:

- Missing required parameter forces a hold; `null` is distinct from `weak`.
- One Python engine, Cloud Run, local fallback, no JS twin.
- Two batched model calls, no per-action agent loop.
- Call 1 is capability-blind; Call 2 resolves only supplied candidates.
- Ownership resolved in Call 1, filtered deterministically by Python; no pronoun reasoning in code.
- Metadata minimal in the emitted result; no `run_id` until a consumer needs one. Stage-level debug
  detail is a separate development surface.
- Action-level `title` stays separate from `payload.title`.
- Canonical bytes bind `type` and `payload`.
- **The hash is approval integrity only, not idempotency.**
- `/extract` canonical, SSE optional; emission progressive, generation not streamed.
- Executor payload schema unchanged and reviewed from the consumer side.

Still open:

1. **Fabricated actions are dropped and counted, not shown.** An action whose every supporting turn
   was hallucinated is not weakly supported, it is invented, and there is nothing for a human to
   approve. It is dropped, counted and warned. Surfacing these as cards would need a fourth
   `hold_reason` and reopens a frozen field.
2. **Turn-ID stability across edits.** Edit one line of a pasted transcript and every later ID
   shifts. Fine for a demo, wrong for anything durable. Out of scope for Saturday; noted so nobody
   discovers it live.
3. **Idempotency, if the executor wants it.** Now explicitly not provided by the hash. Either the
   executor builds a meeting-and-action identity scheme or we state in the write-up that repeat
   submissions repeat work.
