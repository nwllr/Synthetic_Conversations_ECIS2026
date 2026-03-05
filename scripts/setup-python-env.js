#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OPTIONAL_MODE = process.argv.includes("--optional");
const REPO_ROOT = process.cwd();
const REQUIREMENTS_PATH = path.join(REPO_ROOT, "requirements.txt");
const VENV_DIR = path.join(REPO_ROOT, ".venv");
const SKIP_SETUP = process.env.SKIP_PYTHON_SETUP === "1";

function log(message) {
  console.log(`[python-setup] ${message}`);
}

function error(message) {
  console.error(`[python-setup] ${message}`);
}

function exitWithFailure(message) {
  if (OPTIONAL_MODE) {
    log(`${message} (continuing because optional mode is enabled)`);
    process.exit(0);
  }
  error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    exitWithFailure(`Failed to run '${command} ${args.join(" ")}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    exitWithFailure(`Command failed with exit code ${result.status}: ${command} ${args.join(" ")}`);
  }
}

function detectPythonCommand() {
  const explicit = (process.env.PYTHON_BIN || "").trim();
  const candidates = explicit ? [explicit] : ["python3", "python"];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function resolveVenvPythonPath() {
  if (process.platform === "win32") {
    return path.join(VENV_DIR, "Scripts", "python.exe");
  }
  return path.join(VENV_DIR, "bin", "python");
}

if (SKIP_SETUP) {
  log("Skipping Python setup because SKIP_PYTHON_SETUP=1.");
  process.exit(0);
}

if (!fs.existsSync(REQUIREMENTS_PATH)) {
  exitWithFailure(`Missing ${REQUIREMENTS_PATH}.`);
}

const pythonCommand = detectPythonCommand();
if (!pythonCommand) {
  exitWithFailure(
    "No Python interpreter found. Install Python 3.9+ or set PYTHON_BIN to an available interpreter."
  );
}

if (!fs.existsSync(VENV_DIR)) {
  log(`Creating virtual environment at ${path.relative(REPO_ROOT, VENV_DIR)} using '${pythonCommand}'.`);
  run(pythonCommand, ["-m", "venv", VENV_DIR]);
}

const venvPython = resolveVenvPythonPath();
if (!fs.existsSync(venvPython)) {
  exitWithFailure(`Virtual environment exists but python executable is missing at ${venvPython}.`);
}

log("Installing Python dependencies...");
run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
run(venvPython, ["-m", "pip", "install", "-r", REQUIREMENTS_PATH]);

log("Python environment is ready.");
