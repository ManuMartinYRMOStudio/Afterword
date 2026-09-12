#!/usr/bin/env python3
"""Seal the web fixture using the extractor's own execution-integrity functions."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))

from services.extractor.derivation import canonicalize_execution, hash_execution
from services.extractor.models import ActionType


def main() -> None:
    transcript_path = ROOT / "web" / "transcript.json"
    actions_path = ROOT / "web" / "actions.json"
    transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    document = json.loads(actions_path.read_text(encoding="utf-8"))

    if not isinstance(transcript, dict) or not isinstance(transcript.get("turns"), list):
        raise ValueError("web/transcript.json must contain a turns array")
    if not isinstance(document, dict) or not isinstance(document.get("actions"), list):
        raise ValueError("web/actions.json must contain an actions array")

    sealed_actions = []
    for index, action in enumerate(document["actions"]):
        if not isinstance(action, dict):
            raise ValueError(f"Action at index {index} must be an object")
        label = f"Action {action.get('id', f'at index {index}')}"
        for field in ("type", "payload", "auto_execute"):
            if field not in action:
                raise ValueError(f"{label}: missing field {field}")
        if not isinstance(action["payload"], dict):
            raise ValueError(f"{label}: payload must be an object")
        if not isinstance(action["auto_execute"], bool):
            raise ValueError(f"{label}: auto_execute must already be a boolean")
        try:
            action_type = ActionType(action["type"])
        except (TypeError, ValueError):
            raise ValueError(f"{label}: unsupported action type") from None

        sealed = dict(action)
        canonical = canonicalize_execution(action_type, action["payload"])
        sealed["canonical"] = canonical
        sealed["hash"] = hash_execution(canonical)
        sealed_actions.append(sealed)

    # Preserve existing action fields and top-level metadata, such as seconds.
    result = dict(document)
    result["transcript"] = transcript["turns"]
    result["actions"] = sealed_actions

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=actions_path.parent,
            prefix=".actions-sealed-", suffix=".tmp", delete=False,
        ) as output:
            temporary_path = Path(output.name)
            json.dump(result, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_path, actions_path.stat().st_mode & 0o777)
        os.replace(temporary_path, actions_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    held = sum(action["auto_execute"] is False for action in sealed_actions)
    print(f"Sealed {len(sealed_actions)} actions; {held} held.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
