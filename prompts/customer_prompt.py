"""Helpers for constructing customer-facing system prompts and loading personas.

This module keeps persona and scenario loading logic centralized so both the
original dataset generation pipeline and the new conversation simulator can
reuse a consistent customer system prompt template.
"""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]

PERSONAS_PATH = REPO_ROOT / "characteristics" / "customer" / "personas.json"
SCENARIO_PATHS: Mapping[str, Path] = {
    "covered": REPO_ROOT / "characteristics" / "customer" / "cov_scenarios.json",
    "not_covered": REPO_ROOT / "characteristics" / "customer" / "nc_scenarios.json",
    "edge_case": REPO_ROOT / "characteristics" / "customer" / "ec_scenarios.json",
}


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_personas(path: Path = PERSONAS_PATH) -> List[Dict[str, Any]]:
    """Return the full list of customer personas."""

    data = _read_json(path)
    if not isinstance(data, list):
        raise ValueError(f"Expected persona list in {path}, got {type(data)!r}")
    return data  # type: ignore[return-value]


def choose_random_persona(personas: Iterable[Dict[str, Any]] | None = None) -> Dict[str, Any]:
    """Return a randomly selected persona from the provided iterable or disk."""

    pool: List[Dict[str, Any]]
    if personas is None:
        pool = load_personas()
    else:
        pool = list(personas)
    if not pool:
        raise ValueError("Persona pool is empty")
    return random.choice(pool)


def load_scenarios() -> Dict[str, List[Dict[str, Any]]]:
    """Load scenarios grouped by their ground-truth labels."""

    scenarios: Dict[str, List[Dict[str, Any]]] = {}
    for label, path in SCENARIO_PATHS.items():
        data = _read_json(path)
        try:
            scenarios[label] = list(data["categories"][label])
        except (KeyError, TypeError) as exc:  # pragma: no cover - defensive
            raise ValueError(f"Malformed scenario file {path}") from exc
    return scenarios


def iter_all_scenarios() -> Iterable[Tuple[str, Dict[str, Any]]]:
    """Yield `(ground_truth_label, scenario)` pairs for every known scenario."""

    grouped = load_scenarios()
    for label, items in grouped.items():
        for scenario in items:
            yield label, scenario


def find_scenario_by_id(scenario_id: str) -> Tuple[str, Dict[str, Any]]:
    """Look up a scenario by id across all ground-truth categories."""

    for label, scenario in iter_all_scenarios():
        if scenario.get("id") == scenario_id:
            return label, scenario
    raise KeyError(f"Scenario id {scenario_id!r} was not found")


def _format_json_block(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False)


def build_customer_system_prompt(*, persona: Mapping[str, Any], scenario: Mapping[str, Any]) -> str:
    """Assemble the system prompt for the customer-role model."""

    description = scenario.get("description", "").strip()
    title = scenario.get("title") or scenario.get("id") or "Scenario"
    customer_data = scenario.get("customer_data") or "{}"

    persona_block = _format_json_block(persona)
    customer_data_block = (
        _format_json_block(customer_data)
        if isinstance(customer_data, (dict, list))
        else str(customer_data)
    )

    return f"""
You are a policyholder filing a claim with AppleCare.
You are given a persona and a scenario to role-play as the policyholder.
You will have a conversation with an AppleCare bot to file your claim.
Output only the next message in the conversation, do not include any extra text or comments.
The conversation should be turn-taking and unique.
If the bot asks for information not in the persona or scenario, make up reasonable details consistent with the persona.
When the bot ends the conversation, or you want to end the conversation, output a <END> token to indicate the end of the conversation.

Scenario title: {title}
Scenario description:
{description}

Customer data you have available for filing the claim (respond "Unknown" when asked for missing details):
{customer_data_block}

Persona to role-play as:
{persona_block}
""".strip()


__all__ = [
    "PERSONAS_PATH",
    "SCENARIO_PATHS",
    "build_customer_system_prompt",
    "choose_random_persona",
    "find_scenario_by_id",
    "iter_all_scenarios",
    "load_personas",
    "load_scenarios",
]

