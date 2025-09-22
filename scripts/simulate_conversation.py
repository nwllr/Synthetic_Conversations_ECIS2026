#!/usr/bin/env python3
"""Simulate conversations between a customer persona and the AppleCare bot.

Each run alternates messages between two OpenAI chat completions: one acting as
the customer (persona + scenario) and the other as the intake bot. Results are
written to JSON files for downstream analysis.
"""

from __future__ import annotations

import argparse
import os
import json
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Mapping, Sequence, Tuple, TYPE_CHECKING

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency
    load_dotenv = None


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from prompts.bot_prompt import build_bot_system_prompt, load_bot_instructions
from prompts.customer_prompt import (
    build_customer_system_prompt,
    choose_random_persona,
    find_scenario_by_id,
    iter_all_scenarios,
    load_personas,
)


DEFAULT_MODEL = "gpt-4.1-mini"
DEFAULT_MAX_TOKENS = 400
MAX_DEFAULT_TURNS = 20
END_TOKEN = "<END>"


@dataclass
class ConversationMessage:
    speaker: str
    text: str
    raw_text: str


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-id", help="Generate using a specific scenario id")
    parser.add_argument(
        "--count",
        type=int,
        default=1,
        help="Number of conversations to generate (default: 1)",
    )
    parser.add_argument(
        "--persona-index",
        type=int,
        help="Use a specific persona index instead of sampling randomly",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Chat completion model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.7,
        help="Sampling temperature for both agents (default: 0.7)",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=MAX_DEFAULT_TURNS,
        help="Maximum number of conversational messages (default: 20)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help="Maximum tokens per agent response (default: 400)",
    )
    parser.add_argument(
        "--output-dir",
        default="generated_conversations",
        help="Directory where transcripts will be stored",
    )
    parser.add_argument(
        "--seed",
        type=int,
        help="Random seed to make persona sampling deterministic",
    )
    return parser.parse_args(argv)


def strip_code_fences(text: str) -> str:
    pattern = re.compile(r"^```(?:[a-zA-Z0-9_+-]+)?\n?(.*?)\n?```$", re.DOTALL)
    match = pattern.match(text.strip())
    return match.group(1).strip() if match else text.strip()


def normalize_response(text: str) -> Tuple[str, bool]:
    """Return cleaned text and whether the end token was observed."""

    cleaned = strip_code_fences(text)
    if END_TOKEN in cleaned:
        cleaned = cleaned.replace(END_TOKEN, "").strip()
        return cleaned, True
    return cleaned, False


def as_chat_messages(
    system_prompt: str,
    history: Iterable[ConversationMessage],
    perspective: str,
) -> List[Dict[str, str]]:
    messages = [{"role": "system", "content": system_prompt}]
    for item in history:
        if not item.text:
            continue
        role = "assistant" if item.speaker == perspective else "user"
        messages.append({"role": role, "content": item.text})
    return messages


def pick_persona(
    personas: Sequence[Mapping[str, object]],
    index: int | None,
) -> Mapping[str, object]:
    if index is not None:
        try:
            return personas[index]
        except IndexError as exc:
            raise SystemExit(f"Persona index {index} out of range (available: {len(personas)})") from exc
    return choose_random_persona(personas)


def select_scenarios(count: int, scenario_id: str | None) -> List[Tuple[str, Mapping[str, object]]]:
    if scenario_id:
        label, scenario = find_scenario_by_id(scenario_id)
        return [(label, scenario)]

    ordered = sorted(iter_all_scenarios(), key=lambda pair: str(pair[1].get("id", "")))
    if not ordered:
        raise SystemExit("No scenarios available")
    if count <= len(ordered):
        return ordered[:count]

    # If more conversations than scenarios requested, cycle through the list.
    cycled: List[Tuple[str, Mapping[str, object]]] = []
    for idx in range(count):
        cycled.append(ordered[idx % len(ordered)])
    return cycled


if TYPE_CHECKING:  # pragma: no cover - import only for type hints
    from openai import OpenAI


def run_conversation(
    client: "OpenAI",
    *,
    scenario_label: str,
    scenario: Mapping[str, object],
    persona: Mapping[str, object],
    instructions: Mapping[str, object],
    model: str,
    temperature: float,
    max_tokens: int,
    max_turns: int,
) -> Dict[str, object]:
    customer_system_prompt = build_customer_system_prompt(persona=persona, scenario=scenario)
    bot_system_prompt = build_bot_system_prompt(instructions=instructions)

    history: List[ConversationMessage] = []
    speaker_cycle = ["customer", "bot"]
    cycle_idx = 0
    ended = False

    while len(history) < max_turns and not ended:
        speaker = speaker_cycle[cycle_idx % 2]
        system_prompt = customer_system_prompt if speaker == "customer" else bot_system_prompt
        messages = as_chat_messages(system_prompt, history, speaker)

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        choice = response.choices[0]
        raw_text = (choice.message.content or choice.text or "").strip()
        cleaned_text, saw_end = normalize_response(raw_text)

        if not cleaned_text and not saw_end:
            cleaned_text = raw_text

        history.append(
            ConversationMessage(
                speaker=speaker,
                text=cleaned_text,
                raw_text=raw_text,
            )
        )

        if saw_end:
            ended = True

        cycle_idx += 1

    timestamp = datetime.now(timezone.utc)
    convo_id = f"{scenario.get('id', 'scenario')}_{timestamp.strftime('%Y%m%dT%H%M%SZ')}"

    transcript = [
        {"speaker": msg.speaker, "text": msg.text, "raw_text": msg.raw_text}
        for msg in history
    ]

    return {
        "id": convo_id,
        "created_at": timestamp.isoformat(),
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "max_turns": max_turns,
        "scenario_label": scenario_label,
        "scenario": scenario,
        "persona": persona,
        "system_prompts": {
            "customer": customer_system_prompt,
            "bot": bot_system_prompt,
        },
        "messages": transcript,
        "ended_within_turn_limit": ended,
    }


def write_conversation(output_dir: Path, conversation: Mapping[str, object]) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{conversation['id']}.json"
    path = output_dir / filename
    with path.open("w", encoding="utf-8") as fh:
        json.dump(conversation, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return path


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)

    if args.seed is not None:
        random.seed(args.seed)

    personas = load_personas()
    instructions = load_bot_instructions()
    scenarios = select_scenarios(args.count, args.scenario_id)

    try:
        from openai import OpenAI  # type: ignore
    except ImportError as exc:  # pragma: no cover - import error path
        raise SystemExit("Install the 'openai' Python package to run this script.") from exc

    if load_dotenv is not None:
        load_dotenv()
    else:  # pragma: no cover - optional dependency
        print("python-dotenv not installed; proceeding without loading .env", file=sys.stderr)

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("Set the OPENAI_API_KEY environment variable before running this script.")
    client = OpenAI(api_key=api_key)
    output_dir = Path(args.output_dir)

    written_paths: List[Path] = []

    for idx in range(args.count):
        scenario_label, scenario = scenarios[idx % len(scenarios)]
        persona = pick_persona(personas, args.persona_index)

        try:
            conversation = run_conversation(
                client,
                scenario_label=scenario_label,
                scenario=scenario,
                persona=persona,
                instructions=instructions,
                model=args.model,
                temperature=args.temperature,
                max_tokens=args.max_tokens,
                max_turns=args.max_turns,
            )
        except Exception as exc:  # pragma: no cover - requires API failure
            raise SystemExit(f"OpenAI API call failed: {exc}") from exc

        path = write_conversation(output_dir, conversation)
        written_paths.append(path)
        print(f"Wrote conversation to {path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
