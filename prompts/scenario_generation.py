"""Scenario generation utilities for AppleCare+ synthetic conversations."""

from __future__ import annotations

import json
import random
import textwrap
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

from prompts.customer_prompt import SCENARIO_PATHS

try:  # Optional dependency; imported lazily during CLI usage.
    from openai import OpenAI
except ImportError:  # pragma: no cover - handled at call sites
    OpenAI = None  # type: ignore


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY_PATH = REPO_ROOT / "policy" / "applecareplus.txt"
DEFAULT_POLICY_ANCHORS_PATH = REPO_ROOT / "policy" / "policy_anchors.json"
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


def _load_policy_anchors(path: Path = DEFAULT_POLICY_ANCHORS_PATH) -> List[Mapping[str, Any]]:
    if not path.exists():
        return []
    data = _load_json(path)
    if not isinstance(data, list):
        raise ScenarioGenerationError("Policy anchors file must contain a list")
    anchors: List[Mapping[str, Any]] = []
    for entry in data:
        if not isinstance(entry, Mapping):
            continue
        if not entry.get("id") or not entry.get("section") or not entry.get("snippet"):
            continue
        anchors.append(dict(entry))
    return anchors


def _build_prompt(
    *,
    label: ScenarioLabel,
    scenario_id: str,
    fewshot: Mapping[str, Any],
    policy_text: str,
    previous_summaries: Sequence[str],
    policy_anchor: Optional[Mapping[str, Any]] = None,
) -> Tuple[str, str]:
    prefix = LABEL_TO_PREFIX[label]
    label_ground_truth = LABEL_TO_GROUND_TRUTH[label]
    instructions = fewshot.get("instructions", "").strip()
    examples = fewshot.get("examples", [])
    examples_json = json.dumps(examples, indent=2, ensure_ascii=False)
    context_hint = ""
    if previous_summaries:
        limited = list(previous_summaries[-10:])
        bullet_points = "\n".join(f"- {summary}" for summary in limited)
        context_hint = f"Previously generated scenarios for this label (avoid overlap):\n{bullet_points}\n"

    anchor_block = ""
    anchor_requirement = ""
    if policy_anchor:
        anchor_section = policy_anchor.get("section", "?")
        anchor_snippet = policy_anchor.get("snippet", "").strip()
        anchor_intent = policy_anchor.get("intent")
        intent_text = f" (intent: {anchor_intent})" if anchor_intent else ""
        anchor_block = textwrap.dedent(
            f"""
            Primary policy anchor to emphasize{intent_text}:
            Section {anchor_section}
            "{anchor_snippet}
            """
        ).strip()
        anchor_requirement = textwrap.dedent(
            """
            - The scenario must hinge on the primary policy anchor above. Cite it explicitly in policy_references and weave it naturally into the description and reasoning.
            - You may reference additional sections from the full policy as needed, but the anchor should clearly influence the outcome.
            """
        ).strip()

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
        Scenario id you must use: {scenario_id}

        Requirements:
        - Return a single JSON object describing one scenario.
        - The object must include the fields: id, title, description, claim_type, ground_truth, service_fee, counts_toward_adh_limit, policy_references, reasoning, customer_data.
        - ground_truth must equal "{label_ground_truth}".
        - Use the provided scenario id verbatim; do not invent a new identifier.
        - Policy references must be an array of objects with section and snippet.
        - customer_data should include realistic values for device, plan_agreement_number (or "Unknown"), serial_number (or "Unknown"), and phone_number (use realistic formatting).
        - Tie the reasoning back to concrete policy clauses and mention service fees or limits where relevant.
        {anchor_requirement}
        - Avoid repeating themes, devices, or fact patterns from previously generated scenarios in this run.
        - Output JSON only; no prose, no code fences.

        Style guidance for this label:
        {instructions or 'N/A'}

        {anchor_block}

        {context_hint}
        
        Full AppleCare+ policy text (use for citations):
        {policy_text}

        Example scenarios for inspiration:
        {examples_json}
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


