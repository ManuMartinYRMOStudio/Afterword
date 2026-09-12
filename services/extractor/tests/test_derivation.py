"""Deterministic derivation, policy, ordering, and integrity tests."""

from __future__ import annotations

import pytest

from services.extractor.action_specs import ACTION_SPECS, REVERSIBILITY
from services.extractor.derivation import (
    build_resolved_actions,
    canonicalize_execution,
    hash_execution,
)
from services.extractor.models import (
    ActionType,
    Call2ActionDraft,
    CommitmentBasis,
    CommitmentCandidate,
    HoldReason,
    ParameterDraft,
    SupportLevel,
)


def candidate(
    candidate_id: str = "C01",
    *,
    support: SupportLevel = SupportLevel.EXPLICIT,
) -> CommitmentCandidate:
    return CommitmentCandidate(
        candidate_id=candidate_id,
        responsible_speakers=["CLARA"],
        intended_effect=f"Resolve {candidate_id}",
        commitment_evidence=["L01"],
        commitment_support=support,
        commitment_basis=CommitmentBasis.SELF_COMMITMENT,
    )


def parameter(
    name: str,
    *,
    value: str | None = None,
    support: SupportLevel = SupportLevel.EXPLICIT,
) -> ParameterDraft:
    return ParameterDraft(
        name=name,
        value=value if value is not None else f"value for {name}",
        evidence=["L02"],
        support=support,
    )


def draft(
    action_type: ActionType = ActionType.TASK,
    *,
    candidate_id: str = "C01",
    parameters: list[ParameterDraft] | None = None,
    title: str = "Presentation title",
    summary: str = "Presentation summary",
) -> Call2ActionDraft:
    if parameters is None:
        parameters = [parameter(name) for name in ACTION_SPECS[action_type].required]
    return Call2ActionDraft(
        candidate_id=candidate_id,
        type=action_type,
        title=title,
        summary=summary,
        parameters=parameters,
    )


def resolve(
    action_draft: Call2ActionDraft,
    *,
    action_support: SupportLevel = SupportLevel.EXPLICIT,
):
    actions, warnings = build_resolved_actions(
        [candidate(action_draft.candidate_id, support=action_support)],
        [action_draft],
    )
    assert warnings == []
    assert len(actions) == 1
    return actions[0]


def integrity(action) -> tuple[str, str]:
    canonical = canonicalize_execution(action.type, action.payload)
    return canonical, hash_execution(canonical)


def test_required_parameter_is_copied_with_evidence():
    action = resolve(
        draft(parameters=[parameter("title", value="Pull comparable sales")])
    )

    assert action.payload == {"title": "Pull comparable sales"}
    assert action.parameter_evidence["title"].evidence == ["L02"]
    assert action.parameter_evidence["title"].support is SupportLevel.EXPLICIT


def test_missing_required_parameter_becomes_null_with_absent_evidence():
    action = resolve(draft(parameters=[]))

    assert action.payload == {"title": None}
    assert action.parameter_evidence["title"].evidence == []
    assert action.parameter_evidence["title"].support is None


def test_missing_optional_parameter_is_omitted_entirely():
    action = resolve(draft(parameters=[parameter("title")]))

    assert "due" not in action.payload
    assert "due" not in action.parameter_evidence


def test_aggregate_support_is_weakest_action_or_required_support():
    action = resolve(
        draft(
            ActionType.CALENDAR_EVENT,
            parameters=[
                parameter("title", support=SupportLevel.EXPLICIT),
                parameter("datetime", support=SupportLevel.WEAK),
            ],
        ),
        action_support=SupportLevel.CONTEXTUAL,
    )

    assert action.support is SupportLevel.WEAK
    assert action.confidence == 0.3


def test_optional_weak_support_does_not_lower_aggregate():
    action = resolve(
        draft(
            parameters=[
                parameter("title", support=SupportLevel.EXPLICIT),
                parameter("due", support=SupportLevel.WEAK),
            ]
        )
    )

    assert action.parameter_evidence["due"].support is SupportLevel.WEAK
    assert action.support is SupportLevel.EXPLICIT
    assert action.confidence == 1.0


def test_missing_required_parameter_nulls_support_and_confidence():
    action = resolve(draft(parameters=[]))

    assert action.support is None
    assert action.confidence is None


@pytest.mark.parametrize(
    ("support", "confidence"),
    [
        (SupportLevel.WEAK, 0.3),
        (SupportLevel.CONTEXTUAL, 0.6),
        (SupportLevel.EXPLICIT, 1.0),
    ],
)
def test_all_support_levels_have_frozen_numeric_mapping(support, confidence):
    action = resolve(
        draft(parameters=[parameter("title", support=support)]),
        action_support=SupportLevel.EXPLICIT,
    )

    assert action.support is support
    assert action.confidence == confidence


