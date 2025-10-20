import path from "path";
import fs from "fs/promises";

export const OUTPUT_ROOT = path.join(process.cwd(), "generated_conversations", "ui_runs");
export const POLICY_PATH = path.join(process.cwd(), "policy", "applecareplus.txt");

export type ConversationFile = {
  id?: string;
  created_at?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  max_turns?: number;
  scenario_label?: string;
  scenario?: any;
  persona?: any;
  system_prompts?: any;
  messages?: any[];
  [key: string]: any;
};

export type DifficultyResult = {
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

let cachedPolicy: string | null = null;

export async function getPolicyText(): Promise<string> {
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

export function normalizeSelection(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isValidSelection(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = normalizeSelection(filePath);
  if (!normalized.startsWith("generated_conversations/ui_runs/")) return false;
  const resolved = path.resolve(process.cwd(), normalized);
  return resolved.startsWith(OUTPUT_ROOT + path.sep);
}

export async function loadConversationFile(filePath: string): Promise<ConversationFile | null> {
  if (!isValidSelection(filePath)) return null;
  const resolved = path.resolve(process.cwd(), normalizeSelection(filePath));
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    return JSON.parse(raw) as ConversationFile;
  } catch (err) {
    return null;
  }
}

export function buildTranscript(messages: any[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return "(no messages)";
  return messages
    .map((entry: any, index: number) => {
      const speakerRaw = typeof entry?.speaker === "string" ? entry.speaker : "unknown";
      const speaker = speakerRaw.toLowerCase() === "bot"
        ? "Agent"
        : speakerRaw.toLowerCase() === "customer"
        ? "Customer"
        : `Turn ${index + 1}`;
      const text = typeof entry?.text === "string"
        ? entry.text
        : typeof entry?.raw_text === "string"
        ? entry.raw_text
        : "";
      return `${speaker}: ${text}`;
    })
    .join("\n");
}

export function normalizeToken(token: string): string {
  return token
    .replace(/[\s\u0120\u010A\u2581]+$/g, "")
    .replace(/^[\s\u0120\u010A\u2581]+/g, "")
    .trim();
}

export function computeProbability(logprob: number | null): number | null {
  if (logprob === null || Number.isNaN(logprob)) return null;
  const value = Math.exp(logprob);
  if (!Number.isFinite(value)) return null;
  return value;
}
