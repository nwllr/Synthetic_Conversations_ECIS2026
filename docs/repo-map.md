# Repository Map

## Core Application

- `pages/generation_pipeline.tsx`: Canonical UI for generation and evaluation.
- `pages/api/generation-pipeline.ts`: SSE API that orchestrates Python generation pipeline.
- `pages/api/deprecated_generate-stream.ts`: Direct TypeScript/OpenAI streaming generator.

## Legacy / Experimental UIs

- `pages/index.tsx`: Legacy generator interface.
- `pages/deprecated_python-generator.tsx`: Legacy Python-only UI.
- `pages/improve-scenarios.tsx`: Scenario ambiguity scoring and iterative improvement UI.

## Generation Logic

- `scripts/simulate_conversation.py`: Main CLI pipeline for scenario + conversation generation.
- `prompts/scenario_generation.py`: Scenario generation utility.
- `prompts/customer_prompt.py`: Customer role prompt and data loading.
- `prompts/bot_prompt.py`: Bot role prompt and instruction loading.

## Shared Libraries

- `lib/openai.ts`: OpenAI client wrapper.
- `lib/deprecated_prompt-templates.ts`: Prompt templates and few-shot structures.
- `lib/improve-scenarios/common.ts`: Shared helpers for improve-scenarios APIs.
- `types/deprecated_schema.ts`: Zod schemas for generated conversation validation.

## Data and Assets

- `policy/`: Policy text, policy anchors, and baseline scenarios.
- `characteristics/`: Bot instructions and customer personas/scenario sets.
- `generated_scenarios/samples/`: Curated sample scenario bundle.
- `generated_conversations/samples/`: Curated sample conversation run.

## Documentation

- `README.md`: Main project documentation and quickstart.
- `docs/reproducibility.md`: Deterministic runbook.
- `docs/repo-map.md`: This file.
- `docs/attribution.md`: Content provenance and usage notes.
- `docs/paper-context.md`: Mapping between paper concepts and artifact implementation.
- `docs/artifact-scope.md`: Scope and limitations of this public release.
