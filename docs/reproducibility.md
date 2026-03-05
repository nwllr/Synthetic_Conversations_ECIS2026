# Reproducibility Runbook

This runbook focuses on small deterministic runs suitable for validating setup and artifact behavior.

## Prerequisites

- Node.js 18+
- Python 3.9+
- OpenAI API key in environment (`OPENAI_API_KEY`)

Install dependencies:

```bash
npm install
```

## Deterministic Small Run (CLI)

Use the canonical generation script with a fixed seed:

```bash
python3 scripts/simulate_conversation.py \
  --count 3 \
  --seed 42 \
  --model gpt-4.1-mini \
  --temperature 0.7 \
  --max-tokens 400 \
  --max-turns 12 \
  --output-dir generated_conversations/ui_runs/repro_seed42
```

## Deterministic Scenario + Conversation Pipeline

```bash
python3 scripts/simulate_conversation.py \
  --generate-scenarios \
  --scenario-count-covered 1 \
  --scenario-count-not-covered 1 \
  --scenario-count-edge-case 1 \
  --count 3 \
  --seed 42 \
  --scenario-model gpt-4.1 \
  --model gpt-4.1-mini \
  --output-dir generated_conversations/ui_runs/repro_pipeline_seed42
```

## Expected Artifacts Checklist

- One or more `*.json` conversation files in the selected output directory.
- Generated scenarios archived under `generated_scenarios/` when scenario generation is enabled.
- Each conversation file contains:
  - `id`, `created_at`, model parameters
  - `scenario`, `persona`, `system_prompts`
  - `messages` with turn-taking customer/bot dialogue

## UI Validation

Run development server:

```bash
npm run dev
```

Then confirm:

- `http://localhost:3000/` loads (workflow chooser).
- Canonical pages load: `/generation_pipeline`, `/improve-scenarios`.

## Troubleshooting

- `OPENAI_API_KEY` missing: API routes and Python generation will fail.
- Python package issues for UMAP: install `numpy` and `umap-learn`.
- Build/type issues: run `npm run typecheck` and `npm run lint`.
