// /pages/api/generate-stream.ts
import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs/promises";
import { randomBytes } from "crypto";
import { createChatCompletion } from "../../lib/openai";
import { buildPrompt, TEMPERATURE_BY_DIFFICULTY, PromptOptions } from "../../lib/prompt-templates";
import { parseAndValidateConversation, Conversation } from "../../types/schema";

type CoverageDecisionStr = "covered" | "not_covered" | "edgecase";
type DifficultyChoice = "easy" | "medium" | "hard" | "random";
type LengthChoice = "short" | "medium" | "long" | "random";
type ToneChoice =
  | "friendly"
  | "professional"
  | "neutral"
  | "apologetic"
  | "assertive"
  | "casual"
  | "custom"
  | "random";
type TurnsMode = "short" | "average" | "long" | "random";

type GenerateRequest = {
  total: number;
  covered?: CoverageDecisionStr;
  difficulty?: DifficultyChoice;
  turns?: number;         // legacy numeric; if provided, overrides turnsMode
  turnsMode?: TurnsMode;
  tone?: ToneChoice;
  length?: LengthChoice;
  noise?: boolean;
  incidentTypes?: string[];
  failureModesConfig?: {
    fraudProbability?: number;
    inconsistentProbability?: number;
    missingInfoProbability?: number;
    amountAnomalyProbability?: number;
  };
};

const DIFFICULTIES: Exclude<DifficultyChoice, "random">[] = ["easy", "medium", "hard"];
const LENGTHS: Exclude<LengthChoice, "random">[] = ["short", "medium", "long"];
const TONES: Exclude<ToneChoice, "random">[] = [
  "friendly","professional","neutral","apologetic","assertive","casual","custom"
];
const TURNS_RANGES: Record<Exclude<TurnsMode, "random">, [number, number]> = {
  short: [2, 6],
  average: [6, 10],
  long: [10, 20],
};

const POLICY_FILE_PATH = "policy/applecareplus.txt";

let cachedPolicyText: string | null = null;
let policyLoadPromise: Promise<string> | null = null;

async function getPolicyText(): Promise<string> {
  if (cachedPolicyText !== null) return cachedPolicyText;
  if (!policyLoadPromise) {
    policyLoadPromise = fs
      .readFile(POLICY_FILE_PATH, "utf8")
      .then((text) => {
        cachedPolicyText = text;
        return text;
      })
      .catch((err: any) => {
        console.warn(
          `Could not read policy file at ${POLICY_FILE_PATH}:`,
          err?.message ?? String(err)
        );
        cachedPolicyText = "";
        return "";
      });
  }
  return policyLoadPromise!;
}

// RNG
const sysRandom = () => {
  try {
    // @ts-ignore
    if (globalThis.crypto?.getRandomValues) {
      const a = new Uint32Array(1);
      globalThis.crypto.getRandomValues(a);
      return a[0] / 2 ** 32;
    }
  } catch {}
  try {
    const buf = randomBytes(4);
    const n = buf.readUInt32BE(0);
    return n / 2 ** 32;
  } catch {}
  return Math.random();
};
const randomInt = (min: number, max: number) =>
  Math.floor(sysRandom() * (max - min + 1)) + min;
const pick = <T,>(arr: T[]) => arr[Math.floor(sysRandom() * arr.length)];

function extractFirstJsonObject(s: string): string | null {
  if (!s) return null;
  let t = s.trim().replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        try { JSON.parse(candidate); return candidate; } catch {}
      }
    }
  }
  return null;
}

function normalizeCovered(v: any): CoverageDecisionStr {
  if (v === "covered" || v === "not_covered" || v === "edgecase") return v;
  return "edgecase";
}
function writeEvent(res: NextApiResponse, event: string, payload: any) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

