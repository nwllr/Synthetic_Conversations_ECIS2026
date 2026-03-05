# Synthetic Conversation Generator

A research artifact for generating synthetic multi-turn conversations to support scalable functional testing of conversational AI systems.

## Relation to the Paper

This repository accompanies the paper:

**"Generating Synthetic Multi-Turn Conversations for Scalable Functional Testing of Conversational AI Systems"**

- Publication link: `https://doi.org/<to-be-updated>`
- Paper draft text is available locally as `paper.txt`.

This artifact focuses on the implementation and reproducibility workflow, not on reproducing every evaluation claim from the paper in CI.

## Canonical Entry Point

The canonical UI path is:

- `/` (workflow chooser)
- `/generation_pipeline`
- `/improve-scenarios`

## What This Repository Contains

- Next.js app with generation/evaluation UIs.
- API routes for scenario and conversation generation pipelines.
- Python generation pipeline (`scripts/simulate_conversation.py`).
- Prompt and policy assets used in the research setting.
- Curated sample outputs under:
  - `generated_scenarios/samples/`
  - `generated_conversations/samples/`

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

## Optional: Reproduce a Small Deterministic Run

CLI example:

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

For a detailed runbook, see [docs/reproducibility.md](docs/reproducibility.md).

## Architecture Overview

1. Scenario generation (policy-guided, label-aware).
2. Persona-conditioned customer role-play.
3. Bot/customer turn-taking conversation simulation.
4. Optional edge-case scoring and iterative refinement.

Primary files:

- `pages/generation_pipeline.tsx`
- `pages/api/generation-pipeline.ts`
- `scripts/simulate_conversation.py`
- `prompts/scenario_generation.py`

See [docs/repo-map.md](docs/repo-map.md) for the full map.

## Data and Asset Provenance

This repository includes policy/scenario/persona-related assets used in the research context.

- Keep in mind non-code assets may carry separate usage constraints.
- See [docs/attribution.md](docs/attribution.md) for details.

## Known Limitations / Non-Goals

- This is a research artifact, not a production service.
- DP6-style convergence stopping is not implemented.


See [docs/artifact-scope.md](docs/artifact-scope.md) and [docs/paper-context.md](docs/paper-context.md).

## Citation

If you use this artifact, cite both the paper and this software.

```bibtex
@software{synthetic_conversation_generator_2026,
  title = {Synthetic Conversation Generator for Functional Testing},
  author = {Research Team},
  year = {2026},
  url = {https://github.com/<org>/<repo>}
}
```

Also see `CITATION.cff`.

## License

Licensed under Apache 2.0. See [LICENSE](LICENSE).
