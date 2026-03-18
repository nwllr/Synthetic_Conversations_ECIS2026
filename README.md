# Synthetic Conversation Generator

A research artifact for generating synthetic multi-turn conversations to support scalable functional testing of conversational AI systems.

## Relation to the Paper

This repository accompanies the paper:

**"Generating Synthetic Multi-Turn Conversations for Scalable Functional Testing of Conversational AI Systems"**

- Currently under review at the European Conference on Information Systems (ECIS 2026) 
- Publication link: `not_yet_available`

This artifact focuses on the implementation and reproducibility workflow, not on reproducing every evaluation claim from the paper in CI.

## Canonical Entry Points

The publication surface is limited to these UI routes:

- `/` (workflow chooser)
- `/generation_pipeline`
- `/improve-scenarios`

## What This Repository Contains

- Next.js app for the canonical workflows above.
- API routes required by those workflows.
- Python CLI for scenario generation and conversation simulation: `scripts/simulate_conversation.py`.
- Prompt, persona, and policy assets required by the UI and CLI.
- Historical generated outputs under `generated_scenarios/` and `generated_conversations/`.

## Quickstart (UI First)

### 1) Install

```bash
npm install
```

### 2) Run the app

```bash
npm run dev
```

### 3) Use the UI

Open `http://localhost:3000/` and choose a workflow.
You can paste your OpenAI API key directly into the UI, so no environment configuration is required for basic UI usage.

If `/generation_pipeline` reports missing Python dependencies, run:

```bash
npm run setup:python
```

## Optional Setup and Validation

### Configure environment key (optional)

Set `OPENAI_API_KEY` if you do not want to paste the key in the UI each time, or if you run CLI commands:

```bash
export OPENAI_API_KEY=<your_key>
```

### Validate project health (optional)

```bash
npm run lint
npm run typecheck
npm run smoke
npm run build
```

## CLI

The retained CLI entry point is `scripts/simulate_conversation.py`.

Example deterministic run:

```bash
./.venv/bin/python scripts/simulate_conversation.py \
  --count 3 \
  --seed 42 \
  --model gpt-4.1-mini \
  --temperature 0.7 \
  --max-tokens 400 \
  --max-turns 12 \
  --output-dir generated_conversations/ui_runs/repro_seed42
```

## Architecture Overview

1. Scenario generation (policy-guided, label-aware).
2. Persona-conditioned customer role-play.
3. Bot/customer turn-taking conversation simulation.
4. Optional edge-case scoring and iterative refinement.

Primary files:

- `pages/index.tsx`
- `pages/generation_pipeline.tsx`
- `pages/improve-scenarios.tsx`
- `pages/api/generation-pipeline.ts`
- `pages/api/improve-scenarios/*`
- `scripts/simulate_conversation.py`

## Data and Asset Provenance

This repository includes policy/scenario/persona-related assets used in the research context.

- Keep in mind non-code assets may carry separate usage constraints.

## Known Limitations / Non-Goals

- This is a research artifact, not a production service.
- DP6-style convergence stopping is not implemented.

## Citation

If you use this artifact, please cite following paper.

```bibtex
@software{synthetic_conversation_generator_2026,
  title = {Generating Synthetic Multi-Turn Conversations for Scalable Functional Testing of Conversational AI Systems},
  author = {Niklas Weller, Shijing Cai, Syang Zhou},
  year = {2026},
  url = {not_yet_available}
}
```

## License

Licensed under Apache 2.0. See [LICENSE](LICENSE).
