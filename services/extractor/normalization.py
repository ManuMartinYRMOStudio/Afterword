"""Deterministic normalization for the hackathon transcript format."""

from __future__ import annotations

import re

from .models import NormalizedTranscript, TranscriptTurn


_NUMBERED_SPEAKER_LINE = re.compile(
    r"^L\d+\s+(?P<speaker>[\w][\w .'-]*):[ \t]*(?P<text>.*)$"
)
_UNNUMBERED_SPEAKER_LINE = re.compile(
    r"^(?P<speaker>[\w][\w .'-]*):[ \t]*(?P<text>.*)$"
)


def _speaker_line(
    line: str, pattern: re.Pattern[str]
) -> tuple[str, str] | None:
    """Return a speaker label and text when the line matches ``pattern``."""

    match = pattern.fullmatch(line.strip())
    if match is None:
        return None

    speaker = match.group("speaker").strip()
    if not any(character.isalpha() for character in speaker):
        return None
    return speaker, match.group("text").strip()


def _numbered_speaker_line(line: str) -> tuple[str, str] | None:
    return _speaker_line(line, _NUMBERED_SPEAKER_LINE)


def _unnumbered_speaker_line(line: str) -> tuple[str, str] | None:
    return _speaker_line(line, _UNNUMBERED_SPEAKER_LINE)


def normalize_transcript(raw_text: str) -> NormalizedTranscript:
    """Normalize raw speaker-labelled text into deterministic turns."""

    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError("Transcript must contain speaker-labelled dialogue")

    lines = raw_text.splitlines()
    first_content = next(
        (index for index, line in enumerate(lines) if line.strip()),
        None,
    )
    if first_content is None:
        raise ValueError("Transcript must contain speaker-labelled dialogue")

    first_turn = None
    numbered = False
    for index in range(first_content, len(lines)):
        if _numbered_speaker_line(lines[index]) is not None:
            first_turn = index
            numbered = True
            break
        if _unnumbered_speaker_line(lines[index]) is not None:
            first_turn = index
            break
    if first_turn is None:
        raise ValueError("Transcript contains no valid speaker-labelled turns")

    if first_turn != first_content and not any(
        not line.strip() for line in lines[first_content:first_turn]
    ):
        raise ValueError(
            "Unlabelled dialogue appears before the first speaker-labelled turn"
        )

    parsed_turns: list[tuple[str, list[str]]] = []
    for line_number, line in enumerate(lines[first_turn:], start=first_turn + 1):
        if not line.strip():
            continue

        labelled = _numbered_speaker_line(line)
        if labelled is None and not numbered:
            labelled = _unnumbered_speaker_line(line)
        if labelled is not None:
            speaker, text = labelled
            parsed_turns.append((speaker, [text] if text else []))
            continue

        if not parsed_turns:
            raise ValueError(
                f"Unlabelled dialogue at line {line_number} has no speaker"
            )
        parsed_turns[-1][1].append(line.strip())

    turns: list[TranscriptTurn] = []
    speakers: list[str] = []
    for position, (speaker, text_lines) in enumerate(parsed_turns, start=1):
        text = "\n".join(text_lines)
        if not text:
            raise ValueError(f"Speaker turn {position} for {speaker!r} has no text")
        turns.append(
            TranscriptTurn(
                id=f"L{position:02d}",
                speaker=speaker,
                text=text,
            )
        )
        if speaker not in speakers:
            speakers.append(speaker)

    return NormalizedTranscript(turns=turns, speakers=speakers)
