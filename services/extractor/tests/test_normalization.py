"""Tests for deterministic transcript normalization."""

from __future__ import annotations

import socket

import openai
import pytest

from services.extractor.models import NormalizedTranscript, TranscriptTurn
from services.extractor.normalization import normalize_transcript


def test_basic_speaker_labelled_transcript_uses_wave_zero_models():
    result = normalize_transcript(
        "CLARA: Thanks for making the time.\nDAVID: That's the idea."
    )

    assert isinstance(result, NormalizedTranscript)
    assert result.turns == [
        TranscriptTurn(
            id="L01", speaker="CLARA", text="Thanks for making the time."
        ),
        TranscriptTurn(id="L02", speaker="DAVID", text="That's the idea."),
    ]


def test_ids_are_deterministic_across_calls():
    raw_text = "CLARA: First.\nDAVID: Second.\nCLARA: Third."

    first = normalize_transcript(raw_text)
    second = normalize_transcript(raw_text)

    assert [turn.id for turn in first.turns] == ["L01", "L02", "L03"]
    assert first == second


def test_multiline_continuation_belongs_to_preceding_turn():
    result = normalize_transcript(
        "CLARA: Then I'll send the agreement\n"
        "today so you can read it properly.\n"
        "DAVID: Perfect."
    )

    assert result.turns[0].text == (
        "Then I'll send the agreement\ntoday so you can read it properly."
    )
    assert result.turns[1].speaker == "DAVID"


def test_optional_meeting_header_is_not_a_turn():
    result = normalize_transcript(
        "Seller call — Ruzafa flat · Tuesday 14:05\n\n"
        "CLARA: Thanks for making the time.\n"
        "DAVID: That's the idea."
    )

    assert [turn.speaker for turn in result.turns] == ["CLARA", "DAVID"]
    assert [turn.id for turn in result.turns] == ["L01", "L02"]


def test_speakers_are_unique_in_first_appearance_order():
    result = normalize_transcript(
        "DAVID: First.\nCLARA: Second.\nDAVID: Third.\nANA: Fourth."
    )

    assert result.speakers == ["DAVID", "CLARA", "ANA"]


def test_repeated_speaker_turns_remain_separate():
    result = normalize_transcript("CLARA: First.\nCLARA: Second.")

    assert [(turn.id, turn.text) for turn in result.turns] == [
        ("L01", "First."),
        ("L02", "Second."),
    ]


def test_id_width_changes_from_l09_to_l10():
    raw_text = "\n".join(f"CLARA: Turn {number}." for number in range(1, 11))

    result = normalize_transcript(raw_text)

    assert result.turns[8].id == "L09"
    assert result.turns[9].id == "L10"


def test_id_width_changes_from_l99_to_l100():
    raw_text = "\n".join(f"CLARA: Turn {number}." for number in range(1, 101))

    result = normalize_transcript(raw_text)

    assert result.turns[98].id == "L99"
    assert result.turns[99].id == "L100"


def test_blank_lines_do_not_create_turns():
    result = normalize_transcript(
        "\n\nCLARA: First.\n\nDAVID: Second.\n\n"
    )

    assert [turn.id for turn in result.turns] == ["L01", "L02"]


@pytest.mark.parametrize(
    "raw_text",
    [
        "",
        "This dialogue has no speaker label.",
        "Unlabelled opening dialogue.\nCLARA: Labelled too late.",
    ],
)
def test_malformed_or_unlabelled_transcript_fails_clearly(raw_text):
    with pytest.raises(ValueError, match="[Tt]ranscript|[Uu]nlabelled"):
        normalize_transcript(raw_text)


def test_specification_line_ids_are_replaced_positionally():
    result = normalize_transcript("L42 CLARA: First.\nL99 DAVID: Second.")

    assert [(turn.id, turn.speaker) for turn in result.turns] == [
        ("L01", "CLARA"),
        ("L02", "DAVID"),
    ]


def test_normalization_makes_no_network_or_model_calls(monkeypatch):
    def unexpected_call(*args, **kwargs):
        raise AssertionError("Normalization attempted an external call")

    monkeypatch.setattr(socket, "create_connection", unexpected_call)
    monkeypatch.setattr(socket.socket, "connect", unexpected_call)
    monkeypatch.setattr(openai, "OpenAI", unexpected_call)

    result = normalize_transcript("CLARA: Entirely local.")

    assert result.turns[0].text == "Entirely local."
