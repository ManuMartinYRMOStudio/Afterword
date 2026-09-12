"""Prompt-construction interfaces; this module performs no network calls."""

from .models import CommitmentCandidate, NormalizedTranscript


def build_discovery_prompt(transcript: NormalizedTranscript) -> str:
    """Build the capability-blind Call-1 commitment-discovery prompt."""

    raise NotImplementedError("Discovery prompt construction belongs to a later wave")


def build_resolution_prompt(
    transcript: NormalizedTranscript,
    principal: str,
    candidates: list[CommitmentCandidate],
) -> str:
    """Build the Call-2 capability and parameter-resolution prompt."""

    raise NotImplementedError("Resolution prompt construction belongs to a later wave")
