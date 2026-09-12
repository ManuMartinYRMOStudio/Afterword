"""Frozen Pydantic models for extractor stage boundaries."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict


class ContractModel(BaseModel):
    """Strict base model used at every shared contract boundary."""

    model_config = ConfigDict(extra="forbid")


class SupportLevel(str, Enum):
    EXPLICIT = "explicit"
    CONTEXTUAL = "contextual"
    WEAK = "weak"


class CommitmentBasis(str, Enum):
    SELF_COMMITMENT = "self_commitment"
    ACCEPTED_REQUEST = "accepted_request"
    EXPLICIT_ASSIGNMENT = "explicit_assignment"
    GROUP_COMMITMENT = "group_commitment"


class ActionType(str, Enum):
    CALENDAR_EVENT = "calendar_event"
    TASK = "task"
    NOTE = "note"
    EMAIL = "email"
    LISTING_PUBLISH = "listing_publish"
    UNKNOWN = "unknown"


class HoldReason(str, Enum):
    IRREVERSIBLE_TYPE = "irreversible_type"
    UNKNOWN_TYPE = "unknown_type"
    MISSING_REQUIRED_PARAMETER = "missing_required_parameter"


class TranscriptTurn(ContractModel):
    id: str
    speaker: str
    text: str


class NormalizedTranscript(ContractModel):
    turns: list[TranscriptTurn]
    speakers: list[str]


class Call1Commitment(ContractModel):
    responsible_speakers: list[str]
    intended_effect: str
    commitment_evidence: list[str]
    commitment_support: SupportLevel
    commitment_basis: CommitmentBasis


class Call1Response(ContractModel):
    commitments: list[Call1Commitment]


class CommitmentCandidate(ContractModel):
    candidate_id: str
    responsible_speakers: list[str]
    intended_effect: str
    commitment_evidence: list[str]
    commitment_support: SupportLevel
    commitment_basis: CommitmentBasis


class ParameterDraft(ContractModel):
    name: str
    value: str
    evidence: list[str]
    support: SupportLevel


class Call2ActionDraft(ContractModel):
    candidate_id: str
    type: ActionType
    title: str
    summary: str
    parameters: list[ParameterDraft]


class Call2Response(ContractModel):
    actions: list[Call2ActionDraft]


class ValidationWarning(ContractModel):
    stage: str
    code: str
    message: str
    candidate_id: str | None = None


class ParameterEvidence(ContractModel):
    evidence: list[str]
    support: SupportLevel | None


class ResolvedAction(ContractModel):
    id: str
    type: ActionType
    title: str
    summary: str
    payload: dict[str, str | None]
    action_evidence: list[str]
    action_support: SupportLevel
    parameter_evidence: dict[str, ParameterEvidence]
    support: SupportLevel | None
    confidence: float | None
    auto_execute: bool
    hold_reason: HoldReason | None


class ExecutionIntegrity(ContractModel):
    canonical_execution: str
    execution_sha256: str


class ExtractionResult(ContractModel):
    turns: list[TranscriptTurn]
    actions: list[ResolvedAction]
    execution_integrity: dict[str, ExecutionIntegrity]
    warnings: list[ValidationWarning]
    total: int
