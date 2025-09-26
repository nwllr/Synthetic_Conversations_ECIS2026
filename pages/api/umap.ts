import type { NextApiRequest, NextApiResponse } from "next";
import { spawn } from "child_process";
import path from "path";

type UmapRequestPayload = {
  vectors: number[][];
  nNeighbors?: number;
  minDist?: number;
  metric?: string;
};

type UmapResponsePayload = {
  coords: number[][];
};

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "compute_umap.py");

export default async function handler(req: NextApiRequest, res: NextApiResponse<UmapResponsePayload | { error: string }>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { vectors, nNeighbors, minDist, metric } = req.body as UmapRequestPayload;

  if (!Array.isArray(vectors) || vectors.length === 0 || !Array.isArray(vectors[0])) {
    res.status(400).json({ error: "Provide non-empty 'vectors' array" });
    return;
  }

  // Short-circuit for degenerate cases to avoid spawning Python unnecessarily.
  if (vectors.length === 1) {
    res.status(200).json({ coords: [[0, 0]] });
    return;
  }

  const payload = {
    vectors,
    n_neighbors: typeof nNeighbors === "number" ? nNeighbors : undefined,
    min_dist: typeof minDist === "number" ? minDist : undefined,
    metric: typeof metric === "string" ? metric : undefined,
  };

  try {
    const coords = await runPythonUmap(payload);
    res.status(200).json({ coords });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "UMAP computation failed" });
  }
}

function runPythonUmap(payload: Record<string, unknown>): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [SCRIPT_PATH], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to launch python: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        let message = stderr.trim() || stdout.trim() || `Python exited with code ${code}`;
        try {
          const parsed = JSON.parse(message);
          if (parsed?.error) {
            message = parsed.error;
          }
        } catch {
          // Keep original message
        }
        reject(new Error(message));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed || !Array.isArray(parsed.coords)) {
          reject(new Error("Invalid response from UMAP script"));
          return;
        }
        resolve(parsed.coords as number[][]);
      } catch (err) {
        reject(new Error(`Failed to parse UMAP output: ${(err as Error).message}`));
      }
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}
