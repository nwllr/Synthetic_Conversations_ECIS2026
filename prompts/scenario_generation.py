"""Scenario generation utilities for AppleCare+ synthetic conversations."""

from __future__ import annotations

import json
import textwrap
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

from prompts.customer_prompt import SCENARIO_PATHS

try:  # Optional dependency; imported lazily during CLI usage.
    from openai import OpenAI
except ImportError:  # pragma: no cover - handled at call sites
    OpenAI = None  # type: ignore


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY_PATH = REPO_ROOT / "policy" / "applecareplus.txt"
DEFAULT_FEWSHOT_PATH = REPO_ROOT / "prompts" / "scenario_fewshots.json"
DEFAULT_BASE_SCENARIO_PATH = REPO_ROOT / "characteristics" / "customer" / "scenario.json"
DEFAULT_ARCHIVE_ROOT = REPO_ROOT / "generated_scenarios"

ScenarioLabel = str  # alias with runtime validation
LABELS: Tuple[ScenarioLabel, ...] = ("covered", "not_covered", "edge_case")
LABEL_TO_PREFIX: Mapping[ScenarioLabel, str] = {
    "covered": "COV",
    "not_covered": "NC",
    "edge_case": "EC",
}
LABEL_TO_GROUND_TRUTH: Mapping[ScenarioLabel, str] = {
    "covered": "covered",
    "not_covered": "not_covered",
    "edge_case": "edge_case",
}


class ScenarioGenerationError(RuntimeError):
    """Raised when scenario generation or validation fails."""


@dataclass
class ScenarioGenerationSettings:
    """Configuration for a single run."""

    counts: Mapping[ScenarioLabel, int] = field(default_factory=dict)
    model: str = "gpt-4.1"
    temperature: float = 0.35
    max_tokens: int = 2800
    retries: int = 2


def _strip_code_fences(text: str) -> str:
    if text.strip().startswith("```") and text.strip().endswith("```"):
        trimmed = text.strip()[3:-3]
        if trimmed.lstrip().startswith("json"):
            trimmed = trimmed.lstrip()[4:]
        return trimmed.strip()
    return text.strip()


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_policy_metadata(path: Path = DEFAULT_BASE_SCENARIO_PATH) -> Mapping[str, Any]:
    if path.exists():
        try:
            data = _load_json(path)
            policy = data.get("policy")
            if isinstance(policy, Mapping):
                return policy
        except Exception:
            pass
    return {
        "name": "AppleCare+ for iPhone",
        "region": "US & Canada",
        "plan_term_months": 24,
    }


def _load_policy_text(path: Path = DEFAULT_POLICY_PATH) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ScenarioGenerationError(f"Policy file missing at {path}") from exc


def _load_fewshot(path: Path = DEFAULT_FEWSHOT_PATH) -> Mapping[str, Mapping[str, Any]]:
    data = _load_json(path)
    if not isinstance(data, Mapping):
        raise ScenarioGenerationError("Few-shot resource must be a mapping")
    out: Dict[str, Mapping[str, Any]] = {}
    for label in LABELS:
        block = data.get(label)
        if not isinstance(block, Mapping):
            raise ScenarioGenerationError(f"Few-shot block missing for label {label}")
        if not isinstance(block.get("examples"), list) or len(block["examples"]) < 1:
            raise ScenarioGenerationError(f"Few-shot examples missing for {label}")
        out[label] = block
    return out


def _build_prompt(
    *,
    label: ScenarioLabel,
    count: int,
    fewshot: Mapping[str, Any],
    policy_text: str,
) -> Tuple[str, str]:
    prefix = LABEL_TO_PREFIX[label]
    label_ground_truth = LABEL_TO_GROUND_TRUTH[label]
    instructions = fewshot.get("instructions", "").strip()
    examples = fewshot.get("examples", [])
    examples_json = json.dumps(examples, indent=2, ensure_ascii=False)

    system_prompt = textwrap.dedent(
        f"""
        You are an expert insurance analyst who writes scenario definitions for AppleCare+ claim triage.
        Generate concise but information-rich and diverse scenarios. Output JSON only.
        """
    ).strip()

    user_prompt = textwrap.dedent(
        f"""
        Target label: {label}
        Target ground_truth value: {label_ground_truth}
        Scenario id prefix: {prefix}-<unique>
        Required scenario count: {count}

        Requirements:
        - Return a JSON array with exactly {count} objects.
        - Every scenario must include the fields: id, title, description, claim_type, ground_truth, service_fee, counts_toward_adh_limit, policy_references, reasoning, customer_data.
        - ground_truth must equal "{label_ground_truth}".
        - Policy references must be an array of objects with section and snippet.
        - customer_data should include realistic values for device, plan_agreement_number (or "Unknown"), serial_number (or "Unknown"), and phone_number (use realistic formatting).
        - Tie the reasoning back to concrete policy clauses and mention service fees or limits where relevant.
        - Use unique identifiers with the {prefix}- prefix (e.g., {prefix}-202509-01). You can invent the unique suffix.
        - Do not repeat the example ids; produce new scenarios.
        - Output JSON only; no prose, no code fences.

        Style guidance for this label:
        {instructions or 'N/A'}

        Example scenarios for inspiration (do not copy; ids must differ):
        {examples_json}

        Full AppleCare+ policy text (use for citations):
        {policy_text}
        """
    ).strip()
    return system_prompt, user_prompt


