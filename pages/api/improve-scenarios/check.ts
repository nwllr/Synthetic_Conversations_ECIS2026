import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import {
  getPolicyText,
  loadConversationFile,
  buildTranscript,
  normalizeToken,
  computeProbability,
  DifficultyResult,
  isValidSelection,
} from "../../../lib/improve-scenarios/common";

const DEFAULT_MODEL = "gpt-4.1-mini";

type DifficultyRequestBody = {
  filePaths?: string[];
  apiKey?: string;
  model?: string;
};

type DifficultyResponseBody = {
  model: string;
  results: DifficultyResult[];
  warnings: string[];
};

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

  const loaded = await loadConversationFile(filePath);
  if (!loaded) {
    return { ...fallbackResult, error: "Unable to load conversation" };
  }

  const transcript = buildTranscript(Array.isArray(loaded.messages) ? loaded.messages : []);
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
        covered: computeProbability(coveredLogprob),
        notCovered: computeProbability(notCoveredLogprob),
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
