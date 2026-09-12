"""Offline tests for the staged live-evaluation runner."""

from __future__ import annotations

import socket
from unittest.mock import Mock

import openai
import pytest

from services.extractor.config import Settings
from services.extractor.models import (
    ActionType,
    Call1Commitment,
    Call1Response,
    Call2ActionDraft,
    Call2Response,
    CommitmentBasis,
    ParameterDraft,
    SupportLevel,
)
from services.extractor.scripts import run_live_eval


TRANSCRIPT_TEXT = "CLARA: I'll prepare the report.\nDAVID: Thanks.\n"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any accidental OpenAI client or socket use is a test failure."""

    def forbidden(*_args, **_kwargs):
        raise AssertionError("live-eval unit tests must not touch the network")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(openai, "OpenAI", forbidden)


def _settings(model: str = "settings-model") -> Settings:
    return Settings(
        openai_api_key="test-api-key",
        engine_token=None,
        openai_model=model,
    )


def _commitment(speaker: str = "CLARA") -> Call1Commitment:
    return Call1Commitment(
        responsible_speakers=[speaker],
        intended_effect="prepare the report",
        commitment_evidence=["L01"],
        commitment_support=SupportLevel.EXPLICIT,
        commitment_basis=CommitmentBasis.SELF_COMMITMENT,
    )


def _section_labels(output: str) -> list[str]:
    return [line for line in output.splitlines() if line.startswith("=== ")]


def test_runner_prints_every_stage_and_uses_model_override(
    monkeypatch, tmp_path, capsys
):
    transcript_file = tmp_path / "transcript.txt"
    transcript_file.write_text(TRANSCRIPT_TEXT, encoding="utf-8")

    discover = Mock(return_value=Call1Response(commitments=[_commitment()]))
    resolve = Mock(
        return_value=Call2Response(
            actions=[
                Call2ActionDraft(
                    candidate_id="C01",
                    type=ActionType.TASK,
                    title="Prepare report",
                    summary="Prepare the promised report",
                    parameters=[
                        ParameterDraft(
                            name="title",
                            value="Prepare the report",
                            evidence=["L01"],
                            support=SupportLevel.EXPLICIT,
                        )
                    ],
                )
            ]
        )
    )
    monkeypatch.setattr(run_live_eval, "load_settings", Mock(return_value=_settings()))
    monkeypatch.setattr(run_live_eval, "discover_commitments", discover)
    monkeypatch.setattr(run_live_eval, "resolve_candidates", resolve)

    result = run_live_eval.main(
        [
            "--file",
            str(transcript_file),
            "--principal",
            "CLARA",
            "--model",
            "override-model",
        ]
    )

    assert result == 0
    output = capsys.readouterr().out
    assert _section_labels(output) == [
        "=== RUN CONFIG ===",
        "=== NORMALIZED ===",
        "=== CALL1 RAW ===",
        "=== CALL1 VALIDATED ===",
        "=== CANDIDATES WITH IDS ===",
        "=== PRINCIPAL CANDIDATES ===",
        "=== CALL2 RAW ===",
        "=== CALL2 VALIDATED ===",
        "=== FINAL ACTIONS ===",
        "=== EXECUTION INTEGRITY ===",
        "=== WARNINGS ===",
    ]
    assert '"model": "override-model"' in output
    assert '"candidate_id": "C01"' in output
    assert '"canonical_execution"' in output
    assert '"execution_sha256"' in output

    discover.assert_called_once()
    assert discover.call_args.kwargs == {
        "model": "override-model",
        "api_key": "test-api-key",
    }
    resolve.assert_called_once()
    assert resolve.call_args.kwargs == {
        "model": "override-model",
        "api_key": "test-api-key",
    }


def test_runner_skips_call2_when_no_candidates_belong_to_principal(
    monkeypatch, tmp_path, capsys
):
    transcript_file = tmp_path / "transcript.txt"
    transcript_file.write_text(TRANSCRIPT_TEXT, encoding="utf-8")

    discover = Mock(return_value=Call1Response(commitments=[_commitment("DAVID")]))
    resolve = Mock(side_effect=AssertionError("Call 2 must be skipped"))
    monkeypatch.setattr(
        run_live_eval,
        "load_settings",
        Mock(return_value=_settings("default-model")),
    )
    monkeypatch.setattr(run_live_eval, "discover_commitments", discover)
    monkeypatch.setattr(run_live_eval, "resolve_candidates", resolve)

    result = run_live_eval.main(
        ["--file", str(transcript_file), "--principal", "CLARA"]
    )

    assert result == 0
    output = capsys.readouterr().out
    assert '"model": "default-model"' in output
    assert output.count('"skipped": true') == 2
    assert '"reason": "no principal-owned candidates"' in output
    assert '"execution_sha256"' not in output
    discover.assert_called_once()
    resolve.assert_not_called()
