"""Foundation contract tests for Wave 0."""

from __future__ import annotations

import importlib
import socket
import sys

import openai
import pytest
from pydantic import ValidationError

from services.extractor.action_specs import (
    ACTION_SPECS,
    REVERSIBILITY,
    SUPPORT_ORDER,
    SUPPORT_TO_CONFIDENCE,
)
from services.extractor.config import DEFAULT_LOG_LEVEL, DEFAULT_OPENAI_MODEL, DEFAULT_PORT
from services.extractor.config import load_settings
from services.extractor.models import (
    ActionType,
    Call1Commitment,
    Call1Response,
    Call2ActionDraft,
    Call2Response,
    CommitmentBasis,
    ExecutionIntegrity,
    ExtractionResult,
    HoldReason,
    ResolvedAction,
    SupportLevel,
)


@pytest.mark.parametrize(
    ("enum_type", "values"),
    [
        (SupportLevel, ["explicit", "contextual", "weak"]),
        (
            CommitmentBasis,
            ["self_commitment", "accepted_request", "explicit_assignment", "group_commitment"],
        ),
        (
            ActionType,
            ["calendar_event", "task", "note", "email", "listing_publish", "unknown"],
        ),
        (
            HoldReason,
            ["irreversible_type", "unknown_type", "missing_required_parameter"],
        ),
    ],
)
def test_enums_accept_all_valid_values(enum_type, values):
    assert [enum_type(value).value for value in values] == values


@pytest.mark.parametrize(
    "enum_type", [SupportLevel, CommitmentBasis, ActionType, HoldReason]
)
def test_enums_reject_invalid_values(enum_type):
    with pytest.raises(ValueError):
        enum_type("not_valid")


def test_action_specs_match_frozen_matrix():
    assert set(ACTION_SPECS) == set(ActionType)
    assert {
        action_type: (spec.required, spec.optional)
        for action_type, spec in ACTION_SPECS.items()
    } == {
        ActionType.CALENDAR_EVENT: (("title", "datetime"), ("attendees",)),
        ActionType.TASK: (("title",), ("due",)),
        ActionType.NOTE: (("body",), ("record",)),
        ActionType.EMAIL: (("to", "subject", "body"), ()),
        ActionType.LISTING_PUBLISH: (("property_ref", "price"), ()),
        ActionType.UNKNOWN: (("description",), ()),
    }


def test_reversibility_matches_frozen_mapping():
    assert dict(REVERSIBILITY) == {
        ActionType.CALENDAR_EVENT: True,
        ActionType.TASK: True,
        ActionType.NOTE: True,
        ActionType.EMAIL: False,
        ActionType.LISTING_PUBLISH: False,
        ActionType.UNKNOWN: None,
    }


def test_support_order_and_confidence_are_frozen():
    assert SUPPORT_ORDER[SupportLevel.WEAK] < SUPPORT_ORDER[SupportLevel.CONTEXTUAL]
    assert SUPPORT_ORDER[SupportLevel.CONTEXTUAL] < SUPPORT_ORDER[SupportLevel.EXPLICIT]
    assert dict(SUPPORT_TO_CONFIDENCE) == {
        SupportLevel.EXPLICIT: 1.0,
        SupportLevel.CONTEXTUAL: 0.6,
        SupportLevel.WEAK: 0.3,
    }


def test_settings_defaults_and_missing_secrets_are_import_safe():
    settings = load_settings({})
    assert settings.openai_api_key is None
    assert settings.engine_token is None
    assert settings.openai_model == DEFAULT_OPENAI_MODEL == "gpt-5.6-sol"
    assert settings.log_level == DEFAULT_LOG_LEVEL == "INFO"
    assert settings.port == DEFAULT_PORT == 8080


def test_settings_use_frozen_environment_names():
    settings = load_settings(
        {
            "OPENAI_API_KEY": "test-openai-key",
            "ENGINE_TOKEN": "test-engine-token",
            "OPENAI_MODEL": "test-model",
            "LOG_LEVEL": "DEBUG",
            "PORT": "9090",
        }
    )
    assert settings.openai_api_key == "test-openai-key"
    assert settings.engine_token == "test-engine-token"
    assert settings.openai_model == "test-model"
    assert settings.log_level == "DEBUG"
    assert settings.port == 9090


def test_call1_response_parses_representative_object():
    parsed = Call1Response.model_validate(
        {
            "commitments": [
                {
                    "responsible_speakers": ["CLARA"],
                    "intended_effect": "send the listing agreement",
                    "commitment_evidence": ["L03"],
                    "commitment_support": "explicit",
                    "commitment_basis": "self_commitment",
                }
            ]
        }
    )
    assert parsed.commitments[0].commitment_support is SupportLevel.EXPLICIT


def test_call2_response_parses_representative_object():
    parsed = Call2Response.model_validate(
        {
            "actions": [
                {
                    "candidate_id": "C01",
                    "type": "task",
                    "title": "Pull comparable sales",
                    "summary": "Research recent sales",
                    "parameters": [
                        {
                            "name": "title",
                            "value": "Pull last two comparable sales",
                            "evidence": ["L07"],
                            "support": "explicit",
                        }
                    ],
                }
            ]
        }
    )
    assert parsed.actions[0].type is ActionType.TASK


