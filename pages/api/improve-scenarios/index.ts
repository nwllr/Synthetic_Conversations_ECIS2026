import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs/promises";
import { OUTPUT_ROOT } from "../../../lib/improve-scenarios/common";

type ScenarioSummary = {
  conversationId: string;
  scenarioId?: string;
  scenarioTitle?: string;
  scenarioLabel?: string;
  groundTruth?: string;
  createdAt?: string;
  filePath: string;
};

type RunSummary = {
  runId: string;
  createdAt?: string;
  scenarioCount: number;
  edgeCaseCount: number;
  entries: ScenarioSummary[];
};

type ImproveScenariosResponse = {
  runs: RunSummary[];
  warnings: string[];
};

function parseRunTimestamp(runId: string): string | undefined {
  const match = runId.match(/^(\d{8}T\d{6})/);
  if (!match) return undefined;
  const raw = match[1];
  const datePart = raw.slice(0, 8);
  const timePart = raw.slice(9);
  if (datePart.length !== 8 || timePart.length !== 6) return undefined;
  const year = datePart.slice(0, 4);
  const month = datePart.slice(4, 6);
  const day = datePart.slice(6, 8);
  const hour = timePart.slice(0, 2);
  const minute = timePart.slice(2, 4);
  const second = timePart.slice(4, 6);
  const isoCandidate = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const timestamp = Number.isNaN(Date.parse(isoCandidate)) ? undefined : isoCandidate;
  return timestamp;
}

async function safeReadDir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

function toScenarioSummary(filePath: string, rawJson: string): ScenarioSummary | undefined {
  try {
    const parsed = JSON.parse(rawJson);
    const conversationId = typeof parsed?.id === "string" ? parsed.id : path.basename(filePath, path.extname(filePath));
    const scenario = parsed?.scenario ?? {};
    const scenarioId = typeof scenario?.id === "string" ? scenario.id : undefined;
    const scenarioTitle = typeof scenario?.title === "string" ? scenario.title : undefined;
    const groundTruth = typeof scenario?.ground_truth === "string" ? scenario.ground_truth : undefined;
    const createdAt = typeof parsed?.created_at === "string" ? parsed.created_at : undefined;
    const scenarioLabel = typeof parsed?.scenario_label === "string" ? parsed.scenario_label : undefined;

    return {
      conversationId,
      scenarioId,
      scenarioTitle,
      scenarioLabel,
      groundTruth,
      createdAt,
      filePath: path.relative(process.cwd(), filePath),
    };
  } catch (err) {
    return undefined;
  }
}

async function collectRunSummaries(): Promise<ImproveScenariosResponse> {
  const warnings: string[] = [];
  const dirEntries = await safeReadDir(OUTPUT_ROOT);
  const runIds = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  runIds.sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));

  const runs: RunSummary[] = [];

  for (const runId of runIds) {
    const runPath = path.join(OUTPUT_ROOT, runId);
    const files = await safeReadDir(runPath);
    const jsonFiles = files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name);

    const entries: ScenarioSummary[] = [];
    for (const fileName of jsonFiles) {
      const absolutePath = path.join(runPath, fileName);
      const rawJson = await safeReadFile(absolutePath);
      if (!rawJson) continue;
      const summary = toScenarioSummary(absolutePath, rawJson);
      if (summary) {
        entries.push(summary);
      } else {
        warnings.push(`Failed to parse ${path.relative(process.cwd(), absolutePath)}`);
      }
    }

    const edgeCaseCount = entries.filter((entry) => entry.groundTruth === "edge_case" || entry.scenarioLabel === "edge_case").length;
    runs.push({
      runId,
      createdAt: parseRunTimestamp(runId),
      scenarioCount: entries.length,
      edgeCaseCount,
      entries,
    });
  }

  return { runs, warnings };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const payload = await collectRunSummaries();
    res.status(200).json(payload);
  } catch (err: any) {
    console.error("Failed to load scenario runs", err);
    res.status(500).json({ error: "Failed to load scenario runs" });
  }
}
