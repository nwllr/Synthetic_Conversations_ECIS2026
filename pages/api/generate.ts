import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs/promises";
import { createChatCompletion } from "../../lib/openai";
import { buildPrompt, TEMPERATURE_BY_DIFFICULTY, PromptOptions } from "../../lib/prompt-templates";
import { createRng, chance, idFromSeed } from "../../lib/seed";
import {
  parseAndValidateConversation,
  Conversation,
} from "../../types/schema";

type GenerateRequest = {
  total: number;
  covered?: boolean | "random";
  difficulty?: "easy" | "medium" | "hard";
  turns?: number;
  tone?: string;
  length?: "short" | "medium" | "long";
  noise?: boolean;
  seed?: number;
  batchSize?: number;
  incidentTypes?: string[];
  failureModesConfig?: {
    fraudProbability?: number;
    inconsistentProbability?: number;
    missingInfoProbability?: number;
    amountAnomalyProbability?: number;
  };
  claimAmountOverride?: number | null;
};

type ErrorRecord = {
  index: number;
  error: string;
  raw?: string;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const body = req.body as GenerateRequest;

  const total = Math.max(1, Math.min(10000, body.total ?? 10));
  const covered = body.covered ?? "random";
  const difficulty = body.difficulty ?? "medium";
  const turns = body.turns ?? 6;
  const tone = body.tone ?? "neutral";
  const length = body.length ?? "short";
  const noise = body.noise ?? false;
  const runSeed = typeof body.seed === "number" ? body.seed : Math.floor(Math.random() * 2 ** 31);
  const batchSize = Math.max(1, Math.min(50, body.batchSize ?? 1));
  const incidentTypes = body.incidentTypes ?? [
    "screen damage (drop)",
    "liquid damage",
    "theft",
    "battery issue",
    "software malfunction",
  ];
  const failureModesConfig = body.failureModesConfig ?? {
    fraudProbability: 0.2,
    inconsistentProbability: 0.1,
    missingInfoProbability: 0.2,
    amountAnomalyProbability: 0.1,
  };
  const claimAmountOverride = typeof body.claimAmountOverride === "number" ? body.claimAmountOverride : null;

  // Load policy text once per request
  let policyText = "";
  try {
    policyText = await fs.readFile("policy/applecareplus.txt", "utf8");
  } catch (err: any) {
    console.warn("Could not read policy file: ", err?.message ?? String(err));
    policyText = "";
  }

  const results: Conversation[] = [];
  const errors: ErrorRecord[] = [];

  // Create a run-level RNG (we will derive per-conversation choices deterministically from this)
  const runRng = createRng(runSeed);

  // Sequential generation loop (deterministic when seed provided)
  for (let i = 0; i < total; i++) {
    const id = `conv_${String(i + 1).padStart(6, "0")}`;

    // Derive a conversation-specific seed deterministically
    const convSeed = Math.floor(runSeed + i + Math.floor(runRng() * 100000));
    const convRng = createRng(convSeed);

    // Decide per-conversation covered if user requested 'random'
    const perConvCovered =
      covered === "random" ? convRng() < 0.5 : (covered as boolean | "random");

    // Decide whether to include a failure mode and which one (deterministic via convRng)
    const failureModes: string[] = [];
    if (failureModesConfig.fraudProbability && convRng() < (failureModesConfig.fraudProbability ?? 0)) {
      failureModes.push("fraud_attempt");
    }
    if (failureModesConfig.inconsistentProbability && convRng() < (failureModesConfig.inconsistentProbability ?? 0)) {
      failureModes.push("inconsistent_statement");
    }
    if (failureModesConfig.missingInfoProbability && convRng() < (failureModesConfig.missingInfoProbability ?? 0)) {
      failureModes.push("missing_info");
    }
    if (failureModesConfig.amountAnomalyProbability && convRng() < (failureModesConfig.amountAnomalyProbability ?? 0)) {
      failureModes.push("amount_anomaly");
    }

    // Optionally force an amount override if amount_anomaly was selected and claimAmountOverride provided
    const forcedAmount = failureModes.includes("amount_anomaly") && claimAmountOverride ? claimAmountOverride : null;

    // Build prompt options
    const promptOpts: PromptOptions = {
      id,
      covered: perConvCovered === "random" ? "random" : (perConvCovered as boolean),
      difficulty,
      turns,
      tone,
      length,
      noise,
      seed: convSeed,
      incidentTypes,
      configured_failure_modes: failureModesConfig,
      forced_failure_mode: failureModes.length > 0 ? failureModes[0] : null,
      claimAmountOverride: forcedAmount,
    };

    const prompt = buildPrompt(policyText, promptOpts);

    const temperature = TEMPERATURE_BY_DIFFICULTY[difficulty] ?? 0.6;

    try {
      const completion = await createChatCompletion({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a claims intake assistant. Output exactly one JSON object matching the requested schema." },
          { role: "user", content: prompt },
        ],
        temperature,
        max_tokens: 1200,
        n: 1,
      });

      const rawText =
        // @ts-ignore
        completion?.choices?.[0]?.message?.content ??
        // @ts-ignore
        completion?.choices?.[0]?.text ??
        JSON.stringify(completion);

      const jsonText = typeof rawText === "string" ? rawText.trim() : String(rawText);

      try {
        const conv = parseAndValidateConversation(jsonText) as Conversation;
        // Ensure metadata contains seed and configured_failure_modes for traceability
        conv.metadata = {
          ...conv.metadata,
          seed: convSeed,
          configured_failure_modes: failureModesConfig,
        };
        // Ensure covered boolean exists for backward compatibility
        if (!conv.labels.covered && conv.labels.coverage_decision) {
          conv.labels.covered = conv.labels.coverage_decision === "covered";
        }
        results.push(conv);
      } catch (parseErr: any) {
        // Attempt a focused repair: ask model to output ONLY a JSON object corrected
        try {
          const repairPrompt = `The previous response contained this text:\n\n${jsonText}\n\nPlease convert it to a single valid JSON object that matches the schema described earlier. Output only valid JSON and nothing else.`;
          const repair = await createChatCompletion({
            model: "gpt-4.1-mini",
            messages: [
              { role: "system", content: "You are a JSON formatter. Output only valid JSON, no explanations." },
              { role: "user", content: repairPrompt },
            ],
            temperature: 0.0,
            max_tokens: 800,
            n: 1,
          });

          const repairedRaw =
            // @ts-ignore
            repair?.choices?.[0]?.message?.content ?? repair?.choices?.[0]?.text ?? JSON.stringify(repair);

          const repairedText = typeof repairedRaw === "string" ? repairedRaw.trim() : String(repairedRaw);
          const conv = parseAndValidateConversation(repairedText) as Conversation;
          conv.metadata = {
            ...conv.metadata,
            seed: convSeed,
            configured_failure_modes: failureModesConfig,
          };
          if (!conv.labels.covered && conv.labels.coverage_decision) {
            conv.labels.covered = conv.labels.coverage_decision === "covered";
          }
          results.push(conv);
        } catch (repairErr: any) {
          errors.push({
            index: i,
            error: `parse/retry failed: ${(parseErr && parseErr.message) || String(parseErr)}`,
            raw: jsonText,
          });
        }
      }
    } catch (err: any) {
      errors.push({ index: i, error: err.message ?? String(err) });
    }
  }

  return res.status(200).json({
    ok: true,
    requested: total,
    generated: results.length,
    seed: runSeed,
    errors,
    results,
  });
}
