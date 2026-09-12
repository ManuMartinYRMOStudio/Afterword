# Afterword — action contract v1

**Status: frozen for the hackathon build window (2026-09-12).** Changes from here require
agreement in the team chat before Saturday.

This is the interface between the extraction engine and everything downstream: the UI cards, the
Telegram approval layer and the release check. With this agreed, the engine and the rest of the
app can be built in parallel without talking to each other.

---

## The invariant

> The model predicts the **action** and its **type**. It never directly sets execution authority
> or reversibility. Deterministic code maps the predicted type to policy. A misclassification
> changes *which* policy applies; it cannot change *what* a policy permits.

Everything below is the mechanical expression of that sentence.

---

## The object

```json
{
  "id": "a4",
  "type": "email",
  "title": "Send listing agreement to David Whitmore",
  "summary": "3% + VAT, 90 days exclusive, approx. €329,000",
  "payload": {
    "to": "david.whitmore@example.com",
    "subject": "Listing agreement — Ruzafa",
    "body": "3% + VAT, 90 days exclusive, asking price approx. €329,000"
  },
  "action_evidence": ["L03"],
  "action_support": "explicit",
  "parameter_evidence": {
    "to":      { "evidence": ["L05"],        "support": "explicit" },
    "subject": { "evidence": ["L01", "L03"], "support": "contextual" },
    "body":    { "evidence": ["L03", "L07"], "support": "weak"     }
  },
  "support": "weak",
  "confidence": 0.3,
  "auto_execute": false,
  "hold_reason": "irreversible_type"
}
```

That is the email card of the demo transcript. The `subject` is `contextual`, not `explicit`: the
meeting establishes what the email is about but nobody says that subject line out loud, so it is a
composed value. The `body` is `weak` because the asking price inside it is the one figure the
speaker explicitly refused to put in writing, and the overall figure follows the weakest required
parameter. The card is held anyway — not because of the `0.3`, but because `email` is
irreversible.

Note what is **not** in there: `reversible`. See below.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Short. It travels inside Telegram's `callback_data`, capped at 64 bytes. |
| `type` | enum | One of the five below, or `unknown`. The only risk-relevant thing the model decides. |
| `title` | string | One line, human-readable. Shown on the card. |
| `summary` | string | One line of detail. Shown under the title. |
| `payload` | object | Flat, type-specific values. **This is what would execute.** Concrete fields per type are deferred to the implementation plan. The hashed bytes cover `type` **and** `payload` — see Downstream. |
| `action_evidence` | array of turn IDs | One or more deterministic transcript-turn IDs supporting that this action exists. |
| `action_support` | enum | How strongly `action_evidence` supports that the action exists at all: `explicit`, `contextual` or `weak`. Emitted by the model, about the action only — never about its values. |
| `parameter_evidence` | object | One entry **per key present in `payload`**: its own supporting turn IDs and its own support category. |
| `support` | enum or null | **Derived.** Weakest of `action_support` and the support of every **required** parameter. |
| `confidence` | number or null | Deterministic numeric mapping of `support`. Review metadata only. `null` when a required parameter has no support at all. |
| `auto_execute` | boolean | **Derived by code, never by the model.** |
| `hold_reason` | enum or null | `irreversible_type`, `unknown_type`, `missing_required_parameter`, or `null` when the action auto-executes. |

**No model call emits this object.** It is assembled by deterministic code from two separate model
stages, neither of which sees the whole shape:

| Field | Origin |
|---|---|
| `action_evidence`, `action_support` | the commitment-discovery stage, which knows nothing of action types |
| `type`, `title`, `summary` | the capability-resolution stage |
| `payload`, `parameter_evidence` | built by code from the parameters the capability stage returned, one entry each |
| `id`, `support`, `confidence`, `auto_execute`, `hold_reason` | computed by code |

If either stage emits a derived field anyway, it is discarded — not merged, not trusted as a hint.

The split is deliberate. Each model stage is asked only for things it can observe in the
transcript: what was committed to and by whom, what effect it intends, which values it carries,
how directly each is stated, and where. Everything with an execution consequence is computed
afterwards, from those observations. The extractor's internal staging is described in
`AFTERWORD-TECHNICAL-EXECUTION-PLAN.md`; this contract commits only to the object above.