def _ensure_label(label: str) -> ScenarioLabel:
    if label not in LABELS:
        raise ScenarioGenerationError(f"Unsupported scenario label: {label}")
    return label


def _normalize_scenario(
    label: ScenarioLabel,
    scenario: MutableMapping[str, Any],
    *,
    new_id: str,
) -> Mapping[str, Any]:
    scenario["id"] = new_id
    scenario["ground_truth"] = LABEL_TO_GROUND_TRUTH[label]
    if "customer_data" not in scenario or not isinstance(scenario["customer_data"], Mapping):
        scenario["customer_data"] = {}
    return scenario


def _validate_scenario(label: ScenarioLabel, scenario: Mapping[str, Any]) -> None:
    required_fields = [
        "id",
        "title",
        "description",
        "claim_type",
        "ground_truth",
        "policy_references",
        "reasoning",
        "customer_data",
    ]
    missing = [key for key in required_fields if key not in scenario]
    if missing:
        raise ScenarioGenerationError(f"Scenario for {label} missing fields: {', '.join(missing)}")
    if scenario["ground_truth"] != LABEL_TO_GROUND_TRUTH[label]:
        raise ScenarioGenerationError(
            f"Scenario {scenario.get('id')} ground_truth {scenario['ground_truth']} does not match {label}"
        )
    if not isinstance(scenario["policy_references"], Sequence) or not scenario["policy_references"]:
        raise ScenarioGenerationError(f"Scenario {scenario.get('id')} must include at least one policy reference")
    if not isinstance(scenario["customer_data"], Mapping):
        raise ScenarioGenerationError(f"Scenario {scenario.get('id')} customer_data must be an object")


def _timestamp_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


@dataclass
class ScenarioGenerationResult:
    scenarios: Mapping[ScenarioLabel, List[Mapping[str, Any]]]
    written_files: Mapping[ScenarioLabel, Path]
    archive_dir: Optional[Path]
    settings: ScenarioGenerationSettings


