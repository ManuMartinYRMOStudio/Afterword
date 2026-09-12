"""Deterministic structural validation for model-produced stage outputs."""

from .action_specs import ACTION_SPECS
from .models import Call1Commitment, Call2ActionDraft, CommitmentCandidate
from .models import NormalizedTranscript, ParameterDraft, ValidationWarning


def _warning(
    stage: str,
    code: str,
    message: str,
    candidate_id: str | None = None,
) -> ValidationWarning:
    return ValidationWarning(
        stage=stage,
        code=code,
        message=message,
        candidate_id=candidate_id,
    )


def validate_call1(
    commitments: list[Call1Commitment], transcript: NormalizedTranscript
) -> tuple[list[Call1Commitment], list[ValidationWarning]]:
    """Validate Call-1 structure without reinterpreting model semantics."""

    known_speakers = set(transcript.speakers)
    known_turn_ids = {turn.id for turn in transcript.turns}
    validated: list[Call1Commitment] = []
    warnings: list[ValidationWarning] = []

    for position, commitment in enumerate(commitments, start=1):
        label = f"Call-1 commitment at position {position}"
        speakers = [
            speaker
            for speaker in commitment.responsible_speakers
            if speaker in known_speakers
        ]
        if len(speakers) != len(commitment.responsible_speakers):
            warnings.append(
                _warning(
                    "call1",
                    "unknown_speaker_removed",
                    f"{label}: removed unknown responsible speaker(s).",
                )
            )
        if not speakers:
            warnings.append(
                _warning(
                    "call1",
                    "no_valid_responsible_speaker",
                    f"{label}: dropped because no responsible speaker exists in the transcript.",
                )
            )
            continue

        evidence = [
            turn_id
            for turn_id in commitment.commitment_evidence
            if turn_id in known_turn_ids
        ]
        if len(evidence) != len(commitment.commitment_evidence):
            warnings.append(
                _warning(
                    "call1",
                    "invalid_commitment_evidence_removed",
                    f"{label}: removed commitment evidence ID(s) not found in the transcript.",
                )
            )
        if not evidence:
            warnings.append(
                _warning(
                    "call1",
                    "no_valid_commitment_evidence",
                    f"{label}: dropped because no commitment evidence exists in the transcript.",
                )
            )
            continue

        if not commitment.intended_effect.strip():
            warnings.append(
                _warning(
                    "call1",
                    "empty_intended_effect",
                    f"{label}: dropped because intended_effect is empty.",
                )
            )
            continue

        validated.append(
            commitment.model_copy(
                update={
                    "responsible_speakers": speakers,
                    "commitment_evidence": evidence,
                }
            )
        )

    return validated, warnings


def assign_candidate_ids(
    commitments: list[Call1Commitment],
) -> list[CommitmentCandidate]:
    """Assign positional IDs after Call-1 validation."""

    return [
        CommitmentCandidate(
            candidate_id=f"C{position:02d}",
            **commitment.model_dump(),
        )
        for position, commitment in enumerate(commitments, start=1)
    ]


def filter_principal(
    candidates: list[CommitmentCandidate], principal: str
) -> list[CommitmentCandidate]:
    """Keep only candidates explicitly owned by the configured principal."""

    return [
        candidate
        for candidate in candidates
        if principal in candidate.responsible_speakers
    ]