def test_resolved_action_parses_frozen_contract_example():
    parsed = ResolvedAction.model_validate(
        {
            "id": "a4",
            "type": "email",
            "title": "Send listing agreement",
            "summary": "3% + VAT, 90 days exclusive",
            "payload": {
                "to": "david.whitmore@example.com",
                "subject": "Listing agreement - Ruzafa",
                "body": "3% + VAT, 90 days exclusive",
            },
            "action_evidence": ["L03"],
            "action_support": "explicit",
            "parameter_evidence": {
                "to": {"evidence": ["L05"], "support": "explicit"},
                "subject": {"evidence": ["L01", "L03"], "support": "contextual"},
                "body": {"evidence": ["L03"], "support": "weak"},
            },
            "support": "weak",
            "confidence": 0.3,
            "auto_execute": False,
            "hold_reason": "irreversible_type",
        }
    )
    assert parsed.hold_reason is HoldReason.IRREVERSIBLE_TYPE


def test_execution_integrity_parses_valid_object():
    parsed = ExecutionIntegrity.model_validate(
        {
            "canonical_execution": '{"payload":{"title":"Pull comparables"},"type":"task"}',
            "execution_sha256": "a" * 64,
        }
    )
    assert parsed.execution_sha256 == "a" * 64


def test_extraction_result_accepts_integrity_keyed_by_action_id():
    parsed = ExtractionResult.model_validate(
        {
            "turns": [{"id": "L01", "speaker": "CLARA", "text": "I'll do it."}],
            "actions": [
                {
                    "id": "a1",
                    "type": "task",
                    "title": "Pull comparables",
                    "summary": "Research recent comparable sales",
                    "payload": {"title": "Pull comparable sales"},
                    "action_evidence": ["L01"],
                    "action_support": "explicit",
                    "parameter_evidence": {
                        "title": {"evidence": ["L01"], "support": "explicit"}
                    },
                    "support": "explicit",
                    "confidence": 1.0,
                    "auto_execute": True,
                    "hold_reason": None,
                }
            ],
            "execution_integrity": {
                "a1": {
                    "canonical_execution": (
                        '{"payload":{"title":"Pull comparable sales"},"type":"task"}'
                    ),
                    "execution_sha256": "b" * 64,
                }
            },
            "warnings": [],
            "total": 1,
        }
    )
    assert parsed.execution_integrity["a1"].execution_sha256 == "b" * 64


def test_resolved_action_excludes_execution_integrity_fields():
    forbidden = {"canonical_execution", "execution_sha256", "execution_integrity"}
    assert forbidden.isdisjoint(ResolvedAction.model_fields)


def test_call1_has_no_derived_or_execution_authority_fields():
    forbidden = {
        "type", "reversible", "auto_execute", "hold_reason", "support", "confidence",
        "payload", "canonical_execution", "execution_sha256", "execution_integrity",
        "execution_hash",
    }
    assert forbidden.isdisjoint(Call1Commitment.model_fields)
    with pytest.raises(ValidationError):
        Call1Commitment.model_validate(
            {
                "responsible_speakers": ["CLARA"],
                "intended_effect": "send an agreement",
                "commitment_evidence": ["L03"],
                "commitment_support": "explicit",
                "commitment_basis": "self_commitment",
                "auto_execute": True,
            }
        )


def test_call2_has_no_discovery_derived_or_execution_authority_fields():
    forbidden = {
        "responsible_speakers", "action_evidence", "commitment_basis", "intended_effect",
        "reversible", "auto_execute", "hold_reason", "support", "confidence",
        "canonical_execution", "execution_sha256", "execution_integrity", "execution_hash",
    }
    assert forbidden.isdisjoint(Call2ActionDraft.model_fields)
    with pytest.raises(ValidationError):
        Call2ActionDraft.model_validate(
            {
                "candidate_id": "C01",
                "type": "task",
                "title": "Pull comparables",
                "summary": "Research recent sales",
                "parameters": [],
                "auto_execute": True,
            }
        )


def test_all_modules_import_without_calls_or_required_secrets(monkeypatch):
    module_names = [
        "services.extractor.models",
        "services.extractor.action_specs",
        "services.extractor.config",
        "services.extractor.normalization",
        "services.extractor.prompts",
        "services.extractor.llm",
        "services.extractor.validation",
        "services.extractor.derivation",
        "services.extractor.pipeline",
        "services.extractor.app",
    ]
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ENGINE_TOKEN", raising=False)

    def unexpected_call(*args, **kwargs):
        raise AssertionError("Import attempted an external call")

    monkeypatch.setattr(socket, "create_connection", unexpected_call)
    monkeypatch.setattr(socket.socket, "connect", unexpected_call)
    monkeypatch.setattr(openai, "OpenAI", unexpected_call)

    for name in module_names:
        sys.modules.pop(name, None)
    for name in module_names:
        assert importlib.import_module(name) is not None
