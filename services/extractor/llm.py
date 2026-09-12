"""Direct model-call interfaces; no client is created at import time."""

from __future__ import annotations

import time
from typing import Any, TypeVar

import openai

from .models import (
    Call1Response,
    Call2Response,
    CommitmentCandidate,
    NormalizedTranscript,
)
from .prompts import build_discovery_prompt, build_resolution_prompt

ResponseT = TypeVar("ResponseT", Call1Response, Call2Response)

MAX_TRANSPORT_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 0.5

# Transport/provider faults only. Semantic dissatisfaction is never a retry reason.
_RETRYABLE = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.RateLimitError,
    openai.InternalServerError,
)

# Deterministic-extraction request shape. Dropped one at a time if the selected
# model rejects the parameter, so the model identifier stays the only knob in config.
_TUNING: dict[str, Any] = {
    "temperature": 0,
    "reasoning": {"effort": "low"},
}


class LLMError(RuntimeError):
    """Base class for extraction-stage model failures."""


class LLMTransportError(LLMError):
    """Transport/provider failure that survived the bounded retry budget."""


class LLMSchemaError(LLMError):
    """Structured-output failure. Never downgraded to free-form parsing."""


def _build_client(api_key: str) -> openai.OpenAI:
    """Create the OpenAI client. Patched in unit tests; never called at import time."""

    return openai.OpenAI(api_key=api_key)


def _unsupported_parameter(error: openai.BadRequestError, name: str) -> bool:
    return name in str(error)


def _parse(
    prompt: str,
    response_model: type[ResponseT],
    *,
    model: str,
    api_key: str,
) -> ResponseT:
    """One structured-output Responses call with bounded transport retries."""

    client = _build_client(api_key)
    tuning = dict(_TUNING)
    last_transport_error: Exception | None = None
    attempt = 0

    # Parameter-drop retries are bounded by len(_TUNING) and do not consume the
    # transport budget; only genuine transport faults do.
    while attempt < MAX_TRANSPORT_ATTEMPTS:
        try:
            response = client.responses.parse(
                model=model,
                input=prompt,
                text_format=response_model,
                **tuning,
            )
        except openai.BadRequestError as error:
            dropped = [name for name in tuning if _unsupported_parameter(error, name)]
            if not dropped:
                raise LLMSchemaError(
                    f"{response_model.__name__} request rejected: {error}"
                ) from error
            for name in dropped:
                tuning.pop(name)
            continue
        except _RETRYABLE as error:
            last_transport_error = error
            attempt += 1
            if attempt < MAX_TRANSPORT_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
            continue

        parsed = getattr(response, "output_parsed", None)
        if parsed is None:
            raise LLMSchemaError(
                f"{response_model.__name__} structured output missing "
                f"(status={getattr(response, 'status', None)})"
            )
        return parsed

    raise LLMTransportError(
        f"{response_model.__name__} call failed after {MAX_TRANSPORT_ATTEMPTS} "
        f"attempts: {last_transport_error}"
    )


def discover_commitments(
    transcript: NormalizedTranscript,
    *,
    model: str,
    api_key: str,
) -> Call1Response:
    """Run the single batched commitment-discovery model call."""

    return _parse(
        build_discovery_prompt(transcript),
        Call1Response,
        model=model,
        api_key=api_key,
    )


def resolve_candidates(
    transcript: NormalizedTranscript,
    principal: str,
    candidates: list[CommitmentCandidate],
    *,
    model: str,
    api_key: str,
) -> Call2Response:
    """Run the single batched capability-resolution model call."""

    return _parse(
        build_resolution_prompt(transcript, principal, candidates),
        Call2Response,
        model=model,
        api_key=api_key,
    )