def validate_call2(
    drafts: list[Call2ActionDraft],
    candidates: list[CommitmentCandidate],
    transcript: NormalizedTranscript,
) -> tuple[list[Call2ActionDraft], list[ValidationWarning]]:
    """Validate and order Call-2 drafts by their original Call-1 candidates."""

    expected_ids = {candidate.candidate_id for candidate in candidates}
    drafts_by_candidate: dict[str, list[Call2ActionDraft]] = {
        candidate.candidate_id: [] for candidate in candidates
    }
    warnings: list[ValidationWarning] = []

    for draft in drafts:
        if draft.candidate_id not in expected_ids:
            warnings.append(
                _warning(
                    "call2",
                    "unknown_candidate_id",
                    (
                        f"Dropped Call-2 resolution for unknown candidate "
                        f"{draft.candidate_id}."
                    ),
                    draft.candidate_id,
                )
            )
            continue
        drafts_by_candidate[draft.candidate_id].append(draft)

    known_turn_ids = {turn.id for turn in transcript.turns}
    validated: list[Call2ActionDraft] = []

    for candidate in candidates:
        candidate_id = candidate.candidate_id
        candidate_drafts = drafts_by_candidate[candidate_id]
        if not candidate_drafts:
            warnings.append(
                _warning(
                    "call2",
                    "missing_candidate_resolution",
                    f"No Call-2 resolution was returned for {candidate_id}.",
                    candidate_id,
                )
            )
            continue

        draft = candidate_drafts[0]
        if len(candidate_drafts) > 1:
            if all(item == draft for item in candidate_drafts[1:]):
                warnings.append(
                    _warning(
                        "call2",
                        "duplicate_candidate_collapsed",
                        (
                            f"Collapsed {len(candidate_drafts)} identical Call-2 "
                            f"resolutions for {candidate_id}."
                        ),
                        candidate_id,
                    )
                )
            else:
                warnings.append(
                    _warning(
                        "call2",
                        "conflicting_candidate_resolutions",
                        (
                            f"Invalidated {candidate_id} because Call 2 returned "
                            "materially conflicting resolutions."
                        ),
                        candidate_id,
                    )
                )
                continue

        parameters = _validate_parameters(draft, known_turn_ids, warnings)
        validated.append(draft.model_copy(update={"parameters": parameters}))

    return validated, warnings


def _validate_parameters(
    draft: Call2ActionDraft,
    known_turn_ids: set[str],
    warnings: list[ValidationWarning],
) -> list[ParameterDraft]:
    """Validate one action draft's parameters, retaining model order."""

    spec = ACTION_SPECS[draft.type]
    legal_names = set(spec.required) | set(spec.optional)
    parameters_by_name: dict[str, list[ParameterDraft]] = {}

    for parameter in draft.parameters:
        if parameter.name not in legal_names:
            warnings.append(
                _warning(
                    "call2",
                    "illegal_parameter_name",
                    (
                        f"Dropped illegal parameter {parameter.name!r} for "
                        f"{draft.type.value} candidate {draft.candidate_id}."
                    ),
                    draft.candidate_id,
                )
            )
            continue
        parameters_by_name.setdefault(parameter.name, []).append(parameter)

    validated: list[ParameterDraft] = []
    for name, duplicates in parameters_by_name.items():
        parameter = duplicates[0]
        if len(duplicates) > 1:
            if all(item == parameter for item in duplicates[1:]):
                warnings.append(
                    _warning(
                        "call2",
                        "duplicate_parameter_collapsed",
                        (
                            f"Collapsed {len(duplicates)} identical {name!r} "
                            f"parameters for {draft.candidate_id}."
                        ),
                        draft.candidate_id,
                    )
                )
            else:
                requirement = "required" if name in spec.required else "optional"
                warnings.append(
                    _warning(
                        "call2",
                        "conflicting_parameter_values",
                        (
                            f"Invalidated conflicting {requirement} parameter "
                            f"{name!r} for {draft.candidate_id}."
                        ),
                        draft.candidate_id,
                    )
                )
                continue

        evidence = [turn_id for turn_id in parameter.evidence if turn_id in known_turn_ids]
        if len(evidence) != len(parameter.evidence):
            warnings.append(
                _warning(
                    "call2",
                    "invalid_parameter_evidence_removed",
                    (
                        f"Removed unknown evidence ID(s) from parameter {name!r} "
                        f"for {draft.candidate_id}."
                    ),
                    draft.candidate_id,
                )
            )
        if not evidence:
            warnings.append(
                _warning(
                    "call2",
                    "parameter_without_valid_evidence",
                    (
                        f"Dropped parameter {name!r} for {draft.candidate_id} "
                        "because no evidence exists in the transcript."
                    ),
                    draft.candidate_id,
                )
            )
            continue

        validated.append(parameter.model_copy(update={"evidence": evidence}))

    return validated