**Only the principal's commitments become actions.** A commitment made by another participant may
be correctly discovered upstream and is then dropped before it reaches this object. Nothing in the
resolved action carries ownership, because by the time it exists the question is already settled.

---

## The five action types

| `type` | Reversible | What it means |
|---|---|---|
| `calendar_event` | **yes** | Create a meeting or reminder. Deleting it costs nothing. |
| `task` | **yes** | Open a task or ticket. Closing it costs nothing. |
| `note` | **yes** | Write to a client record. Editable. |
| `email` | **no** | Send an email outside the company. Cannot be recalled. |
| `listing_publish` | **no** | Publish a property listing to a public portal. The market has seen it. |
| `unknown` | **not applicable** | An unrecognised or ambiguous action. It never auto-executes. |

---

## `reversible` is derived, never predicted

```
REVERSIBLE = {
  calendar_event:  true,
  task:            true,
  note:            true,
  email:           false,
  listing_publish: false,
  unknown:         null,
}
```

The model classifies `type`. The code looks up `reversible`. This is the whole point of the
project, so it is worth being blunt: our claim is that the stop holds **structurally**, not
because the model understood that an email is dangerous. If a model could mark an email as
reversible, there would be no stop — just a model being careful, which is not a guarantee.

### `unknown` fails closed on the irreversible path

`unknown` follows **exactly** the same execution path as an irreversible action: it never
auto-executes and it is held for the user. The user is never asked to classify whether the action
is reversible — saving them that work is the point of the product.

The path is identical; the recorded reason is not. `hold_reason` distinguishes `unknown_type`
from `irreversible_type` so the review surface can say *why* it stopped without changing *what*
it did.

---

## Support, evidence and confidence

Support is declared in two places, both by the model, and they are about different claims.

- **`action_support`** — how strongly the transcript supports that this action was committed to
  at all.
- **`parameter_evidence[k].support`** — how strongly the transcript supports the *value* of `k`.

**Every key present in `payload` carries its own supporting turn IDs and its own support
category.** A parameter can be supported by turns different from the ones that support the action
itself, and it can be weaker or stronger than the action. An explicitly promised email whose
amount was never confirmed is `action_support: explicit` with a `weak` parameter — and that is
exactly the case the overall figure has to reflect.

| Support | Numeric mapping | Meaning |
|---|---:|---|
| `explicit` | `1.0` | The source turns state the commitment or value directly. |
| `contextual` | `0.6` | It follows from nearby meeting context but is not stated directly in one turn. |
| `weak` | `0.3` | The commitment or value is provisional, ambiguous or only loosely supported. |

The mapping is a deterministic encoding of the category. It carries no information the category
does not already carry, and it does not affect execution.

**Overall `support` and `confidence` are the weakest of `action_support` and the support of every
required parameter** — never an average. A weak critical value cannot be hidden by several
explicit ones. Optional parameters carry their own support locally but do not drag the overall
figure down.

```
support = min(action_support, *[p.support for p in required_parameters])
          ordered weak < contextual < explicit
```

### Absent support is not weak support

A required parameter with no supporting turn is emitted as `null` in `payload` and **never
inferred to a plausible value**. Its `parameter_evidence` entry is `{ "evidence": [],
"support": null }`.

A `null` required parameter forces the hold regardless of how well the action itself is
supported, and sets overall `support` and `confidence` to `null`. This keeps *weakly supported*
and *not supported at all* from collapsing into the same `0.3`. Cards with `confidence: null`
sort to the top of the review queue.

Optional parameters with no support are **omitted from `payload` entirely**. `null` is reserved
for required parameters, where it is a deliberate statement that the meeting did not supply the
value.

### Corrections and conflicts

When a value is stated and later corrected, the parameter takes the **superseding** value. Its
`evidence` lists the superseding turn first and may also list the superseded turn; support is
`explicit` when the correction is unambiguous.

