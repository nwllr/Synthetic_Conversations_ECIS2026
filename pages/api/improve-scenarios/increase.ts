import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import OpenAI from "openai";

import {
  DifficultyResult,
  OUTPUT_ROOT,
  buildTranscript,
  computeProbability,
  getPolicyText,
  loadConversationFile,
  normalizeToken,
} from "../../../lib/improve-scenarios/common";

type ImproveRequestBody = {
  filePaths?: string[];
  apiKey?: string;
  scoringModel?: string;
  rewriteModel?: string;
  confidenceThreshold?: number;
  maxIterations?: number;
};

type ScenarioAttempt = {
  iteration: number;
  conversationPath?: string;
  difficulty?: DifficultyResult;
  rewrittenScenario?: any;
  rawRewrite?: string;
  rewritePrompt?: string;
  simulationTranscript?: { speaker: string; text: string; raw_text: string }[];
  error?: string;
};

type ImprovedScenarioResult = {
  filePath: string;
  originalConversationId?: string;
  rewrittenScenario?: any;
  rewrittenScenarioText?: string;
  newConversationPath?: string;
  difficulty?: DifficultyResult;
  rawRewrite?: string;
  rewritePrompt?: string;
  simulationTranscript?: { speaker: string; text: string; raw_text: string }[];
  attempts: ScenarioAttempt[];
  reachedThreshold: boolean;
  appliedIteration: number;
  confidenceThreshold: number;
  maxIterations: number;
  error?: string;
};

const DEFAULT_REWRITE_MODEL = "gpt-4.1";
const DEFAULT_SCORING_MODEL = "gpt-4.1-mini";
const DEFAULT_SIMULATION_TEMPERATURE = 0.7;
const DEFAULT_SIMULATION_MAX_TOKENS = 400;
const DEFAULT_SIMULATION_MAX_TURNS = 20;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_MAX_ITERATIONS = 3;
const CUSTOMER_GREETING = "Thank you for contacting AppleCare. How may I help you today?";

const BOT_INSTRUCTIONS_PATH = path.join(
  process.cwd(),
  "characteristics",
  "bot",
  "instructions_modified.json"
);

function extractFirstJsonObject(s: string): string | null {
  if (!s) return null;
  let t = s.trim().replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          /* ignore, keep scanning */
        }
      }
    }
  }
  return null;
}

async function loadBotInstructions(): Promise<any> {
  const raw = await fs.readFile(BOT_INSTRUCTIONS_PATH, "utf-8");
  return JSON.parse(raw);
}

function formatJson(data: any): string {
  return JSON.stringify(data, null, 2);
}

function buildCustomerSystemPrompt(persona: any, scenario: any): string {
  const description = (scenario?.description ?? "").trim();
  const title = scenario?.title ?? scenario?.id ?? "Scenario";
  const customerData = scenario?.customer_data ?? {};

  return `You are a policyholder filing a claim with AppleCare.
You are given a persona and a scenario to role-play as the policyholder. Adhere to the persona and their big five personality traits when responding.
You will have a conversation with an AppleCare bot to file your claim.
Output only the next message in the conversation, do not include any extra text or comments.
The conversation should be turn-taking and unique. Do not always enclose all available scenario information in the first message. Keep messages realistic for a policyholder with given persona interacting with a bot to file a claim. Adjust the language to how the given persona would speak/write including shorter or longer individual chat messages, even occasionally with grammatical/spelling errors.
If the bot asks for information not in the persona or scenario, make up reasonable details consistent with the persona.
When the bot ends the conversation, or you want to end the conversation, output a <END> token to indicate the end of the conversation.

Scenario title:
${title}

Scenario description:
${description}

Customer data you have available for filing the claim (respond "Unknown" when asked for missing details):
${formatJson(customerData)}

Persona to role-play as:
${formatJson(persona)}`.trim();
}

