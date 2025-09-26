import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { randomBytes } from "crypto";

interface ScenarioCountsPayload {
  covered?: number;
  notCovered?: number;
  edgeCase?: number;
}

interface GenerationPipelineRequest {
  counts?: ScenarioCountsPayload;
  scenarioModel?: string;
  scenarioTemperature?: number;
  scenarioMaxTokens?: number;
  conversationModel?: string;
  conversationTemperature?: number;
  conversationMaxTokens?: number;
  conversationMaxTurns?: number;
  personaIndex?: number;
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

function toPositiveInt(value: unknown, defaultValue = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : defaultValue;
}

export const config = { api: { bodyParser: true } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as GenerationPipelineRequest;
  const counts = body.counts ?? {};
  const covered = toPositiveInt(counts.covered, 0);
  const notCovered = toPositiveInt(counts.notCovered, 0);
  const edgeCase = toPositiveInt(counts.edgeCase, 0);
  const total = covered + notCovered + edgeCase;

  if (total <= 0) {
    res.status(400).json({ error: "Provide at least one scenario to generate." });
    return;
  }

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

  const args = [
    SCRIPT_PATH,
    "--output-dir",
    outputDir,
    "--generate-scenarios",
    "--count",
    String(total),
  ];

  if (covered > 0) args.push("--scenario-count-covered", String(covered));
  if (notCovered > 0) args.push("--scenario-count-not-covered", String(notCovered));
  if (edgeCase > 0) args.push("--scenario-count-edge-case", String(edgeCase));

  if (body.scenarioModel) args.push("--scenario-model", body.scenarioModel);
  if (typeof body.scenarioTemperature === "number") {
    args.push("--scenario-temperature", String(body.scenarioTemperature));
  }
  if (typeof body.scenarioMaxTokens === "number") {
    args.push("--scenario-max-tokens", String(Math.max(1, Math.floor(body.scenarioMaxTokens))));
  }
  if (body.personaIndex !== undefined && Number.isFinite(body.personaIndex)) {
    args.push("--persona-index", String(body.personaIndex));
  }
  if (body.conversationModel) {
    args.push("--model", body.conversationModel);
  }
  if (typeof body.conversationTemperature === "number") {
    args.push("--temperature", String(body.conversationTemperature));
  }
  if (typeof body.conversationMaxTokens === "number") {
    args.push("--max-tokens", String(Math.max(1, Math.floor(body.conversationMaxTokens))));
  }
  if (typeof body.conversationMaxTurns === "number") {
    args.push("--max-turns", String(Math.max(1, Math.floor(body.conversationMaxTurns))));
  }
  if (body.seed !== undefined && Number.isFinite(body.seed)) {
    args.push("--seed", String(body.seed));
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  writeEvent(res, "start", { runId, outputDir: relativeOutputDir, total, scenariosGenerated: 0 });

  const scenarios: any[] = [];
  const conversations: any[] = [];
  const pendingReads: Promise<void>[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutAll = "";
  let stderrAll = "";
  let generatedCount = 0;
  let conversationProgressCount = 0;
  let errorCount = 0;

  const emitProgress = () => {
    const generatedProgress = Math.max(generatedCount, conversationProgressCount);
    writeEvent(res, "progress", {
      total,
      generated: generatedProgress,
      errors: errorCount,
      scenariosGenerated: scenarios.length,
    });
  };

  emitProgress();

  const child = spawn("python3", args, {
    cwd: process.cwd(),
    env: process.env,
  });

  const processStdoutLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const scenarioPrefix = "SCENARIO_GENERATED:";
    const conversationPrefix = "CONVERSATION_GENERATED:";
    if (trimmed.startsWith(scenarioPrefix)) {
      const payloadText = trimmed.slice(scenarioPrefix.length).trim();
      try {
        const parsed = JSON.parse(payloadText);
        const scenarioRecord = {
          index: scenarios.length,
          label: parsed?.label,
          scenario: parsed?.scenario ?? parsed,
        };
        scenarios.push(scenarioRecord);
        writeEvent(res, "scenario", scenarioRecord);
        emitProgress();
      } catch (err: any) {
        writeEvent(res, "log", {
          stream: "stderr",
          message: `Failed to parse scenario payload: ${err?.message ?? String(err)}`,
        });
      }
      return;
    }

    if (trimmed.startsWith(conversationPrefix)) {
      const payloadText = trimmed.slice(conversationPrefix.length).trim();
      try {
        const parsed = JSON.parse(payloadText);
        const idx = Number(parsed?.index);
        const totalCount = Number(parsed?.total);
        if (Number.isFinite(idx)) {
          conversationProgressCount = Math.max(conversationProgressCount, idx);
        }
        emitProgress();
        const parts: string[] = [];
        if (Number.isFinite(idx) && Number.isFinite(totalCount)) {
          parts.push(`Generated conversation ${idx}/${totalCount}`);
        }
        if (parsed?.conversation_id) {
          parts.push(String(parsed.conversation_id));
        }
        if (parsed?.scenario_id) {
          parts.push(`scenario ${parsed.scenario_id}`);
        }
        const message = parts.join(" · ") || `Generated conversation progress: ${payloadText}`;
        writeEvent(res, "log", { stream: "stdout", message });
      } catch (err: any) {
        writeEvent(res, "log", {
          stream: "stderr",
          message: `Failed to parse conversation payload: ${err?.message ?? String(err)}`,
        });
      }
      return;
    }

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
          generatedCount += 1;
          writeEvent(res, "item", { index: generatedCount - 1, conversation });
          conversationProgressCount = Math.max(conversationProgressCount, generatedCount);
          emitProgress();
        } catch (err: any) {
          errorCount += 1;
          writeEvent(res, "error", {
            message: err?.message ?? String(err),
            path: printedPath,
          });
          emitProgress();
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
        total,
        generated: generatedCount,
        errors: errorCount,
        scenariosGenerated: scenarios.length,
        conversations,
        scenarios,
      });
      res.end();
      return;
    }

    writeEvent(res, "done", {
      runId,
      outputDir: relativeOutputDir,
      total,
      generated: generatedCount,
      errors: errorCount,
      scenariosGenerated: scenarios.length,
      stdout: stdoutAll,
      stderr: stderrAll,
      conversations,
      scenarios,
      exitCode,
    });
    res.end();
  };

  child.on("close", (code) => {
    finish(code);
  });

  child.on("error", (err) => {
    console.error("Failed to spawn python process", err);
    finish(child.exitCode, err?.message ?? "Failed to spawn python process");
  });

  req.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  });
}
