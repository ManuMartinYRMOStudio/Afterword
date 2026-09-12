"""Deterministic structural validation for model-produced stage outputs."""

from .action_specs import ACTION_SPECS
from .models import Call1Commitment, Call2ActionDraft, CommitmentCandidate
from .models import NormalizedTranscript, ValidationWarning


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
    raise NotImplementedError("Call-2 validation belongs to a later wave")