async function buildBotSystemPrompt(): Promise<string> {
  const instructions = await loadBotInstructions();
  return `You are an AppleCare customer service bot helping a policyholder file a claim.
Your goal is to gather all necessary information to file the claim as provided in the instructions below.
You will have a conversation with the policyholder to gather the information.
Do NOT give any information about whether the claim is covered or not. Your job is to gather the information only. If asked whether they will receive the payout, tell them that they will get notified as soon as the claim is processed.
Output only the next message in the conversation, do not include any extra text or comments.
The conversation should be turn-taking and unique.
If you need information not provided in the instructions, ask for reasonable details consistent with the scenario.
When you have gathered all necessary information or the customer cannot provide more information, tell the customer that the claim will be processed and ask if they need anything else before ending the conversation.
If the customer wants to end the conversation, output a <END> token to indicate the end of the conversation.
Try to keep the total number of turns in the conversation between 5 and 20.
Remain professional and friendly throughout the conversation. Keep the language concise and clear.

Here are the instructions for the claim you are to help the policyholder with:
${formatJson(instructions)}`.trim();
}

function stripCodeFences(text: string): string {
  const match = text.trim().match(/^```(?:[a-zA-Z0-9_+-]+)?\s*([\s\S]*?)\s*```$/);
  if (!match) return text.trim();
  return match[1].trim();
}

function sanitizeResponse(text: string): { cleaned: string; ended: boolean } {
  const cleaned = stripCodeFences(text.replace(/\r/g, "").trim());
  if (cleaned.includes("<END>")) {
    return { cleaned: cleaned.replace(/<END>/g, "").trim(), ended: true };
  }
  return { cleaned, ended: false };
}

async function rewriteScenario(
  client: OpenAI,
  scenario: any,
  policyText: string,
  model: string
): Promise<{ rewritten?: any; raw?: string; prompt: string; error?: string }> {
  const prompt = `This AppleCare+ edge_case scenario is too easy to decide as not covered.
Adjust the scenario so the coverage decision becomes more ambiguous by modifying only the relevant narrative details.
Stay consistent with policy constraints but push the situation closer to the boundary.

Return JSON with fields:
- title: string
- description: string
- adjustments: string (brief notes on what changed)
- risk_analysis: string (why the scenario is now closer to the edge)

Scenario:
${formatJson(scenario)}

Policy:
${policyText}`;

  const callModel = async (useStructured: boolean) => {
    return client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You refine AppleCare+ edge case scenarios. Respond strictly in JSON without additional commentary.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 1,
      max_tokens: 2000,
      ...(useStructured ? { response_format: { type: "json_object" as const } } : {}),
    });
  };

  const tryParseContent = (content: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      const extracted = extractFirstJsonObject(content);
      if (!extracted) {
        const error: any = new Error("Rewrite model did not return valid JSON.");
        error.raw = content;
        throw error;
      }
      parsed = JSON.parse(extracted);
    }
    return parsed;
  };

  try {
    const response = await callModel(true);
    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = tryParseContent(content);
    return { rewritten: parsed, raw: content, prompt };
  } catch (err: any) {
    try {
      const fallbackResponse = await callModel(false);
      const content = fallbackResponse.choices?.[0]?.message?.content ?? "";
      const parsed = tryParseContent(content);
      return { rewritten: parsed, raw: content, prompt };
    } catch (fallbackErr: any) {
      const fallbackMessage = fallbackErr?.message ?? String(fallbackErr);
      const rawResponse = (() => {
        if (fallbackErr?.response?.data) return JSON.stringify(fallbackErr.response.data);
        if (fallbackErr?.raw) return fallbackErr.raw;
        if (err?.response?.data) return JSON.stringify(err.response.data);
        if (err?.raw) return err.raw;
        return undefined;
      })();
      return {
        rewritten: undefined,
        raw: rawResponse,
        prompt,
        error: fallbackMessage,
      };
    }
  }
}

type ConversationMessage = {
  speaker: "customer" | "bot";
  text: string;
  raw_text: string;
};

