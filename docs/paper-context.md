# Paper-to-Code Context Map

This file maps the paper's design principles (DPs) and design features (DFs) to concrete implementation points in this repository.

## Design Principles (DP)

- **DP1 (ground truth in generation and evaluation)**
  - Scenario labels and `ground_truth` fields in `characteristics/customer/*.json`
  - Validation/evaluation in `pages/api/improve-scenarios/check.ts`

- **DP2 (equivalence partitioning / coverage)**
  - Category-based scenario generation (`covered`, `not_covered`, `edge_case`) in `prompts/scenario_generation.py`
  - Policy-anchor guidance in `policy/policy_anchors.json`

- **DP3 (iterative improvement for boundary cases)**
  - Iterative rewrite and re-simulation in `pages/api/improve-scenarios/increase.ts`

- **DP4 (realistic multi-step role-play generation)**
  - Scenario generation then dialogue simulation in `scripts/simulate_conversation.py`

- **DP5 (persona-conditioned simulation)**
  - Persona loading and prompt injection in `prompts/customer_prompt.py`

- **DP6 (stop based on metric stabilization)**
  - Conceptually supported, but full convergence-based stop criteria are not fully implemented in this release.

## Design Features (DF)

- **DF1/DF2**: Policy + anchors in scenario prompts
  - `prompts/scenario_generation.py`, `policy/policy_anchors.json`
- **DF3**: Edge-case ambiguity refinement
  - `pages/api/improve-scenarios/increase.ts`
- **DF4/DF5**: Role-play dialogue generation and info asymmetry
  - `scripts/simulate_conversation.py`, `prompts/*.py`
- **DF6**: Persona sampling/conditioning
  - `prompts/customer_prompt.py`, `characteristics/customer/personas.json`
- **DF7**: Evaluation-facing instrumentation
  - `pages/generation_pipeline.tsx` and improve-scenarios pages/APIs
