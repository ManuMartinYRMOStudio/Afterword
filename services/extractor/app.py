"""FastAPI boundary for the extraction engine."""

from __future__ import annotations

import secrets

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, field_validator

from .config import load_settings
from .models import ExtractionResult
from .pipeline import run_extraction as run_extraction


class ExtractionRequest(BaseModel):
    """The frozen HTTP request passed through to the extraction pipeline."""

    model_config = ConfigDict(extra="forbid")

    transcript: str
    principal: str

    @field_validator("transcript", "principal")
    @classmethod
    def require_non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


def _authentication_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _require_engine_token(authorization: str | None = Header(default=None)) -> None:
    configured_token = load_settings().engine_token
    if not configured_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Extractor service authentication is not configured",
        )

    if authorization is None:
        raise _authentication_error()

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise _authentication_error()

    if not secrets.compare_digest(parts[1], configured_token):
        raise _authentication_error()


def create_app() -> FastAPI:
    """Create the extractor HTTP application without resolving runtime secrets."""

    application = FastAPI()

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.post(
        "/extract",
        response_model=ExtractionResult,
        dependencies=[Depends(_require_engine_token)],
    )
    def extract(request: ExtractionRequest) -> ExtractionResult:
        try:
            return run_extraction(
                transcript_text=request.transcript,
                principal=request.principal,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc) or "Invalid extraction input",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Extraction failed",
            ) from exc

    return application


app = create_app()