async function simulateConversation(
  client: OpenAI,
  scenario: any,
  persona: any,
  options: {
    model: string;
    temperature: number;
    maxTokens: number;
    maxTurns: number;
  }
): Promise<{ transcript: ConversationMessage[]; ended: boolean; customerSystem: string; botSystem: string }> {
  const customerSystem = buildCustomerSystemPrompt(persona, scenario);
  const botSystem = await buildBotSystemPrompt();

  const transcript: ConversationMessage[] = [];
  transcript.push({ speaker: "bot", text: CUSTOMER_GREETING, raw_text: CUSTOMER_GREETING });

  let ended = false;
  const speakers: ConversationMessage["speaker"][] = ["customer", "bot"];
  let step = 0;

  while (transcript.length < options.maxTurns && !ended) {
    const speaker = speakers[step % 2];
    const systemPrompt = speaker === "customer" ? customerSystem : botSystem;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...transcript.map((item) => ({
        role: item.speaker === speaker ? ("assistant" as const) : ("user" as const),
        content: item.text,
      })),
    ];

    const response = await client.chat.completions.create({
      model: options.model,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });

    const raw = response.choices?.[0]?.message?.content ?? "";
    const { cleaned, ended: sawEnd } = sanitizeResponse(raw || "");

    transcript.push({ speaker, text: cleaned || raw, raw_text: raw });
    if (sawEnd) {
      ended = true;
    }

    step += 1;
  }

  return { transcript, ended, customerSystem, botSystem };
}

async function writeConversationToFile(
  outputDir: string,
  conversation: Record<string, any>
): Promise<string> {
  const dirPath = path.resolve(OUTPUT_ROOT, outputDir);
  await fs.mkdir(dirPath, { recursive: true });
  const filename = `${conversation.id ?? `${Date.now()}`}.json`;
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, `${JSON.stringify(conversation, null, 2)}\n`, "utf-8");
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

async function evaluateConversationFromPath(
  client: OpenAI,
  model: string,
  policyText: string,
  filePath: string
): Promise<DifficultyResult> {
  const fallback: DifficultyResult = {
    filePath,
    logProbabilities: { covered: null, notCovered: null },
    probabilities: { covered: null, notCovered: null },
    prompt: undefined,
  };

  const loaded = await loadConversationFile(filePath);
  if (!loaded) {
    return { ...fallback, error: "Unable to load generated conversation" };
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
      top_logprobs: 10,
    });

    const choice = response.choices?.[0];
    const first = choice?.logprobs?.content?.[0];
    const top = first?.top_logprobs ?? [];

    let coveredLogprob: number | null = null;
    let notCoveredLogprob: number | null = null;

    for (const entry of top) {
      const token = normalizeToken(entry.token ?? "");
      if (!token) continue;
      if (token === "C" && coveredLogprob === null) coveredLogprob = entry.logprob ?? null;
      if (token === "N" && notCoveredLogprob === null) notCoveredLogprob = entry.logprob ?? null;
    }

    const decisionToken = normalizeToken(first?.token ?? "");
    let decision: DifficultyResult["decision"] = "unknown";
    if (decisionToken === "C") decision = "covered";
    if (decisionToken === "N") decision = "not_covered";

    return {
      filePath,
      conversationId: typeof loaded.id === "string" ? loaded.id : undefined,
      completion: choice?.message?.content ?? "",
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
      ...fallback,
      error: err?.message ?? String(err),
      prompt,
    };
  }
}

