"""Run one transcript through the live extractor with staged JSON output."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from services.extractor.config import load_settings
from services.extractor.derivation import (
    build_resolved_actions,
    canonicalize_execution,
    hash_execution,
)
from services.extractor.llm import discover_commitments, resolve_candidates
from services.extractor.models import ExecutionIntegrity
from services.extractor.normalization import normalize_transcript
from services.extractor.validation import (
    assign_candidate_ids,
    filter_principal,
    validate_call1,
    validate_call2,
)


def _model_list(items: Sequence[Any]) -> list[dict[str, Any]]:
    return [item.model_dump(mode="json") for item in items]


def _print_section(label: str, value: Any) -> None:
    print(f"=== {label} ===")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _print_empty_downstream(reason: str) -> None:
    skipped = {"skipped": True, "reason": reason}
    _print_section("CALL1 RAW", skipped)
    _print_section(
        "CALL1 VALIDATED",
        {"skipped": True, "reason": reason, "commitments": [], "warnings": []},
    )
    _print_section("CANDIDATES WITH IDS", [])
    _print_section("PRINCIPAL CANDIDATES", [])
    _print_section("CALL2 RAW", skipped)
    _print_section(
        "CALL2 VALIDATED",
        {"skipped": True, "reason": reason, "drafts": [], "warnings": []},
    )
    _print_section("FINAL ACTIONS", [])
    _print_section("EXECUTION INTEGRITY", {})
    _print_section("WARNINGS", [])


def run_live_eval(
    transcript_text: str,
    principal: str,
    *,
    model: str | None = None,
) -> None:
    """Run the real extraction stages once and print every diagnostic boundary."""

    transcript = normalize_transcript(transcript_text)
    settings = load_settings()
    effective_model = model or settings.openai_model

    _print_section(
        "RUN CONFIG",
        {"principal": principal, "model": effective_model},
    )
    _print_section("NORMALIZED", transcript.model_dump(mode="json"))

    if principal not in transcript.speakers:
        _print_empty_downstream("principal is not a normalized transcript speaker")
        return

    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required to run live evaluation")

    call1 = discover_commitments(
        transcript,
        model=effective_model,
        api_key=settings.openai_api_key,
    )
    _print_section("CALL1 RAW", call1.model_dump(mode="json"))

    validated_commitments, call1_warnings = validate_call1(
        call1.commitments,
        transcript,
    )
    _print_section(
        "CALL1 VALIDATED",
        {
            "commitments": _model_list(validated_commitments),
            "warnings": _model_list(call1_warnings),
        },
    )

    candidates = assign_candidate_ids(validated_commitments)
    _print_section("CANDIDATES WITH IDS", _model_list(candidates))

    principal_candidates = filter_principal(candidates, principal)
    _print_section("PRINCIPAL CANDIDATES", _model_list(principal_candidates))

    if not principal_candidates:
        reason = "no principal-owned candidates"
        _print_section("CALL2 RAW", {"skipped": True, "reason": reason})
        _print_section(
            "CALL2 VALIDATED",
            {"skipped": True, "reason": reason, "drafts": [], "warnings": []},
        )
        _print_section("FINAL ACTIONS", [])
        _print_section("EXECUTION INTEGRITY", {})
        _print_section("WARNINGS", _model_list(call1_warnings))
        return

    call2 = resolve_candidates(
        transcript,
        principal,
        principal_candidates,
        model=effective_model,
        api_key=settings.openai_api_key,
    )
    _print_section("CALL2 RAW", call2.model_dump(mode="json"))

    validated_drafts, call2_warnings = validate_call2(
        call2.actions,
        principal_candidates,
        transcript,
    )
    _print_section(
        "CALL2 VALIDATED",
        {
            "drafts": _model_list(validated_drafts),
            "warnings": _model_list(call2_warnings),
        },
    )

    actions, derivation_warnings = build_resolved_actions(
        principal_candidates,
        validated_drafts,
    )
    _print_section("FINAL ACTIONS", _model_list(actions))

    execution_integrity: dict[str, ExecutionIntegrity] = {}
    for action in actions:
        canonical = canonicalize_execution(action.type, action.payload)
        execution_integrity[action.id] = ExecutionIntegrity(
            canonical_execution=canonical,
            execution_sha256=hash_execution(canonical),
        )

    if set(execution_integrity) != {action.id for action in actions}:
        raise RuntimeError("Execution integrity does not cover every emitted action")

    _print_section(
        "EXECUTION INTEGRITY",
        {
            action_id: integrity.model_dump(mode="json")
            for action_id, integrity in execution_integrity.items()
        },
    )
    _print_section(
        "WARNINGS",
        _model_list([*call1_warnings, *call2_warnings, *derivation_warnings]),
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run exactly one transcript through the live extractor and print staged JSON."
        )
    )
    parser.add_argument("--file", required=True, type=Path, help="Transcript text file")
    parser.add_argument("--principal", required=True, help="Exact normalized speaker name")
    parser.add_argument(
        "--model",
        help="OpenAI model override (defaults to Settings.openai_model)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        transcript_text = args.file.read_text(encoding="utf-8-sig")
    except OSError as error:
        parser.error(f"could not read transcript file {args.file}: {error}")

    run_live_eval(
        transcript_text,
        args.principal,
        model=args.model,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
