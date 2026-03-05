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

function writeEvent(res: NextApiResponse, event: string, payload: unknown) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (err) {
    console.error("Failed to write SSE event", err);
  }
}

export const config = { api: { bodyParser: true } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as PythonGeneratorRequest;
  const count = Number.isFinite(body.count) && body.count! > 0 ? Math.floor(body.count!) : 1;

  try {
    await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  } catch (err) {
    console.error("Failed to prepare output root", err);
    res.status(500).json({ error: "Failed to prepare output directory" });
    return;
  }

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomBytes(3).toString("hex")}`;
  const outputDir = path.join(OUTPUT_ROOT, runId);
  const relativeOutputDir = path.relative(process.cwd(), outputDir);

  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create run directory", err);
    res.status(500).json({ error: "Failed to create run directory" });
    return;
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

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  // Kick off the event stream
  res.write(": connected\n\n");

  writeEvent(res, "start", { runId, outputDir: relativeOutputDir, total: count });
  writeEvent(res, "progress", { total: count, generated: 0, errors: 0 });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutAll = "";
  let stderrAll = "";
  let generated = 0;
  let errors = 0;
  const conversations: any[] = [];
  const pendingReads: Promise<void>[] = [];

  const child = spawn("python3", args, {
    cwd: process.cwd(),
    env: process.env,
  });

  const processStdoutLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const match = trimmed.match(/Wrote conversation to (.+)$/);
    if (match) {
      const printedPath = match[1].trim();
      const resolvedPath = path.isAbsolute(printedPath)
        ? printedPath
        : path.join(process.cwd(), printedPath);
      const readPromise = (async () => {
        try {
          const text = await fs.readFile(resolvedPath, "utf-8");
          const conversation = JSON.parse(text);
          conversations.push(conversation);
          generated += 1;
          writeEvent(res, "item", { index: generated - 1, conversation });
          writeEvent(res, "progress", { total: count, generated, errors });
        } catch (err: any) {
          errors += 1;
          writeEvent(res, "error", {
            message: err?.message ?? String(err),
            path: printedPath,
          });
          writeEvent(res, "progress", { total: count, generated, errors });
        }
      })();
      pendingReads.push(readPromise);
    } else {
      writeEvent(res, "log", { stream: "stdout", message: trimmed });
    }
  };

  const flushStdout = () => {
    if (!stdoutBuffer) return;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      processStdoutLine(line);
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    stdoutAll += text;
    stdoutBuffer += text;
    flushStdout();
  });

  child.stdout?.on("close", () => {
    flushStdout();
    if (stdoutBuffer.trim()) {
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  });

  const flushStderr = () => {
    if (!stderrBuffer) return;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        writeEvent(res, "log", { stream: "stderr", message: trimmed });
      }
    }
  };

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderrAll += text;
    stderrBuffer += text;
    flushStderr();
  });

  child.stderr?.on("close", () => {
    flushStderr();
    if (stderrBuffer.trim()) {
      writeEvent(res, "log", { stream: "stderr", message: stderrBuffer.trim() });
      stderrBuffer = "";
    }
  });

  const finish = async (exitCode: number | null, fatalMessage?: string) => {
    await Promise.allSettled(pendingReads);
    if (fatalMessage) {
      writeEvent(res, "fatal", {
        message: fatalMessage,
        stdout: stdoutAll,
        stderr: stderrAll,
        runId,
        outputDir: relativeOutputDir,
        total: count,
        generated,
        errors,
      });
    } else if ((exitCode ?? 0) !== 0) {
      writeEvent(res, "fatal", {
        message: `Python generator exited with code ${exitCode}`,
        stdout: stdoutAll,
        stderr: stderrAll,
        runId,
        outputDir: relativeOutputDir,
        total: count,
        generated,
        errors,
      });
    } else {
      writeEvent(res, "done", {
        runId,
        outputDir: relativeOutputDir,
        total: count,
        generated,
        errors,
        stdout: stdoutAll,
        stderr: stderrAll,
        conversations,
      });
    }
    try {
      res.end();
    } catch {}
  };

  const completion = new Promise<void>((resolve) => {
    let finished = false;

    const finalize = (exitCode: number | null, fatalMessage?: string) => {
      if (finished) return;
      finished = true;
      finish(exitCode, fatalMessage).finally(resolve);
    };

    child.on("error", (err) => {
      stderrAll += `\n${err?.message ?? err}`;
      finalize(null, "Failed to start python generator");
    });

    child.on("close", (code) => {
      finalize(code ?? 0);
    });

    req.on("close", () => {
      if (!finished) {
        child.kill("SIGTERM");
      }
    });
  });

  await completion;
}