When two speakers state incompatible values and the conflict is never resolved in the transcript,
the parameter is **not guessed**. If it is required, it is `null` and the action is held.

### Confidence never affects the stop

An `email` at `confidence: 1.0` is still held. A `task` at `confidence: 0.3` still executes — it
is reversible, so the cost of being wrong is one click. Confidence measures extraction quality,
not risk. Risk is `type`, and `type` alone.

There are exactly two gates, and confidence is neither of them: **risk**, decided by `type`, and
**completeness**, decided by whether every required parameter has a value. A weakly supported
value is still a value and does not stop a reversible action. A missing one does, because there
is nothing to execute.

---

## Derivation, in order

```
hold_reason =
    type == 'unknown'                     -> 'unknown_type'
    REVERSIBLE[type] == false             -> 'irreversible_type'
    any required parameter is null        -> 'missing_required_parameter'
    otherwise                             -> null

auto_execute = (hold_reason == null)
```

Precedence only decides which single reason is *recorded*. Missing required parameters are always
visible on the card as `null` values, whatever the recorded reason is.

---

## Scope boundary

The contract is general across arbitrary meetings; the property example is only the demo. It does
not define concrete payload fields yet.

**Open dependency, deliberately left open.** Two rules above — the weakest-required-parameter
figure and `missing_required_parameter` — depend on knowing which parameters are required for a
given `type`. The contract states the rules; it does not state the schema. **The implementation
plan must define the concrete required/optional parameter set per type that deterministic
validation uses on Saturday.** Closed by the `ACTION_SPECS` registry in `AFTERWORD-TECHNICAL-EXECUTION-PLAN.md` §12. It stays out of the general contract on
purpose: the schema is expected to change per deployment, the rules are not. It also does not model conditional workflows, dependency
graphs or chained execution. Provisional or approximate values are represented through their
source-turn support and support category, not through a general condition engine.

---

## Delivery

The canonical delivery is a single response from `POST /extract` carrying the resolved actions.

An optional SSE path exists for presentation, emitting actions one at a time once they are fully
resolved, so cards appear progressively instead of all at once. **Emission is progressive;
generation is not streamed** — both model stages complete and validation runs over the whole set
before anything is sent. Streaming is expendable: nothing in this contract depends on it.

```
event: action
data: { ...action object... }

event: done
data: { "total": 5 }
```

`total` means one thing only: the number of actions in this result. A transcript with no
actionable commitment yields no actions and `total: 0`. That is a valid, expected outcome, not a
failure — as is a transcript whose only commitments belong to someone other than the principal.

---

## Downstream, for context

Everything with `auto_execute: true` executes immediately. Everything with `auto_execute: false`
goes to Telegram as a card showing the effect, the payload, the target and the hold reason, with
two buttons.

**The canonical serialisation covers `type` and `payload`, and it is produced by the engine, not
by the approval layer.** The engine emits the canonical string — key-sorted, UTF-8, no
insignificant whitespace — alongside the object, plus its SHA-256. The approval layer stores that
exact string, and at execution time re-hashes **the same stored string** and compares.

`type` is inside the hashed bytes because it selects which executor and which policy apply.
Binding only the payload would leave a gap where the values a human approved stay identical while
the thing done with them changes — approve a `note` body, execute it as an `email` body.

The approval layer never re-serialises. Two implementations of "canonical" in two languages agree
in testing and disagree on something real; SHA-256 over identical bytes is identical everywhere.

If the hashes differ, the release is refused and both are displayed. A human approving proves
they said yes; the hash proves that what they said yes to is what ran.

**That is the whole of the claim. The hash is not an idempotency key.** Two unrelated meetings can
legitimately produce identical `type + payload`, and that is two pieces of work, not a duplicate.
Deduplication needs a separate meeting-and-action identity scheme and is not provided here.

*Aligned 11-09 11:35 with `AFTERWORD-ENGINE-PLAN.md` §9. This was one of the seven fixes settled
with Tomer at 09:17; the edit had landed in the engine plan and not here. Not a reopening of the
freeze — a completed propagation. Flagged for confirmation at the 19:00 call.*
