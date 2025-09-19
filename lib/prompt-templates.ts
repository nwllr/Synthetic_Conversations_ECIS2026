/**
 * Prompt templates and helpers for synthetic conversation generation.
 *
 * This module builds strict JSON-only prompts that include:
 * - full policy text (inserted verbatim)
 * - explicit instructions for failure modes (fraud, inconsistent statements, missing info, amount anomalies)
 * - examples that demonstrate the required output schema including coverage_decision and policy_reference
 *
 * The generated prompt asks the model to output exactly one JSON object and nothing else.
 */

/**
 * Map difficulty to temperature value for model variance.
 */
export const TEMPERATURE_BY_DIFFICULTY: Record<"easy" | "medium" | "hard", number> = {
  easy: 0.2,
  medium: 0.6,
  hard: 0.9,
};

export type FailureModesConfig = {
  fraudProbability?: number;
  inconsistentProbability?: number;
  missingInfoProbability?: number;
  amountAnomalyProbability?: number;
};

/**
 * Options passed to buildPrompt.
 */
export type PromptOptions = {
  id: string;
  covered?: boolean | "random" | "edgecase";
  difficulty?: "easy" | "medium" | "hard";
  turns?: number;
  tone?: string;
  length?: "short" | "medium" | "long";
  noise?: boolean;
  seed?: number;
  incidentTypes?: string[];
  configured_failure_modes?: FailureModesConfig;
  forced_failure_mode?: string | null; // optional override for a single conversation
  claimAmountOverride?: number | null; // optional override to force an amount anomaly
};

/**
 * A short set of few-shot examples demonstrating normal, fraud, inconsistent and edgecase outputs.
 * These are small examples focused on required schema shape — the model should follow this shape exactly.
 */
const EXAMPLES = [
  {
    id: "example_001",
    metadata: {
      id: "example_001",
      seed: 12345,
      configured_failure_modes: {
        fraudProbability: 0,
        inconsistentProbability: 0,
        missingInfoProbability: 0,
        amountAnomalyProbability: 0,
      },
      difficulty: "easy",
      tone: "friendly",
      turns: 6,
      length_category: "short",
    },
    messages: [
      { speaker: "customer", text: "Hi, I dropped my phone and the screen cracked." },
      { speaker: "bot", text: "I'm sorry. Can I have your policy number?" },
      { speaker: "customer", text: "12345678" },
      { speaker: "bot", text: "When did this happen?" },
      { speaker: "customer", text: "Yesterday evening." },
      { speaker: "bot", text: "Thanks — accidental damage is covered. Please estimate repair cost." }
    ],
    summary: "Customer dropped phone; screen cracked; within ADH terms.",
    labels: {
      covered: true,
      coverage_decision: "covered",
      reason: "Accidental damage from handling within Plan term (see ADH coverage).",
      policy_reference: "Section 3.2 Accidental Damage from Handling — ADH coverage applies (subject to service fee).",
      claim_amount_estimate: 180,
      photos_provided: false,
      fraud_suspected: false,
      failure_modes: []
    }
  },
  {
    id: "example_002_fraud",
    metadata: {
      id: "example_002_fraud",
      seed: 22222,
      configured_failure_modes: { fraudProbability: 1 },
      difficulty: "medium",
      tone: "professional",
      turns: 8,
      length_category: "medium",
    },
    messages: [
      { speaker: "customer", text: "My phone was stolen from my bag last week." },
      { speaker: "bot", text: "I'm sorry. Do you have the police report number?" },
      { speaker: "customer", text: "Yes — PR-9988." },
      { speaker: "bot", text: "Please confirm your device serial number." },
      { speaker: "customer", text: "SN: ABCDE12345" },
      { speaker: "bot", text: "We couldn't find that serial number on record. Can you double-check?" },
      { speaker: "customer", text: "Oh, maybe I typed it wrong. It's 99999XXXXX." },
      { speaker: "bot", text: "Policy may not cover theft under this Plan; also this response looks suspicious. Please provide proof." }
    ],
    summary: "Reported theft; serial number mismatches and uncertain evidence — flagged as suspicious/fraud attempt.",
    labels: {
      covered: false,
      coverage_decision: "not_covered",
      reason: "Plan does not cover theft (see Section 4.2(iv)). Serial number mismatches and missing verifiable proof indicate potential fraud.",
      policy_reference: "Section 4.2(iv) — Plan does not apply to a Covered iPhone that has been lost or stolen.",
      claim_amount_estimate: null,
      photos_provided: false,
      fraud_suspected: true,
      failure_modes: ["fraud_attempt", "inconsistent_statement"]
    }
  },
  {
    id: "example_003_edgecase_missing",
    metadata: {
      id: "example_003_edgecase_missing",
      seed: 33333,
      configured_failure_modes: { missingInfoProbability: 1 },
      difficulty: "hard",
      tone: "neutral",
      turns: 6,
      length_category: "short",
    },
    messages: [
      { speaker: "customer", text: "Something is wrong with my phone. It stopped working." },
      { speaker: "bot", text: "Sorry to hear that. Can you describe what happened and when?" },
      { speaker: "customer", text: "I don't remember exactly — maybe last month." },
      { speaker: "bot", text: "Do you have the policy number or serial number?" },
      { speaker: "customer", text: "No, I don't have them." },
      { speaker: "bot", text: "I need more details to determine coverage; please provide proof of purchase and exact dates." }
    ],
    summary: "Customer cannot provide key details; coverage decision cannot be determined without further evidence.",
    labels: {
      covered: false,
      coverage_decision: "edgecase",
      reason: "Insufficient information to determine whether this is a pre-existing issue or ADH; policy requires proof of purchase and details.",
      policy_reference: "Section 3 and 4.2 — ADH requires accidental, unexpected event; insufficient info prevents decision.",
      claim_amount_estimate: null,
      photos_provided: false,
      fraud_suspected: false,
      failure_modes: ["missing_info"]
    }
  }
];

