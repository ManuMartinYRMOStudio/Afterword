"""Tests for the extractor's HTTP boundary."""

from __future__ import annotations

import importlib
import socket
from unittest.mock import Mock

import openai
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.extractor import app as app_module
from services.extractor.config import Settings
from services.extractor.models import ExtractionResult


ENGINE_TOKEN = "test-engine-token"
AUTH_HEADERS = {"Authorization": f"Bearer {ENGINE_TOKEN}"}


def extraction_result() -> ExtractionResult:
    return ExtractionResult.model_validate(
        {
            "turns": [
                {"id": "L01", "speaker": "CLARA", "text": "I'll do it."}
            ],
            "actions": [
                {
                    "id": "a1",
                    "type": "task",
                    "title": "Do the work",
                    "summary": "Complete the agreed work",
                    "payload": {"title": "Complete the work"},
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
                        '{"payload":{"title":"Complete the work"},"type":"task"}'
                    ),
                    "execution_sha256": "a" * 64,
                }
            },
            "warnings": [
                {
                    "stage": "call2",
                    "code": "example_warning",
                    "message": "Example warning",
                    "candidate_id": "C01",
                }
            ],
            "total": 1,
        }
    )


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(
        app_module,
        "load_settings",
        lambda: Settings(openai_api_key=None, engine_token=ENGINE_TOKEN),
    )
    return TestClient(app_module.create_app())


def test_health_is_public_and_has_no_pipeline_or_openai_behavior(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipeline = Mock(side_effect=AssertionError("health called the pipeline"))
    monkeypatch.setattr(app_module, "run_extraction", pipeline)
    monkeypatch.setattr(
        app_module,
        "load_settings",
        Mock(side_effect=AssertionError("health loaded runtime secrets")),
    )
    monkeypatch.setattr(
        openai,
        "OpenAI",
        Mock(side_effect=AssertionError("health created an OpenAI client")),
    )

    response = TestClient(app_module.create_app()).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    pipeline.assert_not_called()


def test_extract_without_authorization_is_unauthorized(client: TestClient) -> None:
    response = client.post(
        "/extract", json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"}
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "authorization",
    ["Basic credentials", "Bearer", "Bearer one two"],
)
def test_extract_rejects_malformed_authorization(
    client: TestClient, authorization: str
) -> None:
    response = client.post(
        "/extract",
        headers={"Authorization": authorization},
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 401


def test_extract_rejects_wrong_token(client: TestClient) -> None:
    response = client.post(
        "/extract",
        headers={"Authorization": "Bearer wrong-token"},
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 401


def test_correct_token_reaches_pipeline(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    pipeline = Mock(return_value=extraction_result())
    monkeypatch.setattr(app_module, "run_extraction", pipeline)

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 200
    pipeline.assert_called_once()


def test_authentication_uses_secrets_compare_digest(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    compare_digest = Mock(return_value=True)
    pipeline = Mock(return_value=extraction_result())
    monkeypatch.setattr(app_module.secrets, "compare_digest", compare_digest)
    monkeypatch.setattr(app_module, "run_extraction", pipeline)

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 200
    compare_digest.assert_called_once_with(ENGINE_TOKEN, ENGINE_TOKEN)


@pytest.mark.parametrize("configured_token", [None, ""])
def test_missing_runtime_engine_token_is_a_configuration_failure(
    monkeypatch: pytest.MonkeyPatch, configured_token: str | None
) -> None:
    pipeline = Mock(side_effect=AssertionError("unconfigured request reached pipeline"))
    monkeypatch.setattr(
        app_module,
        "load_settings",
        lambda: Settings(openai_api_key=None, engine_token=configured_token),
    )
    monkeypatch.setattr(app_module, "run_extraction", pipeline)

    response = TestClient(app_module.create_app()).post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Extractor service authentication is not configured"
    }
    pipeline.assert_not_called()


@pytest.mark.parametrize(
    "payload,missing_field",
    [
        ({"principal": "CLARA"}, "transcript"),
        ({"transcript": "CLARA: I'll do it."}, "principal"),
    ],
)
def test_extract_rejects_missing_required_fields(
    client: TestClient, payload: dict[str, str], missing_field: str
) -> None:
    response = client.post("/extract", headers=AUTH_HEADERS, json=payload)

    assert response.status_code == 422
    assert any(error["loc"][-1] == missing_field for error in response.json()["detail"])


@pytest.mark.parametrize("field", ["transcript", "principal"])
@pytest.mark.parametrize("blank_value", ["", "   \t\r\n"])
def test_extract_rejects_blank_fields(
    client: TestClient, field: str, blank_value: str
) -> None:
    payload = {"transcript": "CLARA: I'll do it.", "principal": "CLARA"}
    payload[field] = blank_value

    response = client.post("/extract", headers=AUTH_HEADERS, json=payload)

    assert response.status_code == 422


def test_valid_request_passes_exact_strings_to_pipeline(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw_transcript = "  CLARA: I'll do it.\n\nDAVID: Fine.  "
    exact_principal = " CLARA "
    pipeline = Mock(return_value=extraction_result())
    monkeypatch.setattr(app_module, "run_extraction", pipeline)

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": raw_transcript, "principal": exact_principal},
    )

    assert response.status_code == 200
    pipeline.assert_called_once_with(
        transcript_text=raw_transcript,
        principal=exact_principal,
    )


def test_successful_extraction_result_serializes_frozen_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_module, "run_extraction", lambda **kwargs: extraction_result())

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "turns",
        "actions",
        "execution_integrity",
        "warnings",
        "total",
    }
    assert body["turns"][0]["id"] == "L01"
    assert body["actions"][0]["id"] == "a1"
    assert body["execution_integrity"]["a1"]["execution_sha256"] == "a" * 64
    assert body["warnings"][0]["code"] == "example_warning"
    assert body["total"] == 1


def test_pipeline_value_error_becomes_client_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        app_module,
        "run_extraction",
        Mock(side_effect=ValueError("principal is not a transcript speaker")),
    )

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "DAVID"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "principal is not a transcript speaker"}


def test_unexpected_pipeline_failure_returns_safe_server_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_detail = "provider response contained private diagnostic data"
    monkeypatch.setattr(
        app_module,
        "run_extraction",
        Mock(side_effect=RuntimeError(private_detail)),
    )

    response = client.post(
        "/extract",
        headers=AUTH_HEADERS,
        json={"transcript": "CLARA: I'll do it.", "principal": "CLARA"},
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Extraction failed"}
    assert private_detail not in response.text


def test_module_import_and_app_creation_need_no_secrets_or_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ENGINE_TOKEN", raising=False)

    def unexpected_call(*args: object, **kwargs: object) -> None:
        raise AssertionError("app import or creation attempted external work")

    monkeypatch.setattr(socket, "create_connection", unexpected_call)
    monkeypatch.setattr(socket.socket, "connect", unexpected_call)
    monkeypatch.setattr(openai, "OpenAI", unexpected_call)

    reloaded = importlib.reload(app_module)

    assert isinstance(reloaded.app, FastAPI)
    assert isinstance(reloaded.create_app(), FastAPI)
