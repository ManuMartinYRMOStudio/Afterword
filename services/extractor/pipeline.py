"""Thin extraction-pipeline orchestration interface."""

from .models import ExtractionResult


def run_extraction(transcript_text: str, principal: str) -> ExtractionResult:
    raise NotImplementedError("Pipeline orchestration belongs to a later wave")
