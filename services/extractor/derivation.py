"""Deterministic resolved-action and execution-integrity derivation."""

from __future__ import annotations

from .action_specs import (
    ACTION_SPECS,
    REVERSIBILITY,
    SUPPORT_ORDER,
    SUPPORT_TO_CONFIDENCE,
)
from .models import (
    ActionType,
    Call2ActionDraft,
    CommitmentCandidate,
    HoldReason,
    ParameterEvidence,
    ResolvedAction,
    SupportLevel,
    ValidationWarning,
)


def _build_payload_and_support(
    draft: Call2ActionDraft, action_support: SupportLevel
) -> tuple[
    dict[str, str | None],
    dict[str, ParameterEvidence],
    SupportLevel | None,
    float | None,
]:
    """Construct payload/evidence and aggregate required-field support."""

    spec = ACTION_SPECS[draft.type]
    parameters = {parameter.name: parameter for parameter in draft.parameters}
    payload: dict[str, str | None] = {}
    parameter_evidence: dict[str, ParameterEvidence] = {}

    for field in (*spec.required, *spec.optional):
        parameter = parameters.get(field)
        if parameter is None:
            if field in spec.required:
                payload[field] = None
                parameter_evidence[field] = ParameterEvidence(evidence=[], support=None)
            continue

        payload[field] = parameter.value
        parameter_evidence[field] = ParameterEvidence(
            evidence=parameter.evidence,
            support=parameter.support,
        )

    if any(payload[field] is None for field in spec.required):
        return payload, parameter_evidence, None, None

    required_supports = [
        parameter_evidence[field].support for field in spec.required
    ]
    aggregate_support = min(
        (action_support, *required_supports),
        key=SUPPORT_ORDER.__getitem__,
    )
    return (
        payload,
        parameter_evidence,
        aggregate_support,
        SUPPORT_TO_CONFIDENCE[aggregate_support],
    )


def build_resolved_actions(
    candidates: list[CommitmentCandidate], drafts: list[Call2ActionDraft]
) -> tuple[list[ResolvedAction], list[ValidationWarning]]:
    """Join validated stages in candidate order and derive final action policy."""

    drafts_by_candidate_id = {draft.candidate_id: draft for draft in drafts}
    actions: list[ResolvedAction] = []

    for candidate in candidates:
        draft = drafts_by_candidate_id.get(candidate.candidate_id)
        if draft is None:
            continue

        payload, parameter_evidence, support, confidence = (
            _build_payload_and_support(draft, candidate.commitment_support)
        )
        spec = ACTION_SPECS[draft.type]

        if draft.type is ActionType.UNKNOWN:
            hold_reason = HoldReason.UNKNOWN_TYPE
        elif REVERSIBILITY[draft.type] is False:
            hold_reason = HoldReason.IRREVERSIBLE_TYPE
        elif any(payload[field] is None for field in spec.required):
            hold_reason = HoldReason.MISSING_REQUIRED_PARAMETER
        else:
            hold_reason = None

        actions.append(
            ResolvedAction(
                id=f"a{len(actions) + 1}",
                type=draft.type,
                title=draft.title,
                summary=draft.summary,
                payload=payload,
                action_evidence=candidate.commitment_evidence,
                action_support=candidate.commitment_support,
                parameter_evidence=parameter_evidence,
                support=support,
                confidence=confidence,
                auto_execute=hold_reason is None,
                hold_reason=hold_reason,
            )
        )

    return actions, []


def canonicalize_execution(
    action_type: ActionType, payload: dict[str, str | None]
) -> str:
    raise NotImplementedError("Canonical serialization belongs to a later wave")


def hash_execution(canonical_execution: str) -> str:
    raise NotImplementedError("Execution hashing belongs to a later wave")
