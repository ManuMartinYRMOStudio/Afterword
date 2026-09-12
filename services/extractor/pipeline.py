"""Thin extraction-pipeline orchestration interface."""

from .config import load_settings
from .derivation import (
    build_resolved_actions,
    canonicalize_execution,
    hash_execution,
)
from .llm import discover_commitments, resolve_candidates
from .models import ExecutionIntegrity, ExtractionResult
from .normalization import normalize_transcript
from .validation import (
    assign_candidate_ids,
    filter_principal,
    validate_call1,
    validate_call2,
)


def run_extraction(transcript_text: str, principal: str) -> ExtractionResult:
    """Run the frozen two-stage extraction pipeline for one principal."""

    transcript = normalize_transcript(transcript_text)
    if principal not in transcript.speakers:
        raise ValueError(
            f"Principal {principal!r} is not an exact speaker in the transcript"
        )

    settings = load_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required to run extraction")

    call1 = discover_commitments(
        transcript,
        model=settings.openai_model,
        api_key=settings.openai_api_key,
    )
    validated_commitments, call1_warnings = validate_call1(
        call1.commitments,
        transcript,
    )
    candidates = assign_candidate_ids(validated_commitments)
    principal_candidates = filter_principal(candidates, principal)

    if not principal_candidates:
        return ExtractionResult(
            turns=transcript.turns,
            actions=[],
            execution_integrity={},
            warnings=call1_warnings,
            total=0,
        )

    call2 = resolve_candidates(
        transcript,
        principal,
        principal_candidates,
        model=settings.openai_model,
        api_key=settings.openai_api_key,
    )
    validated_drafts, call2_warnings = validate_call2(
        call2.actions,
        principal_candidates,
        transcript,
    )
    actions, derivation_warnings = build_resolved_actions(
        principal_candidates,
        validated_drafts,
    )

    execution_integrity = {}
    for action in actions:
        canonical = canonicalize_execution(action.type, action.payload)
        execution_integrity[action.id] = ExecutionIntegrity(
            canonical_execution=canonical,
            execution_sha256=hash_execution(canonical),
        )

    if set(execution_integrity) != {action.id for action in actions}:
        raise RuntimeError("Execution integrity does not cover every emitted action")

    return ExtractionResult(
        turns=transcript.turns,
        actions=actions,
        execution_integrity=execution_integrity,
        warnings=[*call1_warnings, *call2_warnings, *derivation_warnings],
        total=len(actions),
    )
