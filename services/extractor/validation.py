"""Deterministic validation interfaces."""

from .models import Call1Commitment, Call2ActionDraft, CommitmentCandidate
from .models import NormalizedTranscript, ValidationWarning


def validate_call1(
    commitments: list[Call1Commitment], transcript: NormalizedTranscript
) -> tuple[list[Call1Commitment], list[ValidationWarning]]:
    raise NotImplementedError("Call-1 validation belongs to a later wave")


def assign_candidate_ids(
    commitments: list[Call1Commitment],
) -> list[CommitmentCandidate]:
    raise NotImplementedError("Candidate ID assignment belongs to a later wave")


def filter_principal(
    candidates: list[CommitmentCandidate], principal: str
) -> list[CommitmentCandidate]:
    raise NotImplementedError("Principal filtering belongs to a later wave")


def validate_call2(
    drafts: list[Call2ActionDraft],
    candidates: list[CommitmentCandidate],
    transcript: NormalizedTranscript,
) -> tuple[list[Call2ActionDraft], list[ValidationWarning]]:
    raise NotImplementedError("Call-2 validation belongs to a later wave")
