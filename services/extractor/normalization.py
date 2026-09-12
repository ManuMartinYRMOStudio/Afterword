"""Transcript normalization interface."""

from .models import NormalizedTranscript


def normalize_transcript(raw_text: str) -> NormalizedTranscript:
    """Normalize raw speaker-labelled text into deterministic turns."""

    raise NotImplementedError("Transcript normalization belongs to a later wave")
