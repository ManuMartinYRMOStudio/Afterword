# Afterword — Model-Side Action Definitions

**Status:** working reference for the hackathon extractor design.

## Extractable action

An extractable action is **concrete future work that the transcript affirmatively establishes that someone has committed, accepted, or been assigned to do**.

Do not extract:
- observations or facts
- opinions
- desires or preferences
- possibilities or hypotheticals
- completed work
- requests that nobody accepts
- decisions not to act

If it is unclear whether a commitment exists at all, omit it.

If the commitment clearly exists but its real-world effect does not fit a supported capability, emit `unknown`.

Missing required details do not change the action type. They are handled later by deterministic validation.

---

## `calendar_event`

Create a scheduled meeting, appointment, or reminder.

Use when the intended represented effect is creating a calendar object.

Examples:
- “Let’s talk Thursday at noon.” → `calendar_event`
- “I’ll put a follow-up with David on the calendar.” → `calendar_event`

Do not use merely because another action has a deadline:
- “I’ll finish the comparables by Thursday.” → `task`

---

## `task`

Create an internal work item representing human follow-up work.

Use for work such as:
- research
- checking
- reviewing
- preparing
- collecting information
- administrative follow-up

Examples:
- “I’ll pull the last two comparable sales.” → `task`
- “I’ll prepare the valuation analysis.” → `task`

**Do not use `task` as a fallback for unsupported external operations.**

Examples:
- “I’ll transfer the client deposit.” → `unknown`
- “I’ll sign the contract electronically.” → `unknown`

If the requested represented effect is explicitly to create a reminder/task for an otherwise unsupported action, `task` is valid:
- “Remind me to transfer the deposit tomorrow.” → `task`

---

## `note`

Write information into an internal record.

Use only when the transcript commits to recording or saving information.

Examples:
- “I’ll put that on the client file.” → `note`
- “Make a note that the storage room is excluded.” → `note`

Facts alone are not note actions:
- “The storage room is excluded.” → no action

---

## `email`

Send an email outside the company.

Use when the intended effect includes external delivery by email.

Examples:
- “I’ll send you the listing agreement today.” → `email`

Preparation without sending is not an email action:
- “I’ll draft the listing agreement email.” → `task`

If the communication channel is unspecified, do not assume email.

---

## `listing_publish`

Publish a property listing to a public portal.

Use when the intended effect is making the property listing publicly visible.

Examples:
- “I’ll put the flat on the portal before you fly.” → `listing_publish`

Preparation is not publication:
- “I’ll prepare the listing description.” → `task`
- “I’ll save the description to the property file.” → `note`

---

## `unknown`

Use when a concrete future commitment clearly exists, but its intended real-world effect is unsupported or materially ambiguous under the available capabilities.

Examples:
- “I’ll transfer the client deposit.” → `unknown`
- “I’ll call the bank and move the money.” → `unknown`
- “I’ll sign the contract electronically.” → `unknown`

`unknown` does **not** mean:
- uncertainty about whether a commitment exists — omit instead
- a known type with missing parameters — keep the known type and let validation handle completeness

---

## Core classification rule

Classify by the **effect/capability that would represent or perform the action**, not by the grammatical form of the sentence.

The model decides:
- whether a commitment exists
- which supported action type best represents its effect
- what transcript evidence and payload values support it

Deterministic code decides:
- required/optional completeness
- support aggregation
- numeric confidence
- reversibility
- hold reason
- auto-execution authority