class ScenarioGenerator:
    """High-level orchestrator that wraps OpenAI calls and file IO."""

    def __init__(
        self,
        client: "OpenAI",
        *,
        policy_path: Path = DEFAULT_POLICY_PATH,
        fewshot_path: Path = DEFAULT_FEWSHOT_PATH,
        base_metadata_path: Path = DEFAULT_BASE_SCENARIO_PATH,
        archive_root: Path = DEFAULT_ARCHIVE_ROOT,
    ) -> None:
        if client is None:
            raise ScenarioGenerationError("OpenAI client is required")
        self.client = client
        self.policy_text = _load_policy_text(policy_path)
        self.fewshot = _load_fewshot(fewshot_path)
        self.policy_metadata = _load_policy_metadata(base_metadata_path)
        self.archive_root = archive_root

    def generate(
        self,
        settings: ScenarioGenerationSettings,
        *,
        scenario_paths: Mapping[ScenarioLabel, Path] | None = None,
        archive: bool = True,
    ) -> ScenarioGenerationResult:
        counts = {label: settings.counts.get(label, 0) for label in LABELS}
        if not any(counts.values()):
            raise ScenarioGenerationError("At least one scenario count must be greater than zero")

        scenario_paths = scenario_paths or SCENARIO_PATHS
        normalized_paths: Dict[ScenarioLabel, Path] = {}
        for label, rel_path in scenario_paths.items():
            normalized_paths[label] = Path(rel_path)

        slug = _timestamp_slug()
        archive_dir: Optional[Path] = None
        if archive:
            archive_dir = self.archive_root / slug
            archive_dir.mkdir(parents=True, exist_ok=True)

        generated: Dict[ScenarioLabel, List[Mapping[str, Any]]] = {}
        raw_materials: Dict[str, Any] = {
            "generated_at": slug,
            "model": settings.model,
            "temperature": settings.temperature,
            "max_tokens": settings.max_tokens,
        }

        for label, count in counts.items():
            if count <= 0:
                continue
            label = _ensure_label(label)
            system_prompt, user_prompt = _build_prompt(
                label=label,
                count=count,
                fewshot=self.fewshot[label],
                policy_text=self.policy_text,
            )
            prompts_record = {
                "system": system_prompt,
                "user": user_prompt,
            }
            attempt = 0
            response_text: Optional[str] = None
            last_error: Optional[Exception] = None
            while attempt <= settings.retries:
                attempt += 1
                try:
                    completion = self.client.chat.completions.create(
                        model=settings.model,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                        temperature=settings.temperature,
                        max_tokens=settings.max_tokens,
                    )
                    choice = completion.choices[0]
                    response_text = (choice.message.content or choice.text or "").strip()
                    parsed = json.loads(_strip_code_fences(response_text))
                    if not isinstance(parsed, list):
                        raise ScenarioGenerationError("Model must return a JSON array of scenarios")
                    if len(parsed) != count:
                        raise ScenarioGenerationError(
                            f"Expected {count} scenarios for {label}, received {len(parsed)}"
                        )
                    normalized = self._normalize_batch(label, parsed, slug)
                    generated[label] = normalized
                    raw_materials[label] = {
                        "prompt": prompts_record,
                        "response": response_text,
                    }
                    break
                except Exception as exc:  # pragma: no cover - network/UI path
                    last_error = exc
                    if attempt > settings.retries:
                        raise ScenarioGenerationError(
                            f"Failed to generate scenarios for {label}: {exc}"
                        ) from exc
            else:
                if last_error:
                    raise ScenarioGenerationError(
                        f"Failed to generate scenarios for {label}: {last_error}"
                    ) from last_error

        written_files = self._write_outputs(
            generated,
            normalized_paths,
            slug=slug,
            settings=settings,
            archive_dir=archive_dir,
            raw_materials=raw_materials,
        )

        return ScenarioGenerationResult(
            scenarios=generated,
            written_files=written_files,
            archive_dir=archive_dir,
            settings=settings,
        )

    def _normalize_batch(
        self,
        label: ScenarioLabel,
        scenarios: Sequence[MutableMapping[str, Any]],
        slug: str,
    ) -> List[Mapping[str, Any]]:
        prefix = LABEL_TO_PREFIX[label]
        normalized: List[Mapping[str, Any]] = []
        for idx, scenario in enumerate(scenarios, start=1):
            if not isinstance(scenario, MutableMapping):
                raise ScenarioGenerationError(f"Scenario {idx} for {label} must be an object")
            new_id = f"{prefix}-{slug}-{idx:02d}"
            normalized_item = _normalize_scenario(label, scenario, new_id=new_id)
            _validate_scenario(label, normalized_item)
            normalized.append(normalized_item)
        return normalized

    def _write_outputs(
        self,
        scenarios: Mapping[ScenarioLabel, List[Mapping[str, Any]]],
        output_paths: Mapping[ScenarioLabel, Path],
        *,
        slug: str,
        settings: ScenarioGenerationSettings,
        archive_dir: Optional[Path],
        raw_materials: Mapping[str, Any],
    ) -> Mapping[ScenarioLabel, Path]:
        written: Dict[ScenarioLabel, Path] = {}
        for label, items in scenarios.items():
            target_path = output_paths[label]
            payload = {
                "policy": self.policy_metadata,
                "generated_on": slug[:8],
                "generator": {
                    "model": settings.model,
                    "temperature": settings.temperature,
                    "max_tokens": settings.max_tokens,
                    "attempted_count": len(items),
                    "slug": slug,
                },
                "categories": {
                    label: items,
                },
            }
            target_path.parent.mkdir(parents=True, exist_ok=True)
            with target_path.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
            written[label] = target_path

        if archive_dir is not None:
            metadata_path = archive_dir / "metadata.json"
            with metadata_path.open("w", encoding="utf-8") as handle:
                json.dump(raw_materials, handle, indent=2, ensure_ascii=False)
                handle.write("\n")

            for label, items in scenarios.items():
                archive_payload = {
                    "scenarios": items,
                    "settings": {
                        "model": settings.model,
                        "temperature": settings.temperature,
                        "max_tokens": settings.max_tokens,
                    },
                }
                with (archive_dir / f"{label}_scenarios.json").open("w", encoding="utf-8") as handle:
                    json.dump(archive_payload, handle, indent=2, ensure_ascii=False)
                    handle.write("\n")

        return written


__all__ = [
    "ScenarioGenerationError",
    "ScenarioGenerationResult",
    "ScenarioGenerationSettings",
    "ScenarioGenerator",
]
