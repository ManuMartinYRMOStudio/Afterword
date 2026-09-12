"""Direct model-call interfaces; no client is created at import time."""

from .models import (
    Call1Response,
    Call2Response,
    CommitmentCandidate,
    NormalizedTranscript,
)


def discover_commitments(
    transcript: NormalizedTranscript,
    *,
    model: str,
    api_key: str,
) -> Call1Response:
    """Run the single batched commitment-discovery model call."""

    raise NotImplementedError("OpenAI calls belong to a later wave")


def resolve_candidates(
    transcript: NormalizedTranscript,
    principal: str,
    candidates: list[CommitmentCandidate],
    *,
    model: str,
    api_key: str,
) -> Call2Response:
    """Run the single batched capability-resolution model call."""

    raise NotImplementedError("OpenAI calls belong to a later wave")
