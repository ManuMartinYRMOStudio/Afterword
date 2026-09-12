"""Deterministic resolved-action and execution-integrity derivation."""

from __future__ import annotations

from .action_specs import ACTION_SPECS, SUPPORT_ORDER, SUPPORT_TO_CONFIDENCE
from .models import (
    ActionType,
    Call2ActionDraft,
    CommitmentCandidate,
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
    raise NotImplementedError("Resolved-action derivation belongs to a later wave")


def canonicalize_execution(
    action_type: ActionType, payload: dict[str, str | None]
) -> str:
    raise NotImplementedError("Canonical serialization belongs to a later wave")


def hash_execution(canonical_execution: str) -> str:
    raise NotImplementedError("Execution hashing belongs to a later wave")
