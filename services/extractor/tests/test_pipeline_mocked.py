"""Offline integration tests for the extraction pipeline orchestration."""

from __future__ import annotations

import socket
from unittest.mock import Mock

import openai
import pytest

from services.extractor import pipeline
from services.extractor.config import Settings
from services.extractor.derivation import canonicalize_execution, hash_execution
from services.extractor.models import (
    ActionType,
    Call1Commitment,
    Call1Response,
    Call2ActionDraft,
    Call2Response,
    CommitmentBasis,
    HoldReason,
    ParameterDraft,
    SupportLevel,
    ValidationWarning,
)
from services.extractor.normalization import normalize_transcript


TRANSCRIPT_TEXT = (
    "CLARA: I'll prepare the report.\n"
    "DAVID: I'll send the invoice."
)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any accidental model client or socket use is a test failure."""

    def forbidden(*_args, **_kwargs):
        raise AssertionError("pipeline unit tests must not touch the network")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(openai, "OpenAI", forbidden)


@pytest.fixture
def configured_settings(monkeypatch) -> Mock:
    loader = Mock(
        return_value=Settings(
            openai_api_key="test-api-key",
            engine_token=None,
            openai_model="settings-model",
        )
    )
    monkeypatch.setattr(pipeline, "load_settings", loader)
    return loader


def commitment(
    speaker: str = "CLARA",
    *,
    evidence: list[str] | None = None,
    effect: str = "prepare the report",
) -> Call1Commitment:
    return Call1Commitment(
        responsible_speakers=[speaker],
        intended_effect=effect,
        commitment_evidence=["L01"] if evidence is None else evidence,
        commitment_support=SupportLevel.EXPLICIT,
        commitment_basis=CommitmentBasis.SELF_COMMITMENT,
    )


def parameter(
    name: str = "title",
    value: str = "Prepare the report",
    *,
    evidence: list[str] | None = None,
    support: SupportLevel = SupportLevel.EXPLICIT,
) -> ParameterDraft:
    return ParameterDraft(
        name=name,
        value=value,
        evidence=["L01"] if evidence is None else evidence,
        support=support,
    )


def draft(
    candidate_id: str,
    *,
    title: str = "Prepare report",
    parameters: list[ParameterDraft] | None = None,
) -> Call2ActionDraft:
    return Call2ActionDraft(
        candidate_id=candidate_id,
        type=ActionType.TASK,
        title=title,
        summary="Prepare the promised report",
        parameters=[parameter()] if parameters is None else parameters,
    )


def install_model_outputs(
    monkeypatch,
    *,
    call1: Call1Response,
    call2: Call2Response | None = None,
) -> tuple[Mock, Mock]:
    discover = Mock(return_value=call1)
    if call2 is None:
        resolve = Mock(
            side_effect=AssertionError("Call 2 must be skipped for this extraction")
        )
    else:
        resolve = Mock(return_value=call2)
    monkeypatch.setattr(pipeline, "discover_commitments", discover)
    monkeypatch.setattr(pipeline, "resolve_candidates", resolve)
    return discover, resolve


def test_happy_path_runs_both_stages_with_settings_and_builds_integrity(
    monkeypatch, configured_settings
):
    discover, resolve = install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[
                commitment("DAVID", evidence=["L02"], effect="send the invoice"),
                commitment(),
            ]
        ),
        call2=Call2Response(actions=[draft("C02")]),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    transcript = normalize_transcript(TRANSCRIPT_TEXT)
    assert result.turns == transcript.turns
    assert [(action.id, action.title) for action in result.actions] == [
        ("a1", "Prepare report")
    ]
    assert result.total == len(result.actions) == 1
    assert result.warnings == []
    configured_settings.assert_called_once_with()

    discover.assert_called_once_with(
        transcript,
        model="settings-model",
        api_key="test-api-key",
    )
    resolve.assert_called_once()
    call2_args = resolve.call_args
    assert call2_args.args[0] == transcript
    assert call2_args.args[1] == "CLARA"
    assert [item.candidate_id for item in call2_args.args[2]] == ["C02"]
    assert call2_args.kwargs == {
        "model": "settings-model",
        "api_key": "test-api-key",
    }

    action = result.actions[0]
    canonical = canonicalize_execution(action.type, action.payload)
    assert set(result.execution_integrity) == {action.id}
    assert result.execution_integrity[action.id].canonical_execution == canonical
    assert result.execution_integrity[action.id].execution_sha256 == hash_execution(
        canonical
    )


def test_zero_call1_commitments_skips_call2_and_returns_valid_empty_result(
    monkeypatch, configured_settings
):
    _discover, resolve = install_model_outputs(
        monkeypatch,
        call1=Call1Response(commitments=[]),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    resolve.assert_not_called()
    assert result.turns == normalize_transcript(TRANSCRIPT_TEXT).turns
    assert result.actions == []
    assert result.execution_integrity == {}
    assert result.warnings == []
    assert result.total == len(result.actions) == 0


def test_other_speakers_commitments_skip_call2_and_return_valid_empty_result(
    monkeypatch, configured_settings
):
    _discover, resolve = install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[
                commitment("DAVID", evidence=["L02"], effect="send the invoice")
            ]
        ),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    resolve.assert_not_called()
    assert result.actions == []
    assert result.execution_integrity == {}
    assert result.total == len(result.actions) == 0


def test_principal_must_be_an_exact_speaker_before_settings_or_model_calls(
    monkeypatch, configured_settings
):
    discover = Mock(side_effect=AssertionError("Call 1 must not run"))
    monkeypatch.setattr(pipeline, "discover_commitments", discover)

    with pytest.raises(ValueError, match="Principal.*exact speaker"):
        pipeline.run_extraction(TRANSCRIPT_TEXT, "clara")

    configured_settings.assert_not_called()
    discover.assert_not_called()


def test_missing_openai_key_fails_before_discovery(monkeypatch):
    monkeypatch.setattr(
        pipeline,
        "load_settings",
        Mock(
            return_value=Settings(
                openai_api_key=None,
                engine_token=None,
                openai_model="settings-model",
            )
        ),
    )
    discover = Mock(side_effect=AssertionError("Call 1 must not run"))
    monkeypatch.setattr(pipeline, "discover_commitments", discover)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    discover.assert_not_called()


def test_missing_call2_candidate_warns_without_fabricating_an_action(
    monkeypatch, configured_settings
):
    _discover, resolve = install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[
                commitment(effect="prepare the report"),
                commitment(effect="review the report"),
            ]
        ),
        call2=Call2Response(actions=[draft("C02", title="Review report")]),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    resolve.assert_called_once()
    assert [(action.id, action.title) for action in result.actions] == [
        ("a1", "Review report")
    ]
    assert [warning.code for warning in result.warnings] == [
        "missing_candidate_resolution"
    ]
    assert result.warnings[0].candidate_id == "C01"
    assert result.total == len(result.actions) == 1


def test_invalid_call1_evidence_is_filtered_and_warnings_survive_empty_result(
    monkeypatch, configured_settings
):
    _discover, resolve = install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[commitment(evidence=["L99"])],
        ),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    resolve.assert_not_called()
    assert result.actions == []
    assert result.execution_integrity == {}
    assert [warning.code for warning in result.warnings] == [
        "invalid_commitment_evidence_removed",
        "no_valid_commitment_evidence",
    ]
    assert result.total == len(result.actions) == 0


def test_required_parameter_removed_by_validation_becomes_null_and_held(
    monkeypatch, configured_settings
):
    install_model_outputs(
        monkeypatch,
        call1=Call1Response(commitments=[commitment()]),
        call2=Call2Response(
            actions=[draft("C01", parameters=[parameter(evidence=["L99"])])]
        ),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    action = result.actions[0]
    assert action.payload == {"title": None}
    assert action.parameter_evidence["title"].evidence == []
    assert action.parameter_evidence["title"].support is None
    assert action.hold_reason is HoldReason.MISSING_REQUIRED_PARAMETER
    assert action.auto_execute is False
    assert [warning.code for warning in result.warnings] == [
        "invalid_parameter_evidence_removed",
        "parameter_without_valid_evidence",
    ]
    assert result.total == len(result.actions) == 1


def test_call2_return_order_cannot_change_call1_action_order(
    monkeypatch, configured_settings
):
    install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[
                commitment(effect="prepare the report"),
                commitment(effect="review the report"),
            ]
        ),
        call2=Call2Response(
            actions=[
                draft("C02", title="Second action"),
                draft("C01", title="First action"),
            ]
        ),
    )

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    assert [(action.id, action.title) for action in result.actions] == [
        ("a1", "First action"),
        ("a2", "Second action"),
    ]
    assert set(result.execution_integrity) == {"a1", "a2"}
    for action in result.actions:
        integrity = result.execution_integrity[action.id]
        canonical = canonicalize_execution(action.type, action.payload)
        assert integrity.canonical_execution == canonical
        assert integrity.execution_sha256 == hash_execution(canonical)
    assert result.total == len(result.actions) == 2


def test_warnings_from_all_stages_are_preserved_in_stage_order(
    monkeypatch, configured_settings
):
    install_model_outputs(
        monkeypatch,
        call1=Call1Response(
            commitments=[commitment(evidence=["L99", "L01"])],
        ),
        call2=Call2Response(
            actions=[
                draft(
                    "C01",
                    parameters=[parameter(evidence=["L99", "L01"])],
                )
            ]
        ),
    )
    real_build = pipeline.build_resolved_actions

    def build_with_warning(candidates, drafts):
        actions, warnings = real_build(candidates, drafts)
        return actions, [
            *warnings,
            ValidationWarning(
                stage="derivation",
                code="derivation_warning",
                message="Synthetic derivation warning for orchestration coverage.",
            ),
        ]

    monkeypatch.setattr(pipeline, "build_resolved_actions", build_with_warning)

    result = pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    assert [warning.stage for warning in result.warnings] == [
        "call1",
        "call2",
        "derivation",
    ]
    assert [warning.code for warning in result.warnings] == [
        "invalid_commitment_evidence_removed",
        "invalid_parameter_evidence_removed",
        "derivation_warning",
    ]


def test_model_stage_failures_propagate(monkeypatch, configured_settings):
    failure = RuntimeError("model stage failed")
    discover = Mock(side_effect=failure)
    monkeypatch.setattr(pipeline, "discover_commitments", discover)

    with pytest.raises(RuntimeError, match="model stage failed") as raised:
        pipeline.run_extraction(TRANSCRIPT_TEXT, "CLARA")

    assert raised.value is failure