def _summarize_for_context(scenario: Mapping[str, Any]) -> str:
    title = str(scenario.get("title") or scenario.get("id") or "Scenario").strip()
    references = scenario.get("policy_references")
    formatted_refs: List[str] = []
    if isinstance(references, Sequence):
        for ref in references:
            if not isinstance(ref, Mapping):
                continue
            section = str(ref.get("section") or "").strip()
            snippet = str(ref.get("snippet") or "").strip()
            if snippet:
                snippet = " ".join(snippet.split())
                if len(snippet) > 160:
                    snippet = snippet[:157].rstrip() + "..."
            if section and snippet:
                formatted_refs.append(f"{section}: {snippet}")
            elif section:
                formatted_refs.append(section)
            elif snippet:
                formatted_refs.append(snippet)
            if len(formatted_refs) >= 2:
                break
    refs_text = "; ".join(formatted_refs)
    return f"{title} — {refs_text}" if refs_text else title


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
        self.policy_anchors = _load_policy_anchors()

    def generate(
        self,
        settings: ScenarioGenerationSettings,
        *,
        scenario_paths: Mapping[ScenarioLabel, Path] | None = None,
        archive: bool = True,
        on_scenario: Callable[[ScenarioLabel, Mapping[str, Any], int, int], None] | None = None,
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
            "max_tokens_per_scenario": settings.max_tokens,
            "labels": {},
        }

        for label, count in counts.items():
            if count <= 0:
                continue
            label = _ensure_label(label)
            label_records: List[Mapping[str, Any]] = []
            previous_summaries: List[str] = []
            total_for_label = count
            raw_runs: List[Mapping[str, Any]] = []

            anchor_sequence = self._prepare_anchor_sequence(count)

            for idx in range(1, count + 1):
                policy_anchor = anchor_sequence[idx - 1] if anchor_sequence else None
                scenario_id = f"{LABEL_TO_PREFIX[label]}-{slug}-{idx:02d}"
                system_prompt, user_prompt = _build_prompt(
                    label=label,
                    scenario_id=scenario_id,
                    fewshot=self.fewshot[label],
                    policy_text=self.policy_text,
                    previous_summaries=previous_summaries,
                    policy_anchor=policy_anchor,
                )
                prompts_record = {
                    "system": system_prompt,
                    "user": user_prompt,
                    "previous_summaries": list(previous_summaries[-5:]),
                    "policy_anchor": policy_anchor,
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
                        if isinstance(parsed, list):
                            if len(parsed) != 1:
                                raise ScenarioGenerationError(
                                    f"Model must return exactly one scenario object for {label}"
                                )
                            scenario_payload = parsed[0]
                        elif isinstance(parsed, MutableMapping):
                            scenario_payload = parsed
                        else:
                            raise ScenarioGenerationError(
                                "Model must return a JSON object describing the scenario"
                            )
                        normalized = _normalize_scenario(
                            label,
                            scenario_payload,
                            new_id=scenario_id,
                        )
                        _validate_scenario(label, normalized)
                        self._attach_anchor_metadata(normalized, policy_anchor)
                        label_records.append(normalized)
                        summary = _summarize_for_context(normalized)
                        if summary:
                            previous_summaries.append(summary)
                        raw_runs.append(
                            {
                                "scenario_id": scenario_id,
                                "attempt": attempt,
                                "prompt": prompts_record,
                                "response": response_text,
                            }
                        )
                        if on_scenario is not None:
                            on_scenario(label, normalized, idx, total_for_label)
                        break
                    except Exception as exc:  # pragma: no cover - network/UI path
                        last_error = exc
                        if attempt > settings.retries:
                            raise ScenarioGenerationError(
                                f"Failed to generate scenario {scenario_id} for {label}: {exc}"
                            ) from exc
                else:
                    if last_error:
                        raise ScenarioGenerationError(
                            f"Failed to generate scenario {scenario_id} for {label}: {last_error}"
                        ) from last_error

            generated[label] = label_records
            raw_materials.setdefault("labels", {})[label] = raw_runs

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

    def _prepare_anchor_sequence(self, total_count: int) -> List[Optional[Mapping[str, Any]]]:
        if total_count <= 0:
            return []
        if not self.policy_anchors:
            return [None] * total_count

        anchors = list(self.policy_anchors)
        random.shuffle(anchors)
        sequence: List[Mapping[str, Any]] = []
        while len(sequence) < total_count:
            random.shuffle(anchors)
            sequence.extend(anchors)
        return sequence[:total_count]

    @staticmethod
    def _attach_anchor_metadata(
        scenario: MutableMapping[str, Any],
        policy_anchor: Optional[Mapping[str, Any]],
    ) -> None:
        if not policy_anchor:
            return

        metadata = scenario.get("metadata")
        if not isinstance(metadata, MutableMapping):
            metadata = {}
            scenario["metadata"] = metadata

        metadata["policy_anchor_id"] = policy_anchor.get("id")
        metadata["policy_anchor_section"] = policy_anchor.get("section")
        if policy_anchor.get("intent"):
            metadata["policy_anchor_intent"] = policy_anchor.get("intent")

        secondary_sections: List[str] = []
        references = scenario.get("policy_references")
        if isinstance(references, Sequence):
            for ref in references:
                if not isinstance(ref, Mapping):
                    continue
                section = str(ref.get("section") or "").strip()
                if not section:
                    continue
                if section == policy_anchor.get("section"):
                    continue
                if section not in secondary_sections:
                    secondary_sections.append(section)
        if secondary_sections:
            metadata["secondary_policy_sections"] = secondary_sections

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