/**
 * Build a user prompt that instructs the model to output one JSON object only.
 * - policyText: full policy file text (inserted verbatim)
 * - opts: generation options
 */
export function buildPrompt(policyText: string, opts: PromptOptions) {
  const idNote = `Conversation id should be: ${opts.id}`;
  const coveredNote =
    opts.covered === "random"
      ? "Ground-truth 'coverage_decision' should be determined based on the policy and facts presented; the model should choose one of: covered, not_covered, edgecase."
      : opts.covered === "edgecase"
      ? "Ground-truth hint: prefer coverage decision = edgecase."
      : `Ground-truth hint: prefer coverage decision = ${opts.covered === true ? "covered" : "not_covered"}.`;

  const noiseNote = opts.noise ? "Introduce mild realistic noise (typos) in customer messages where appropriate." : "No intentional typos.";

  const failureModesConfigText = opts.configured_failure_modes
    ? `Failure-mode configuration for this run (echo into metadata): ${JSON.stringify(opts.configured_failure_modes)}.`
    : "";

  const forcedFailureText = opts.forced_failure_mode ? `Force failure mode: ${opts.forced_failure_mode}.` : "";

  const claimAmountOverrideText = typeof opts.claimAmountOverride === "number" ? `Force claim amount: ${opts.claimAmountOverride}.` : "";

  const incidentExamples = opts.incidentTypes && opts.incidentTypes.length
    ? `Prefer incident types from this list: ${opts.incidentTypes.join(", ")}.`
    : "";

  const userInstruction = `
You MUST output exactly one JSON object and NOTHING ELSE. The JSON must follow this schema exactly:

{
  "id": string,
  "metadata": {
    "id": string,
    "seed": integer (optional),
    "configured_failure_modes": { "fraudProbability": number, "inconsistentProbability": number, "missingInfoProbability": number, "amountAnomalyProbability": number } (optional),
    "difficulty": "easy" | "medium" | "hard",
    "tone": string,
    "turns": integer,
    "length_category": "short" | "medium" | "long"
  },
  "messages": [
    { "speaker": "customer" | "bot", "text": string, "timestamp": string (optional) },
    ...
  ],
  "summary": string,
  "labels": {
    "covered": boolean (optional, derived),
    "coverage_decision": "covered" | "not_covered" | "edgecase",
    "reason": string,
    "policy_reference": string (short excerpt or clause),
    "claim_amount_estimate": number (optional),
    "photos_provided": boolean (optional),
    "fraud_suspected": boolean (optional),
    "failure_modes": [string] (optional)
  }
}

Constraints & instructions:
- Consult the POLICY text provided below to make coverage decisions. When you choose coverage_decision, include a short policy_reference (<=2 sentences) quoting or paraphrasing the specific clause that justifies your decision.
- Messages must alternate speaker roles, starting with the customer, and the number of messages must equal the 'turns' metadata value.
- The bot must try to collect these fields: policy number, claimant name, contact number, device model, incident date/time, incident type, description, claimed amount, photos_provided (yes/no). If information is missing, the bot should ask follow-ups.
- Introduce failure modes according to the configured_failure_modes probabilities or the forced failure mode. Failure modes:
  - fraud_attempt: fabricated receipts, mismatched serial numbers, obviously inconsistent evidence.
  - inconsistent_statement: conflicting times, changing details (e.g., device model differs mid-conversation), self-contradictions.
  - missing_info: customer does not provide policy number/receipt/serial and cannot or will not provide details.
  - amount_anomaly: claim amount is implausibly high or deliberately inflated (optionally trigger claimAmountOverride).
- When a failure mode occurs, encode it in labels.failure_modes and set fraud_suspected=true if fraud is plausible.
- For 'edgecase' coverage_decision, explain why the policy is not decisive and what additional evidence is needed.
- ${coveredNote}
- ${noiseNote}
- ${failureModesConfigText}
- ${forcedFailureText}
- ${claimAmountOverrideText}
- ${incidentExamples}
- ${idNote}
- If a seed is provided in metadata, include it verbatim.

Policy (BEGIN FULL POLICY)
${policyText}
Policy (END FULL POLICY)

Here are ${EXAMPLES.length} example JSON objects (format reference). Use them to match field names and structure exactly.
${JSON.stringify(EXAMPLES, null, 2)}

Now produce one conversation JSON object that follows these instructions and matches the requested parameters.
`;

  return userInstruction.trim();
}
