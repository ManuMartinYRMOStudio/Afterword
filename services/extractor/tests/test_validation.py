"""Deterministic validation tests for both model-call boundaries."""

from __future__ import annotations

from services.extractor.models import (
    ActionType,
    Call1Commitment,
    Call2ActionDraft,
    CommitmentBasis,
    CommitmentCandidate,
    NormalizedTranscript,
    ParameterDraft,
    SupportLevel,
    TranscriptTurn,
)
from services.extractor.validation import (
    assign_candidate_ids,
    filter_principal,
    validate_call1,
    validate_call2,
)


def transcript() -> NormalizedTranscript:
    return NormalizedTranscript(
        turns=[
            TranscriptTurn(id="L01", speaker="CLARA", text="I'll do it."),
            TranscriptTurn(id="L02", speaker="DAVID", text="I'll help."),
            TranscriptTurn(id="L03", speaker="CLARA", text="By Thursday."),
        ],
        speakers=["CLARA", "DAVID"],
    )


def commitment(
    *,
    speakers: list[str] | None = None,
    evidence: list[str] | None = None,
    intended_effect: str = "complete the work",
) -> Call1Commitment:
    return Call1Commitment(
        responsible_speakers=speakers or ["CLARA"],
        intended_effect=intended_effect,
        commitment_evidence=evidence or ["L01"],
        commitment_support=SupportLevel.EXPLICIT,
        commitment_basis=CommitmentBasis.SELF_COMMITMENT,
    )


def candidate(
    candidate_id: str,
    *,
    speakers: list[str] | None = None,
) -> CommitmentCandidate:
    return CommitmentCandidate(
        candidate_id=candidate_id,
        **commitment(speakers=speakers).model_dump(),
    )


def parameter(
    name: str = "title",
    value: str = "Complete the work",
    *,
    evidence: list[str] | None = None,
    support: SupportLevel = SupportLevel.EXPLICIT,
) -> ParameterDraft:
    return ParameterDraft(
        name=name,
        value=value,
        evidence=["L01"] if evidence is None else evidence,
        support=support,
    )


def draft(
    candidate_id: str,
    *,
    action_type: ActionType = ActionType.TASK,
    title: str = "Complete work",
    parameters: list[ParameterDraft] | None = None,
) -> Call2ActionDraft:
    return Call2ActionDraft(
        candidate_id=candidate_id,
        type=action_type,
        title=title,
        summary="Complete the promised work",
        parameters=[parameter()] if parameters is None else parameters,
    )


def warning_codes(warnings) -> list[str]:
    return [warning.code for warning in warnings]


def test_call1_valid_commitment_survives_unchanged():
    original = commitment(intended_effect="  preserve this exact effect  ")

    validated, warnings = validate_call1([original], transcript())

    assert validated == [original]
    assert warnings == []


def test_call1_unknown_speaker_is_removed_with_warning():
    validated, warnings = validate_call1(
        [commitment(speakers=["UNKNOWN", "CLARA"])], transcript()
    )

    assert validated[0].responsible_speakers == ["CLARA"]
    assert warning_codes(warnings) == ["unknown_speaker_removed"]
    assert warnings[0].stage == "call1"


def test_call1_no_valid_speaker_drops_commitment_with_warning():
    validated, warnings = validate_call1(
        [commitment(speakers=["UNKNOWN"])], transcript()
    )

    assert validated == []
    assert "no_valid_responsible_speaker" in warning_codes(warnings)
    assert "dropped" in warnings[-1].message.lower()


def test_call1_invalid_evidence_is_stripped_with_warning():
    validated, warnings = validate_call1(
        [commitment(evidence=["L99", "L02"])], transcript()
    )

    assert validated[0].commitment_evidence == ["L02"]
    assert warning_codes(warnings) == ["invalid_commitment_evidence_removed"]


def test_call1_no_valid_evidence_drops_commitment_with_warning():
    validated, warnings = validate_call1(
        [commitment(evidence=["L99"])], transcript()
    )

    assert validated == []
    assert "no_valid_commitment_evidence" in warning_codes(warnings)


def test_call1_empty_intended_effect_drops_commitment_with_warning():
    validated, warnings = validate_call1(
        [commitment(intended_effect=" \t\n")], transcript()
    )

    assert validated == []
    assert warning_codes(warnings) == ["empty_intended_effect"]


def test_candidate_ids_are_deterministic_in_surviving_call1_order():
    raw = [
        commitment(intended_effect="first"),
        commitment(speakers=["UNKNOWN"], intended_effect="drop"),
        commitment(intended_effect="third"),
    ]

    validated, _ = validate_call1(raw, transcript())
    candidates = assign_candidate_ids(validated)

    assert [(item.candidate_id, item.intended_effect) for item in candidates] == [
        ("C01", "first"),
        ("C02", "third"),
    ]


