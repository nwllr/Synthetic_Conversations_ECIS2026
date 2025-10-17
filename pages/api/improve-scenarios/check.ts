import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs/promises";
import OpenAI from "openai";

const OUTPUT_ROOT = path.join(process.cwd(), "generated_conversations", "ui_runs");
const POLICY_PATH = path.join(process.cwd(), "policy", "applecareplus.txt");
const DEFAULT_MODEL = "gpt-4.1-mini";

type DifficultyRequestBody = {
  filePaths?: string[];
  apiKey?: string;
  model?: string;
};

type DifficultyResult = {
  filePath: string;
  conversationId?: string;
  completion?: string;
  decisionToken?: string;
  decision?: "covered" | "not_covered" | "unknown";
  logProbabilities: {
    covered: number | null;
    notCovered: number | null;
  };
  probabilities: {
    covered: number | null;
    notCovered: number | null;
  };
  error?: string;
  prompt?: string;
};

type DifficultyResponseBody = {
  model: string;
  results: DifficultyResult[];
  warnings: string[];
};

let cachedPolicy: string | null = null;

async function getPolicyText(): Promise<string> {
  if (cachedPolicy !== null) return cachedPolicy;
  try {
    const text = await fs.readFile(POLICY_PATH, "utf-8");
    cachedPolicy = text;
    return text;
  } catch (err: any) {
    console.warn(`Failed to read policy file at ${POLICY_PATH}:`, err?.message ?? String(err));
    cachedPolicy = "";
    return "";
  }
}

function isValidSelection(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.startsWith("generated_conversations/ui_runs/")) return false;
  const resolved = path.resolve(process.cwd(), normalized);
  return resolved.startsWith(OUTPUT_ROOT + path.sep);
}

async function loadConversation(filePath: string): Promise<{ conversationId?: string; messages: any[] } | null> {
  if (!isValidSelection(filePath)) return null;
  const resolved = path.resolve(process.cwd(), filePath);
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw);
    const conversationId = typeof parsed?.id === "string" ? parsed.id : undefined;
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return { conversationId, messages };
  } catch (err) {
    return null;
  }
}

function buildTranscript(messages: any[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return "(no messages)";
  return messages
    .map((entry: any, index: number) => {
      const speakerRaw = typeof entry?.speaker === "string" ? entry.speaker : "unknown";
      const speaker = speakerRaw.toLowerCase() === "bot" ? "Agent" : speakerRaw.toLowerCase() === "customer" ? "Customer" : `Turn ${index + 1}`;
      const text = typeof entry?.text === "string" ? entry.text : typeof entry?.raw_text === "string" ? entry.raw_text : "";
      return `${speaker}: ${text}`;
    })
    .join("\n");
}

function normalizeToken(token: string): string {
  return token
    .replace(/[\s\u0120\u010A\u2581]+$/g, "")
    .replace(/^[\s\u0120\u010A\u2581]+/g, "")
    .trim();
}

function computeProbabilities(logprob: number | null) {
  if (logprob === null || Number.isNaN(logprob)) return null;
  const value = Math.exp(logprob);
  if (!Number.isFinite(value)) return null;
  return value;
}

async function evaluateConversation(
  client: OpenAI,
  model: string,
  policyText: string,
  filePath: string
): Promise<DifficultyResult> {
  const fallbackResult: DifficultyResult = {
    filePath,
    logProbabilities: { covered: null, notCovered: null },
    probabilities: { covered: null, notCovered: null },
    prompt: undefined,
  };

  const loaded = await loadConversation(filePath);
  if (!loaded) {
    return { ...fallbackResult, error: "Unable to load conversation" };
  }

  const transcript = buildTranscript(loaded.messages);
  const prompt = `Policy Document:\n${policyText}\n\nConversation Transcript:\n${transcript}\n\nDecide coverage strictly using the policy. Output must start with only one uppercase letter without any leading whitespace: 'C' if covered, 'N' if not covered.`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an AppleCare+ claim adjudicator. Determine policy coverage precisely. Begin your reply with 'C' for covered or 'N' for not covered, then provide a brief justification referencing the policy.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 64,
      logprobs: true,
      top_logprobs: 20,
    });

    const choice = response.choices?.[0];
    const messageContent = choice?.message?.content ?? "";
    const firstLogprob = choice?.logprobs?.content?.[0];
    const topLogProbs = firstLogprob?.top_logprobs ?? [];

    let coveredLogprob: number | null = null;
    let notCoveredLogprob: number | null = null;
    for (const entry of topLogProbs) {
      const token = normalizeToken(entry.token ?? "");
      if (!token) continue;
      if (token === "C" && coveredLogprob === null) coveredLogprob = entry.logprob ?? null;
      if (token === "N" && notCoveredLogprob === null) notCoveredLogprob = entry.logprob ?? null;
    }

    const decisionToken = normalizeToken(firstLogprob?.token ?? "");
    let decision: "covered" | "not_covered" | "unknown" = "unknown";
    if (decisionToken === "C") decision = "covered";
    else if (decisionToken === "N") decision = "not_covered";

    return {
      filePath,
      conversationId: loaded.conversationId,
      completion: messageContent,
      decisionToken,
      decision,
      logProbabilities: {
        covered: coveredLogprob,
        notCovered: notCoveredLogprob,
      },
      probabilities: {
        covered: computeProbabilities(coveredLogprob),
        notCovered: computeProbabilities(notCoveredLogprob),
      },
      prompt,
    };
  } catch (err: any) {
    return {
      ...fallbackResult,
      conversationId: loaded.conversationId,
      error: err?.message ?? String(err),
      prompt,
    };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as DifficultyRequestBody;
  const filePaths = Array.isArray(body.filePaths) ? body.filePaths.filter((value) => typeof value === "string") : [];

  if (filePaths.length === 0) {
    res.status(400).json({ error: "Provide at least one conversation file path." });
    return;
  }

  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "Provide an OpenAI API key." });
    return;
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

  const client = new OpenAI({ apiKey });
  const policyText = await getPolicyText();
  const warnings: string[] = [];
  const results: DifficultyResult[] = [];

  for (const filePath of filePaths) {
    if (!isValidSelection(filePath)) {
      warnings.push(`Skipped invalid selection: ${filePath}`);
      continue;
    }
    const result = await evaluateConversation(client, model, policyText, filePath);
    results.push(result);
  }

  res.status(200).json({ model, results, warnings } satisfies DifficultyResponseBody);
}
