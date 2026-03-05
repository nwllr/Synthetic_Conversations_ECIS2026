import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const VENV_CANDIDATES = [
  [".venv", "bin", "python3"],
  [".venv", "bin", "python"],
  [".venv", "Scripts", "python.exe"],
];

export function resolvePythonExecutable(rootDir: string = process.cwd()): string {
  const override = (process.env.PYTHON_BIN ?? "").trim();
  if (override) {
    return override;
  }

  for (const segments of VENV_CANDIDATES) {
    const candidate = path.join(rootDir, ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

export function pythonSetupHint(): string {
  return "Run `npm run setup:python` to install Python dependencies in `.venv`.";
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function canImportModule(pythonExecutable: string, moduleName: string): boolean {
  const probe = spawnSync(pythonExecutable, ["-c", `import ${moduleName}`], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

export type PythonRuntimeResolution = {
  executable: string;
  hasRequiredModule: boolean;
  requiredModule?: string;
  candidates: string[];
};

export function resolvePythonRuntime(
  rootDir: string = process.cwd(),
  requiredModule?: string
): PythonRuntimeResolution {
  const preferred = resolvePythonExecutable(rootDir);
  const candidates = unique([
    preferred,
    process.platform === "win32" ? "python" : "python3",
    "python",
  ]);

  if (!requiredModule) {
    return {
      executable: preferred,
      hasRequiredModule: true,
      candidates,
    };
  }

  for (const candidate of candidates) {
    if (canImportModule(candidate, requiredModule)) {
      return {
        executable: candidate,
        hasRequiredModule: true,
        requiredModule,
        candidates,
      };
    }
  }

  return {
    executable: preferred,
    hasRequiredModule: false,
    requiredModule,
    candidates,
  };
}