def test_principal_filter_keeps_only_exact_owner_matches():
    candidates = [candidate("C01"), candidate("C02", speakers=["DAVID"])]

    assert filter_principal(candidates, "CLARA") == [candidates[0]]
    assert filter_principal(candidates, "clara") == []


def test_shared_commitment_is_retained_when_principal_is_an_owner():
    shared = candidate("C01", speakers=["DAVID", "CLARA"])

    assert filter_principal([shared], "CLARA") == [shared]


def test_other_owner_commitment_is_removed():
    other_owned = candidate("C01", speakers=["DAVID"])

    assert filter_principal([other_owned], "CLARA") == []


def test_call2_exact_one_to_one_candidate_set_succeeds():
    candidates = [candidate("C01"), candidate("C02")]
    drafts = [draft("C01"), draft("C02")]

    validated, warnings = validate_call2(drafts, candidates, transcript())

    assert validated == drafts
    assert warnings == []


def test_call2_unknown_candidate_id_is_dropped_with_warning():
    known = candidate("C01")

    validated, warnings = validate_call2(
        [draft("C99"), draft("C01")], [known], transcript()
    )

    assert [item.candidate_id for item in validated] == ["C01"]
    assert "unknown_candidate_id" in warning_codes(warnings)
    unknown_warning = next(w for w in warnings if w.code == "unknown_candidate_id")
    assert unknown_warning.candidate_id == "C99"
    assert "C99" in unknown_warning.message


def test_call2_missing_expected_candidate_warns_and_emits_no_draft():
    validated, warnings = validate_call2([], [candidate("C01")], transcript())

    assert validated == []
    assert warning_codes(warnings) == ["missing_candidate_resolution"]
    assert warnings[0].candidate_id == "C01"


def test_call2_exact_duplicate_candidate_resolution_collapses():
    duplicate = draft("C01")

    validated, warnings = validate_call2(
        [duplicate, duplicate.model_copy(deep=True)],
        [candidate("C01")],
        transcript(),
    )

    assert validated == [duplicate]
    assert warning_codes(warnings) == ["duplicate_candidate_collapsed"]


def test_call2_conflicting_duplicate_candidate_invalidates_candidate():
    validated, warnings = validate_call2(
        [draft("C01", title="First"), draft("C01", title="Second")],
        [candidate("C01")],
        transcript(),
    )

    assert validated == []
    assert warning_codes(warnings) == ["conflicting_candidate_resolutions"]


def test_call2_illegal_parameter_is_dropped_with_warning():
    legal = parameter()
    illegal = parameter("recipient", "someone@example.com")

    validated, warnings = validate_call2(
        [draft("C01", parameters=[illegal, legal])],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters == [legal]
    assert warning_codes(warnings) == ["illegal_parameter_name"]


def test_call2_exact_duplicate_parameter_collapses():
    original = parameter()

    validated, warnings = validate_call2(
        [draft("C01", parameters=[original, original.model_copy(deep=True)])],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters == [original]
    assert warning_codes(warnings) == ["duplicate_parameter_collapsed"]


def test_call2_conflicting_required_parameter_is_invalidated():
    validated, warnings = validate_call2(
        [
            draft(
                "C01",
                parameters=[
                    parameter("title", "First value"),
                    parameter("title", "Second value"),
                ],
            )
        ],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters == []
    assert warning_codes(warnings) == ["conflicting_parameter_values"]
    assert "required" in warnings[0].message


def test_call2_conflicting_optional_parameter_is_invalidated():
    title = parameter()
    validated, warnings = validate_call2(
        [
            draft(
                "C01",
                parameters=[
                    title,
                    parameter("due", "Thursday"),
                    parameter("due", "Friday"),
                ],
            )
        ],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters == [title]
    assert warning_codes(warnings) == ["conflicting_parameter_values"]
    assert "optional" in warnings[0].message


def test_call2_bad_parameter_evidence_is_stripped():
    validated, warnings = validate_call2(
        [draft("C01", parameters=[parameter(evidence=["L99", "L02"])])],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters[0].evidence == ["L02"]
    assert warning_codes(warnings) == ["invalid_parameter_evidence_removed"]


def test_call2_parameter_with_no_valid_evidence_is_dropped():
    validated, warnings = validate_call2(
        [draft("C01", parameters=[parameter(evidence=["L99"])])],
        [candidate("C01")],
        transcript(),
    )

    assert validated[0].parameters == []
    assert warning_codes(warnings) == [
        "invalid_parameter_evidence_removed",
        "parameter_without_valid_evidence",
    ]


def test_call2_return_order_cannot_redefine_candidate_order():
    candidates = [candidate("C01"), candidate("C02"), candidate("C03")]

    validated, warnings = validate_call2(
        [draft("C03"), draft("C01"), draft("C02")],
        candidates,
        transcript(),
    )

    assert [item.candidate_id for item in validated] == ["C01", "C02", "C03"]
    assert warnings == []