@pytest.mark.parametrize(
    ("action_type", "reversible", "hold_reason", "auto_execute"),
    [
        (ActionType.CALENDAR_EVENT, True, None, True),
        (ActionType.TASK, True, None, True),
        (ActionType.NOTE, True, None, True),
        (ActionType.EMAIL, False, HoldReason.IRREVERSIBLE_TYPE, False),
        (ActionType.LISTING_PUBLISH, False, HoldReason.IRREVERSIBLE_TYPE, False),
        (ActionType.UNKNOWN, None, HoldReason.UNKNOWN_TYPE, False),
    ],
)
def test_exact_reversibility_policy(action_type, reversible, hold_reason, auto_execute):
    action = resolve(draft(action_type))

    assert REVERSIBILITY[action_type] is reversible
    assert action.hold_reason is hold_reason
    assert action.auto_execute is auto_execute
    assert action.auto_execute is (action.hold_reason is None)


@pytest.mark.parametrize(
    ("action_type", "expected_reason"),
    [
        (ActionType.UNKNOWN, HoldReason.UNKNOWN_TYPE),
        (ActionType.EMAIL, HoldReason.IRREVERSIBLE_TYPE),
        (ActionType.TASK, HoldReason.MISSING_REQUIRED_PARAMETER),
    ],
)
def test_hold_reason_precedence_with_missing_required_parameter(
    action_type, expected_reason
):
    action = resolve(draft(action_type, parameters=[]))

    assert all(value is None for value in action.payload.values())
    assert action.hold_reason is expected_reason
    assert action.auto_execute is False


def test_weak_complete_reversible_action_may_auto_execute():
    action = resolve(
        draft(parameters=[parameter("title", support=SupportLevel.WEAK)]),
        action_support=SupportLevel.WEAK,
    )

    assert action.confidence == 0.3
    assert action.hold_reason is None
    assert action.auto_execute is True


def test_final_order_and_ids_follow_candidates_not_reversed_drafts():
    candidates = [candidate("C01"), candidate("C02"), candidate("C03")]
    drafts = [
        draft(candidate_id="C03", title="Third"),
        draft(candidate_id="C02", title="Second"),
        draft(candidate_id="C01", title="First"),
    ]

    actions, warnings = build_resolved_actions(candidates, drafts)

    assert warnings == []
    assert [(action.id, action.title) for action in actions] == [
        ("a1", "First"),
        ("a2", "Second"),
        ("a3", "Third"),
    ]


def test_payload_mapping_order_does_not_affect_canonical_string_or_hash():
    first = canonicalize_execution(
        ActionType.EMAIL, {"to": "a@example.com", "body": "Hello", "subject": "Hi"}
    )
    second = canonicalize_execution(
        ActionType.EMAIL, {"subject": "Hi", "body": "Hello", "to": "a@example.com"}
    )

    assert first == second
    assert hash_execution(first) == hash_execution(second)


def test_canonical_execution_is_compact_sorted_json_and_utf8_hash():
    canonical = canonicalize_execution(ActionType.TASK, {"title": "Café"})

    assert canonical == '{"payload":{"title":"Café"},"type":"task"}'
    assert hash_execution(canonical) == (
        "0480f24310c80059424e612d7b737c149978581ac939ad1f184bf2ad53169b23"
    )


def test_identical_type_and_payload_have_identical_integrity():
    first = resolve(draft(title="First presentation", summary="First summary"))
    second = resolve(draft(title="Second presentation", summary="Second summary"))

    assert integrity(first) == integrity(second)


def test_changing_type_changes_canonical_string_and_hash():
    payload = {"body": "same execution value"}
    note = canonicalize_execution(ActionType.NOTE, payload)
    email = canonicalize_execution(ActionType.EMAIL, payload)

    assert note != email
    assert hash_execution(note) != hash_execution(email)


def test_changing_payload_changes_canonical_string_and_hash():
    first = canonicalize_execution(ActionType.TASK, {"title": "First"})
    second = canonicalize_execution(ActionType.TASK, {"title": "Second"})

    assert first != second
    assert hash_execution(first) != hash_execution(second)


def test_presentation_title_and_summary_do_not_affect_integrity():
    first = resolve(draft(title="Original title", summary="Original summary"))
    second = first.model_copy(
        update={"title": "Changed title", "summary": "Changed summary"}
    )

    assert integrity(first) == integrity(second)


def test_support_and_confidence_do_not_affect_integrity():
    explicit = resolve(draft(), action_support=SupportLevel.EXPLICIT)
    weak = explicit.model_copy(
        update={"support": SupportLevel.WEAK, "confidence": 0.3}
    )

    assert integrity(explicit) == integrity(weak)
