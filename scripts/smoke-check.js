const fs = require('fs');
const path = require('path');

const requiredPaths = [
  'pages/index.tsx',
  'pages/generation_pipeline.tsx',
  'pages/improve-scenarios.tsx',
  'pages/deprecated_python-generator.tsx',
  'pages/api/generation-pipeline.ts',
  'pages/api/umap.ts',
  'pages/api/deprecated_generate-stream.ts',
  'pages/api/deprecated_python-generator.ts',
  'scripts/simulate_conversation.py',
  'scripts/setup-python-env.js',
  'lib/python-runtime.ts',
  'requirements.txt',
  'policy/applecareplus.txt',
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
