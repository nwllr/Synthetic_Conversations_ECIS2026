import type { NextApiRequest, NextApiResponse } from "next";
import fs from "fs/promises";
import { createChatCompletion } from "../../lib/openai";
import { buildPrompt, TEMPERATURE_BY_DIFFICULTY, PromptOptions } from "../../lib/prompt-templates";
import { createRng } from "../../lib/seed";
import {
  parseAndValidateConversation,
  Conversation,
} from "../../types/schema";

/**
 * Streaming generation endpoint.
 * Accepts a POST with the same body as /api/generate and returns a chunked text/event-stream-like output.
 * Each chunk will be a small text block prefixed with an event type and JSON payload:
 *
 * event: progress
 * data: { requested, generated, errors, seed }
 *
 * event: item
 * data: { conversation: {...} }
 *
 * event: error
 * data: { index, error, raw? }
 *
 * event: done
 * data: { requested, generated, errors, seed }
 *
 * The client should POST and then read the response body as a stream and parse events split by double-newline.
 */

type GenerateRequest = {
  total: number;
  covered?: boolean | "random" | "edgecase";
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

function writeEvent(res: NextApiResponse, event: string, payload: any) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
    // ignore write errors - will be handled by checking res.finished
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Prepare streaming headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable Next.js automatic response compression buffering (if any)
  // Note: NextApiResponse may not expose `flush()` in all environments; skip calling it here.

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

  // Notify client that stream is starting
  writeEvent(res, "progress", { requested: total, generated: 0, errors: 0, seed: runSeed });

  const runRng = createRng(runSeed);
  const results: Conversation[] = [];
  const errors: { index: number; error: string; raw?: string }[] = [];

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  for (let i = 0; i < total; i++) {
    if (aborted) {
      // client disconnected
      break;
    }

    const id = `conv_${String(i + 1).padStart(6, "0")}`;
    const convSeed = Math.floor(runSeed + i + Math.floor(runRng() * 100000));
    const convRng = createRng(convSeed);

    const perConvCovered =
      covered === "random" ? convRng() < 0.5 : (covered as boolean | "random" | "edgecase");

    // Choose failure modes deterministically
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

    const forcedAmount = failureModes.includes("amount_anomaly") && claimAmountOverride ? claimAmountOverride : null;

    const promptOpts: PromptOptions = {
      id,
      covered: perConvCovered === "random" ? "random" : (perConvCovered as any),
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
    let _raw_model_output = "";
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
      // store the original raw model output for debugging/inspection
      _raw_model_output = jsonText;

      try {
        const conv = parseAndValidateConversation(jsonText) as Conversation;
        conv.metadata = {
          ...conv.metadata,
          seed: convSeed,
          configured_failure_modes: failureModesConfig,
        };
        // attach debug fields: full prompt and raw model output
        (conv as any)._prompt = prompt;
        (conv as any)._raw_model_output = _raw_model_output;
        if (!conv.labels.covered && conv.labels.coverage_decision) {
          conv.labels.covered = conv.labels.coverage_decision === "covered";
        }
        results.push(conv);

        writeEvent(res, "item", { conversation: conv });
        writeEvent(res, "progress", { requested: total, generated: results.length, errors: errors.length, seed: runSeed });
      } catch (parseErr: any) {
        // Attempt repair
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
          // attach debug fields: preserve original raw output and the repaired output
          (conv as any)._prompt = prompt;
          (conv as any)._raw_model_output_original = _raw_model_output;
          (conv as any)._raw_model_output = repairedText;
          if (!conv.labels.covered && conv.labels.coverage_decision) {
            conv.labels.covered = conv.labels.coverage_decision === "covered";
          }
          results.push(conv);
          writeEvent(res, "item", { conversation: conv });
          writeEvent(res, "progress", { requested: total, generated: results.length, errors: errors.length, seed: runSeed });
        } catch (repairErr: any) {
          errors.push({
            index: i,
            error: `parse/retry failed: ${(parseErr && parseErr.message) || String(parseErr)}`,
            raw: jsonText,
          });
          writeEvent(res, "error", { index: i, error: errors[errors.length - 1].error, raw: jsonText });
          writeEvent(res, "progress", { requested: total, generated: results.length, errors: errors.length, seed: runSeed });
        }
      }
    } catch (err: any) {
      errors.push({ index: i, error: err.message ?? String(err) });
      writeEvent(res, "error", { index: i, error: err.message ?? String(err) });
      writeEvent(res, "progress", { requested: total, generated: results.length, errors: errors.length, seed: runSeed });
    }
  }

  // Final done event
  writeEvent(res, "done", { requested: total, generated: results.length, errors: errors.length, seed: runSeed });

  try {
    res.end();
  } catch (e) {
    // ignore
  }
}
