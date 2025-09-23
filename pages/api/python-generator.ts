import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { randomBytes } from "crypto";

interface PythonGeneratorRequest {
  count?: number;
  scenarioId?: string;
  personaIndex?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxTurns?: number;
  seed?: number;
}

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "simulate_conversation.py");
const OUTPUT_ROOT = path.join(process.cwd(), "generated_conversations", "ui_runs");

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = (req.body ?? {}) as PythonGeneratorRequest;
  const count = Number.isFinite(body.count) && body.count! > 0 ? Math.floor(body.count!) : 1;

  try {
    await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  } catch (err) {
    console.error("Failed to prepare output root", err);
    return res.status(500).json({ error: "Failed to prepare output directory" });
  }

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomBytes(3).toString("hex")}`;
  const outputDir = path.join(OUTPUT_ROOT, runId);

  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create run directory", err);
    return res.status(500).json({ error: "Failed to create run directory" });
  }

  const args = [SCRIPT_PATH, "--output-dir", outputDir, "--count", String(count)];

  if (body.scenarioId) {
    args.push("--scenario-id", body.scenarioId);
  }
  if (Number.isInteger(body.personaIndex ?? NaN)) {
    args.push("--persona-index", String(body.personaIndex));
  }
  if (body.model) {
    args.push("--model", body.model);
  }
  if (Number.isFinite(body.temperature)) {
    args.push("--temperature", String(body.temperature));
  }
  if (Number.isFinite(body.maxTokens)) {
    args.push("--max-tokens", String(body.maxTokens));
  }
  if (Number.isFinite(body.maxTurns)) {
    args.push("--max-turns", String(body.maxTurns));
  }
  if (Number.isFinite(body.seed)) {
    args.push("--seed", String(body.seed));
  }

  let stdout = "";
  let stderr = "";

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("python3", args, {
      cwd: process.cwd(),
      env: process.env,
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      reject(error);
    });
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  }).catch((err) => {
    console.error("Failed to run python generator", err);
    return null;
  });

  if (exitCode === null) {
    return res.status(500).json({ error: "Failed to start python generator", stdout, stderr });
  }

  if (exitCode !== 0) {
    console.error("Python generator exited with code", exitCode, stderr);
    return res.status(500).json({
      error: `Python generator exited with code ${exitCode}`,
      stdout,
      stderr,
    });
  }

  let conversations: any[] = [];
  try {
    const files = await fs.readdir(outputDir);
    const jsonFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));
    conversations = await Promise.all(
      jsonFiles.map(async (file) => {
        const fullPath = path.join(outputDir, file);
        const text = await fs.readFile(fullPath, "utf-8");
        return JSON.parse(text);
      })
    );
  } catch (err) {
    console.error("Failed to read generated conversations", err);
    return res.status(500).json({
      error: "Failed to read generated conversations",
      stdout,
      stderr,
    });
  }

  return res.status(200).json({
    status: "ok",
    runId,
    outputDir: path.relative(process.cwd(), outputDir),
    stdout,
    stderr,
    conversations,
  });
}