export const config = { api: { bodyParser: true } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const body = req.body as GenerateRequest;

  const total = Math.max(1, Math.min(10000, body.total ?? 10));
  const covered = normalizeCovered(body.covered);
  const difficulty = body.difficulty ?? "medium";
  const turnsLegacy = typeof body.turns === "number" ? Math.max(2, Math.min(50, body.turns!)) : undefined;
  const turnsMode = body.turnsMode ?? "average";
  const tone = body.tone ?? "neutral";
  const length = body.length ?? "short";
  const noise = body.noise ?? false;
  const incidentTypes = body.incidentTypes ?? [
    "screen damage (drop)","liquid damage","theft","battery issue","software malfunction"
  ];
  const failureModesConfig = {
    fraudProbability: body.failureModesConfig?.fraudProbability ?? 0.2,
    inconsistentProbability: body.failureModesConfig?.inconsistentProbability ?? 0.1,
    missingInfoProbability: body.failureModesConfig?.missingInfoProbability ?? 0.2,
    amountAnomalyProbability: body.failureModesConfig?.amountAnomalyProbability ?? 0.1,
  };

  const policyText = await getPolicyText();

  let generated = 0;
  let errors = 0;
  let aborted = false;
  req.on("close", () => { aborted = true; });

  writeEvent(res, "progress", { requested: total, generated, errors });

  for (let i = 0; i < total; i++) {
    if (aborted) break;

    const id = `conv_${String(i + 1).padStart(6, "0")}`;

    const resolvedDifficulty = difficulty === "random" ? pick(DIFFICULTIES) : (difficulty as any);
    const resolvedTone = tone === "random" ? pick(TONES) : (tone as any);
    const resolvedLength = length === "random" ? pick(LENGTHS) : (length as any);

    let resolvedTurns: number;
    let resolvedTurnsBucket: Exclude<TurnsMode, "random">;
    if (typeof turnsLegacy === "number") {
      resolvedTurns = turnsLegacy;
      resolvedTurnsBucket = resolvedTurns <= 6 ? "short" : resolvedTurns <= 10 ? "average" : "long";
    } else {
      resolvedTurnsBucket = turnsMode === "random" ? pick(["short","average","long"] as const) : turnsMode;
      const [minT, maxT] = TURNS_RANGES[resolvedTurnsBucket];
      resolvedTurns = randomInt(minT, maxT);
    }

    const promptOpts: PromptOptions = {
      id,
      covered,
      difficulty: resolvedDifficulty,
      turns: resolvedTurns,
      tone: resolvedTone,
      length: resolvedLength,
      noise,
      incidentTypes,
      configured_failure_modes: failureModesConfig,
    };

    const prompt = buildPrompt(policyText, promptOpts);
    const temperature = TEMPERATURE_BY_DIFFICULTY[resolvedDifficulty] ?? 0.6;

    try {
      const completion = await createChatCompletion({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a claims intake assistant. Output exactly one JSON object matching the requested schema." },
          { role: "user", content: prompt },
        ],
        temperature,
        max_tokens: 2000,
        n: 1,
        response_format: { type: "json_object" } as any,
      });

      const rawText =
        // @ts-ignore
        completion?.choices?.[0]?.message?.content ??
        // @ts-ignore
        completion?.choices?.[0]?.text ??
        JSON.stringify(completion);

      const rawStr = typeof rawText === "string" ? rawText.trim() : String(rawText);
      const salvaged = extractFirstJsonObject(rawStr);
      const jsonText = salvaged ?? rawStr;

      let conv: Conversation | null = null;
      try {
        conv = parseAndValidateConversation(jsonText) as Conversation;
      } catch {
        // Repair
        const repairPrompt = `Reformat into ONE valid JSON object matching the schema.\n\n${rawStr}`;
        const repair = await createChatCompletion({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: "You are a JSON formatter. Output only valid JSON, no explanations." },
            { role: "user", content: repairPrompt },
          ],
          temperature: 0.0,
          max_tokens: 1200,
          n: 1,
          response_format: { type: "json_object" } as any,
        });
        const repairedRaw =
          // @ts-ignore
          repair?.choices?.[0]?.message?.content ??
          repair?.choices?.[0]?.text ??
          JSON.stringify(repair);
        const repairedStr = typeof repairedRaw === "string" ? repairedRaw.trim() : String(repairedRaw);
        const repairedJson = extractFirstJsonObject(repairedStr) ?? repairedStr;
        conv = parseAndValidateConversation(repairedJson) as Conversation;
        (conv as any)._raw_model_output_original = rawStr;
        (conv as any)._raw_model_output = repairedJson;
      }

      conv!.metadata = {
        ...conv!.metadata,
        configured_failure_modes: failureModesConfig,
      };
      (conv as any)._server_selected = {
        difficulty: resolvedDifficulty,
        tone: resolvedTone,
        length: resolvedLength,
        turns: resolvedTurns,
        turns_bucket: resolvedTurnsBucket,
        covered,
      };
      (conv as any)._prompt = prompt;
      if ((conv as any)._raw_model_output == null) (conv as any)._raw_model_output = jsonText;

      generated += 1;
      writeEvent(res, "item", { index: i, conversation: conv });
      writeEvent(res, "progress", { requested: total, generated, errors });
    } catch (err: any) {
      errors += 1;
      writeEvent(res, "error", { index: i, error: err.message ?? String(err) });
      writeEvent(res, "progress", { requested: total, generated, errors });
    }
  }

  writeEvent(res, "done", { requested: total, generated, errors });
  try { res.end(); } catch {}
}
