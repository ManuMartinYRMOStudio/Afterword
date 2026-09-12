"""Resolved-action and execution-integrity derivation interfaces."""

from .models import ActionType, Call2ActionDraft, CommitmentCandidate, ResolvedAction
from .models import ValidationWarning


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
