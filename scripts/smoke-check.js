const fs = require('fs');
const path = require('path');

const requiredPaths = [
  'pages/index.tsx',
  'pages/generation_pipeline.tsx',
  'pages/improve-scenarios.tsx',
  'pages/api/generation-pipeline.ts',
  'pages/api/scenario-embeddings.ts',
  'pages/api/umap.ts',
  'pages/api/improve-scenarios/index.ts',
  'pages/api/improve-scenarios/check.ts',
  'pages/api/improve-scenarios/increase.ts',
  'scripts/simulate_conversation.py',
  'scripts/setup-python-env.js',
  'scripts/compute_umap.py',
  'lib/python-runtime.ts',
  'lib/openai.ts',
  'lib/improve-scenarios/common.ts',
  'requirements.txt',
  'policy/applecareplus.txt',
  'policy/policy_anchors.json',
  'characteristics/bot/instructions_modified.json',
  'characteristics/customer/personas.json',
  'characteristics/customer/scenario.json',
  'characteristics/customer/cov_scenarios.json',
  'characteristics/customer/nc_scenarios.json',
  'characteristics/customer/ec_scenarios.json',
  'prompts/bot_prompt.py',
  'prompts/customer_prompt.py',
  'prompts/scenario_generation.py',
  'prompts/scenario_fewshots.json',
  'generated_scenarios/samples/sample_bundle/metadata.json',
  'generated_conversations/samples/sample_run/COV-20251017T112101Z-01_20251017T112228Z.json',
];

const missing = requiredPaths.filter((p) => !fs.existsSync(path.join(process.cwd(), p)));

if (missing.length > 0) {
  console.error('Smoke check failed. Missing required files:');
  for (const item of missing) console.error(`- ${item}`);
  process.exit(1);
}

console.log('Smoke check passed.');
