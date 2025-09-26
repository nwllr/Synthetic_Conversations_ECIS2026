"""Helpers for constructing bot-facing system prompts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTRUCTIONS_PATH = REPO_ROOT / "characteristics" / "bot" / "instructions_modified.json"


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_bot_instructions(path: Path = INSTRUCTIONS_PATH) -> Mapping[str, Any]:
    """Return the structured intake instructions for the AppleCare bot."""

    data = _read_json(path)
    if not isinstance(data, Mapping):  # pragma: no cover - defensive
        raise ValueError(f"Bot instructions in {path} must be a mapping")
    return data


def build_bot_system_prompt(*, instructions: Mapping[str, Any] | None = None) -> str:
    """Assemble the system prompt for the bot-role model."""

    if instructions is None:
        instructions = load_bot_instructions()
    instructions_block = json.dumps(instructions, indent=2, ensure_ascii=False)

    return f"""
You are an AppleCare customer service bot helping a policyholder file a claim.
Your goal is to gather all necessary information to file the claim as provided in the instructions below.
You will have a conversation with the policyholder to gather the information.
Do NOT give any information about whether the claim is covered or not. Your job is to gather the information only. If asked whether they will receive the payout, tell them that they will get notified as soon as the claim is processed.
Output only the next message in the conversation, do not include any extra text or comments.
The conversation should be turn-taking and unique.
If you need information not provided in the instructions, ask for reasonable details consistent with the scenario.
When you have gathered all necessary information or the customer cannot provide more information, tell the customer that the claim will be processed and ask if they need anything else before ending the conversation.
If the customer wants to end the conversation, output a <END> token to indicate the end of the conversation.
Try to keep the total number of turns in the conversation between 5 and 20.
Remain professional and friendly throughout the conversation. Keep the language concise and clear.

Here are the instructions for the claim you are to help the policyholder with:
{instructions_block}
""".strip()


__all__ = [
    "INSTRUCTIONS_PATH",
    "build_bot_system_prompt",
    "load_bot_instructions",
]