function ensureRunDirectory(): string {
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}-${randomBytes(3).toString("hex")}`;
  return runId;
}

function confidenceFromDifficulty(result: DifficultyResult | undefined): number {
  if (!result) return 1;
  const covered = result.probabilities?.covered;
  const notCovered = result.probabilities?.notCovered;
  const values = [covered, notCovered].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return 1;
  return Math.max(...values);
}

function pickMostAmbiguousAttempt(attempts: ScenarioAttempt[]): ScenarioAttempt | undefined {
  if (attempts.length === 0) return undefined;
  let best: ScenarioAttempt | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const attempt of attempts) {
    const score = confidenceFromDifficulty(attempt.difficulty);
    if (score < bestScore) {
      best = attempt;
      bestScore = score;
    }
  }
  return best;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = (req.body ?? {}) as ImproveRequestBody;
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

  const rewriteModel = typeof body.rewriteModel === "string" && body.rewriteModel.trim() ? body.rewriteModel.trim() : DEFAULT_REWRITE_MODEL;
  const scoringModel = typeof body.scoringModel === "string" && body.scoringModel.trim() ? body.scoringModel.trim() : DEFAULT_SCORING_MODEL;
  const maxIterationsRaw = Number.isFinite(body.maxIterations) ? Number(body.maxIterations) : undefined;
  const confidenceThresholdRaw = Number.isFinite(body.confidenceThreshold) ? Number(body.confidenceThreshold) : undefined;

  const maxIterations = Math.min(10, Math.max(1, Math.floor(maxIterationsRaw ?? DEFAULT_MAX_ITERATIONS)));
  const confidenceThreshold = Math.min(0.999, Math.max(0, confidenceThresholdRaw ?? DEFAULT_CONFIDENCE_THRESHOLD));

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const client = new OpenAI({ apiKey });
  const policyText = await getPolicyText();

  const warnings: string[] = [];
  const results: ImprovedScenarioResult[] = [];
  const runDir = ensureRunDirectory();

  const writeEvent = (type: string, data: any) => {
    res.write(`${JSON.stringify({ type, data })}\n`);
    // @ts-expect-error flush is added by compression middleware in Next dev server
    res.flush?.();
  };

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  const runDirectory = path.join("generated_conversations", "ui_runs", runDir).replace(/\\/g, "/");

  writeEvent("start", {
    runDirectory,
    total: filePaths.length,
    maxIterations,
    confidenceThreshold,
  });

  try {
    for (const filePath of filePaths) {
      if (aborted) break;

      const conversation = await loadConversationFile(filePath);
      if (!conversation) {
        const warning = `Skipped invalid selection: ${filePath}`;
        warnings.push(warning);
        writeEvent("warning", { message: warning, filePath });
        continue;
      }

      const scenario = conversation.scenario ?? null;
      const persona = conversation.persona ?? null;
      if (!scenario || !persona) {
        const warning = `Missing scenario or persona data for ${filePath}`;
        warnings.push(warning);
        writeEvent("warning", { message: warning, filePath });
        continue;
      }

      const attempts: ScenarioAttempt[] = [];
      let currentScenario = { ...scenario };
      let finalAttempt: ScenarioAttempt | undefined;
      let reachedThreshold = false;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (aborted) break;

        const rewrite = await rewriteScenario(client, currentScenario, policyText, rewriteModel);

      if (!rewrite.rewritten) {
        const attempt: ScenarioAttempt = {
          iteration,
          error: rewrite.error ?? "Failed to rewrite scenario",
          rawRewrite: rewrite.raw,
          rewritePrompt: rewrite.prompt,
          rewrittenScenario: currentScenario,
        };
        attempts.push(attempt);
        writeEvent("attempt", { filePath, attempt });
        continue;
      }

        const mergedScenario = {
          ...currentScenario,
          ...rewrite.rewritten,
          title: rewrite.rewritten.title ?? currentScenario.title,
          description: rewrite.rewritten.description ?? currentScenario.description,
        };

        const simOptions = {
          model: typeof conversation.model === "string" ? conversation.model : DEFAULT_REWRITE_MODEL,
          temperature:
            typeof conversation.temperature === "number"
              ? conversation.temperature
              : DEFAULT_SIMULATION_TEMPERATURE,
          maxTokens:
            typeof conversation.max_tokens === "number"
              ? conversation.max_tokens
              : DEFAULT_SIMULATION_MAX_TOKENS,
          maxTurns:
            typeof conversation.max_turns === "number" ? conversation.max_turns : DEFAULT_SIMULATION_MAX_TURNS,
        };

        const simulation = await simulateConversation(client, mergedScenario, persona, simOptions);

        const conversationId = `${(mergedScenario.id ?? scenario.id ?? "scenario")}-improved-${iteration}-${randomBytes(3).toString("hex")}`;
        const conversationPayload = {
          id: conversationId,
          created_at: new Date().toISOString(),
          model: simOptions.model,
          temperature: simOptions.temperature,
          max_tokens: simOptions.maxTokens,
          max_turns: simOptions.maxTurns,
          scenario_label: conversation.scenario_label ?? "edge_case",
          scenario: mergedScenario,
          persona,
          system_prompts: {
            customer: simulation.customerSystem,
            bot: simulation.botSystem,
          },
          messages: simulation.transcript,
          ended_within_turn_limit: simulation.ended,
        };

        const relativePath = await writeConversationToFile(runDir, conversationPayload);
        const difficulty = await evaluateConversationFromPath(client, scoringModel, policyText, relativePath);

        const attempt: ScenarioAttempt = {
          iteration,
          conversationPath: relativePath,
          difficulty,
          rewrittenScenario: mergedScenario,
          rawRewrite: rewrite.raw,
          rewritePrompt: rewrite.prompt,
          simulationTranscript: simulation.transcript,
        };

        attempts.push(attempt);
        writeEvent("attempt", { filePath, attempt });

        const confidence = confidenceFromDifficulty(difficulty);
        if (confidence <= confidenceThreshold) {
          finalAttempt = attempt;
          reachedThreshold = true;
          break;
        }

        currentScenario = mergedScenario;
      }

      if (!finalAttempt) {
        finalAttempt = pickMostAmbiguousAttempt(attempts);
      }

      if (!finalAttempt) {
      const lastAttempt = attempts[attempts.length - 1];
      const result: ImprovedScenarioResult = {
        filePath,
        originalConversationId: typeof conversation.id === "string" ? conversation.id : undefined,
        attempts,
        reachedThreshold,
        appliedIteration: attempts.length,
        confidenceThreshold,
        maxIterations,
        error: "Failed to produce any improved scenario",
        rawRewrite: lastAttempt?.rawRewrite,
        rewritePrompt: lastAttempt?.rewritePrompt,
      };
        results.push(result);
        writeEvent("scenario", { filePath, result });
        continue;
      }

      const finalScenario = finalAttempt.rewrittenScenario ?? currentScenario;

      const result: ImprovedScenarioResult = {
        filePath,
        originalConversationId: typeof conversation.id === "string" ? conversation.id : undefined,
        rewrittenScenario: finalScenario,
        rewrittenScenarioText: formatJson(finalScenario),
        newConversationPath: finalAttempt.conversationPath,
        difficulty: finalAttempt.difficulty,
        rawRewrite: finalAttempt.rawRewrite,
        rewritePrompt: finalAttempt.rewritePrompt,
        simulationTranscript: finalAttempt.simulationTranscript,
        attempts,
        reachedThreshold,
        appliedIteration: finalAttempt.iteration,
        confidenceThreshold,
        maxIterations,
      };

      results.push(result);
      writeEvent("scenario", { filePath, result });

      if (aborted) break;
    }

    let summaryRelativePath: string | null = null;
    try {
      const summary = {
        generatedAt: new Date().toISOString(),
        runDirectory,
        scoringModel,
        improvementModel: rewriteModel,
        confidenceThreshold,
        maxIterations,
        aborted,
        scenarios: results.map((result) => ({
          filePath: result.filePath,
          originalConversationId: result.originalConversationId ?? null,
          newConversationPath: result.newConversationPath ?? null,
          reachedThreshold: result.reachedThreshold,
          appliedIteration: result.appliedIteration,
          decision: result.difficulty?.decision ?? null,
          maxProbability: confidenceFromDifficulty(result.difficulty),
          logProbabilities: result.difficulty?.logProbabilities ?? null,
          probabilities: result.difficulty?.probabilities ?? null,
          finalRawRewrite: result.rawRewrite ?? null,
          finalRewritePrompt: result.rewritePrompt ?? null,
          attempts: (result.attempts ?? []).map((attempt) => ({
            iteration: attempt.iteration,
            conversationPath: attempt.conversationPath ?? null,
            decision: attempt.difficulty?.decision ?? null,
            maxProbability: confidenceFromDifficulty(attempt.difficulty),
            logProbabilities: attempt.difficulty?.logProbabilities ?? null,
            probabilities: attempt.difficulty?.probabilities ?? null,
            error: attempt.error ?? null,
            rawRewrite: attempt.rawRewrite ?? null,
            rewritePrompt: attempt.rewritePrompt ?? null,
          })),
        })),
      };

      const summaryPath = path.join(OUTPUT_ROOT, runDir, "scoring-summary.json");
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
      summaryRelativePath = path.relative(process.cwd(), summaryPath).replace(/\\/g, "/");
    } catch (summaryErr: any) {
      const message = summaryErr?.message ?? String(summaryErr);
      warnings.push(`Failed to write scoring summary: ${message}`);
      writeEvent("warning", { message: `Failed to write scoring summary: ${message}` });
    }

    writeEvent("done", {
      runDirectory,
      results,
      warnings,
      summaryPath: summaryRelativePath,
    });
    res.end();
  } catch (err: any) {
    const message = err?.message ?? "Unknown error";
    writeEvent("error", { message });
    res.end();
  }
}
