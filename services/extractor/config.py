"""Side-effect-free runtime configuration for the extractor service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
ENGINE_TOKEN_ENV = "ENGINE_TOKEN"
OPENAI_MODEL_ENV = "OPENAI_MODEL"
LOG_LEVEL_ENV = "LOG_LEVEL"
PORT_ENV = "PORT"

DEFAULT_OPENAI_MODEL = "gpt-5.6-sol"
DEFAULT_LOG_LEVEL = "INFO"
DEFAULT_PORT = 8080


@dataclass(frozen=True)
class Settings:
    openai_api_key: str | None
    engine_token: str | None
    openai_model: str = DEFAULT_OPENAI_MODEL
    log_level: str = DEFAULT_LOG_LEVEL
    port: int = DEFAULT_PORT


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Read settings on demand; absent secrets are allowed for imports and tests."""

    source = os.environ if environ is None else environ
    return Settings(
        openai_api_key=source.get(OPENAI_API_KEY_ENV),
        engine_token=source.get(ENGINE_TOKEN_ENV),
        openai_model=source.get(OPENAI_MODEL_ENV, DEFAULT_OPENAI_MODEL),
        log_level=source.get(LOG_LEVEL_ENV, DEFAULT_LOG_LEVEL),
        port=int(source.get(PORT_ENV, str(DEFAULT_PORT))),
    )
