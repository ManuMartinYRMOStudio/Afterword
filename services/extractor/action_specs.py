"""Authoritative action parameters and deterministic policy constants."""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from .models import ActionType, SupportLevel


@dataclass(frozen=True)
class ActionSpec:
    description: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()


ACTION_SPECS: Mapping[ActionType, ActionSpec] = MappingProxyType(
    {
        ActionType.CALENDAR_EVENT: ActionSpec(
            description="Create a scheduled meeting, appointment, or reminder.",
            required=("title", "datetime"),
            optional=("attendees",),
        ),
        ActionType.TASK: ActionSpec(
            description="Create an internal work item for human follow-up.",
            required=("title",),
            optional=("due",),
        ),
        ActionType.NOTE: ActionSpec(
            description="Persist information to an internal record.",
            required=("body",),
            optional=("record",),
        ),
        ActionType.EMAIL: ActionSpec(
            description="Send an email externally.",
            required=("to", "subject", "body"),
        ),
        ActionType.LISTING_PUBLISH: ActionSpec(
            description="Publish a property listing to a public portal.",
            required=("property_ref", "price"),
        ),
        ActionType.UNKNOWN: ActionSpec(
            description="Represent a concrete commitment unsupported by known capabilities.",
            required=("description",),
        ),
    }
)

REVERSIBILITY: Mapping[ActionType, bool | None] = MappingProxyType(
    {
        ActionType.CALENDAR_EVENT: True,
        ActionType.TASK: True,
        ActionType.NOTE: True,
        ActionType.EMAIL: False,
        ActionType.LISTING_PUBLISH: False,
        ActionType.UNKNOWN: None,
    }
)

SUPPORT_ORDER: Mapping[SupportLevel, int] = MappingProxyType(
    {
        SupportLevel.WEAK: 0,
        SupportLevel.CONTEXTUAL: 1,
        SupportLevel.EXPLICIT: 2,
    }
)

SUPPORT_TO_CONFIDENCE: Mapping[SupportLevel, float] = MappingProxyType(
    {
        SupportLevel.WEAK: 0.3,
        SupportLevel.CONTEXTUAL: 0.6,
        SupportLevel.EXPLICIT: 1.0,
    }
)
