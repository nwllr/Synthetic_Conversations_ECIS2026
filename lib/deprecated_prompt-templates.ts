/**
 * Prompt templates and helpers for synthetic conversation generation.
 *
 * This module builds strict JSON-only prompts that include:
 * - full policy text (inserted verbatim)
 * - explicit instructions for failure modes (fraud, inconsistent statements, missing info, amount anomalies)
 * - examples that demonstrate the required output schema (no labels section)
 * - **metadata.ground_truth** that echoes the requested coverage target
 * - **generation_reasoning** that justifies the scenario, including a concise policy_reference
 *
 * Notes:
 * - This file does NOT do any randomness. Per-sample randomization must be done server-side
 *   before calling buildPrompt (e.g., pick difficulty/tone/length/turns there and pass them in).
 */

/** Map difficulty to temperature value for model variance. */
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

export type CoverageDecision = "covered" | "not_covered" | "edgecase";

/** Options passed to buildPrompt. */
export type PromptOptions = {
  id: string;
  covered?: CoverageDecision;
  difficulty?: "easy" | "medium" | "hard";
  turns?: number;
  tone?: string;
  length?: "short" | "medium" | "long";
  noise?: boolean;
  incidentTypes?: string[];
  configured_failure_modes?: FailureModesConfig;
  /** Optional helper used when demonstrating amount anomalies in examples/runs. */
  claimAmountOverride?: number;
};

/**
 * Few-shot examples demonstrating covered, fraud/inconsistent not_covered,
 * edgecase with missing info, and amount anomaly. No labels; rich metadata +
 * generation_reasoning with policy_reference.
 */
const EXAMPLES = [
  {
    id: "example_001",
    metadata: {
      id: "example_001",
      configured_failure_modes: {
        fraudProbability: 0,
        inconsistentProbability: 0,
        missingInfoProbability: 0,
        amountAnomalyProbability: 0
      },
      difficulty: "easy",
      tone: "friendly",
      turns: 6,
      length_category: "short",
      ground_truth: {
        requested_coverage_decision: "covered",
        provided_by_user: true
      },
      parameters: {
        id: "example_001",
        covered: "covered",
        difficulty: "easy",
        turns: 6,
        tone: "friendly",
        length: "short",
        noise: false,
        incidentTypes: [],
        configured_failure_modes: {
          fraudProbability: 0,
          inconsistentProbability: 0,
          missingInfoProbability: 0,
          amountAnomalyProbability: 0
        }
      }
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
    generation_reasoning: {
      why_this_scenario: "Requested 'covered' with easy difficulty ⇒ straightforward ADH drop with clear timing and identifiers.",
      policy_reference: "ADH coverage applies when a sudden, accidental event causes damage during the plan term (e.g., 'Accidental Damage from Handling').",
      parameter_effects: {
        covered: "covered ⇒ steer case to clear coverage.",
        difficulty: "easy ⇒ minimal ambiguity, quick data capture.",
        tone: "friendly ⇒ empathetic bot phrasing.",
        turns: "6 ⇒ brief exchange, no detours."
      },
      edgecase_factors: [],
      evidence_needed: []
    }
  },
  {
    id: "example_002_fraud",
    metadata: {
      id: "example_002_fraud",
      configured_failure_modes: { fraudProbability: 1, inconsistentProbability: 1 },
      difficulty: "medium",
      tone: "professional",
      turns: 8,
      length_category: "medium",
      ground_truth: {
        requested_coverage_decision: "not_covered",
        provided_by_user: true
      },
      parameters: {
        id: "example_002_fraud",
        covered: "not_covered",
        difficulty: "medium",
        turns: 8,
        tone: "professional",
        length: "medium",
        noise: false,
        incidentTypes: ["theft"],
        configured_failure_modes: { fraudProbability: 1, inconsistentProbability: 1 }
      }
    },
    messages: [
      { speaker: "customer", text: "My phone was stolen from my bag last week." },
      { speaker: "bot", text: "I'm sorry. Do you have the police report number?" },
      { speaker: "customer", text: "Yes — PR-9988." },
      { speaker: "bot", text: "Please confirm your device serial number and model." },
      { speaker: "customer", text: "SN: ABCDE12345, iPhone 14." },
      { speaker: "bot", text: "We couldn't find that serial number on record for your policy. Can you double-check?" },
      { speaker: "customer", text: "Oh, my mistake — it’s 99999XXXXX and it's actually a 13." },
      { speaker: "bot", text: "The Plan excludes theft; the serial/model mismatches and changing details raise fraud concerns. Please provide verifiable proof." }
    ],
    summary: "Reported theft; serial/model mismatches and shifting details — flagged as suspicious/fraud attempt.",
    generation_reasoning: {
      why_this_scenario: "Requested 'not_covered' + fraudProbability=1 + inconsistentProbability=1 ⇒ theft is excluded; add mismatch and contradiction signals.",
      policy_reference: "Loss or theft is excluded under plan exclusions (e.g., 'Plan does not apply to a device that has been lost or stolen').",
      parameter_effects: {
        covered: "not_covered ⇒ ensure exclusion applies.",
        configured_failure_modes: "fraud + inconsistent ⇒ serial mismatch and changing model.",
        difficulty: "medium ⇒ allow back-and-forth but keep resolution clear.",
        incidentTypes: "theft ⇒ invoke theft exclusion."
      },
      edgecase_factors: [],
      evidence_needed: ["Valid serial matching policy", "Official police report copy"]
    }
  },
  {
    id: "example_003_edgecase_missing",
    metadata: {
      id: "example_003_edgecase_missing",
      configured_failure_modes: { missingInfoProbability: 1 },
      difficulty: "hard",
      tone: "neutral",
      turns: 6,
      length_category: "short",
      ground_truth: {
        requested_coverage_decision: "edgecase",
        provided_by_user: true
      },
      parameters: {
        id: "example_003_edgecase_missing",
        covered: "edgecase",
        difficulty: "hard",
        turns: 6,
        tone: "neutral",
        length: "short",
        noise: false,
        incidentTypes: [],
        configured_failure_modes: { missingInfoProbability: 1 }
      }
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
    generation_reasoning: {
      why_this_scenario: "Requested 'edgecase' with missingInfoProbability=1 ⇒ ambiguous malfunction vs ADH with insufficient identifiers.",
      policy_reference: "ADH requires a sudden accidental event; without proof/timing/identifiers, coverage cannot be confirmed.",
      parameter_effects: {
        covered: "edgecase ⇒ keep decision unresolved.",
        configured_failure_modes: "missing_info ⇒ customer withholds key identifiers.",
        difficulty: "hard ⇒ increased ambiguity and need for evidence."
      },
      edgecase_factors: [
        "No purchase proof or serial number",
        "Incident timing vague ('last month')",
        "Could be ADH or pre-existing defect"
      ],
      evidence_needed: ["Proof of purchase", "Exact incident date/time", "Device diagnostics or technician report"]
    }
  },
  {
    id: "example_004_amount_anomaly",
    metadata: {
      id: "example_004_amount_anomaly",
      configured_failure_modes: { amountAnomalyProbability: 1 },
      difficulty: "medium",
      tone: "concise",
      turns: 8,
      length_category: "medium",
      ground_truth: {
        requested_coverage_decision: "not_covered",
        provided_by_user: true
      },
      parameters: {
        id: "example_004_amount_anomaly",
        covered: "not_covered",
        difficulty: "medium",
        turns: 8,
        tone: "concise",
        length: "medium",
        noise: false,
        incidentTypes: ["liquid"],
        configured_failure_modes: { amountAnomalyProbability: 1 },
        claimAmountOverride: 2500
      }
    },
    messages: [
      { speaker: "customer", text: "I spilled water on my tablet; it won’t power on." },
      { speaker: "bot", text: "Sorry to hear that. Policy number and device model?" },
      { speaker: "customer", text: "PN-7777, Galaxy Tab A7." },
      { speaker: "bot", text: "When did this occur and what amount are you claiming?" },
      { speaker: "customer", text: "Three days ago; I need €2,500 for a replacement." },
      { speaker: "bot", text: "Our records show the device value at €349. The Plan limits payment to repair/replacement up to the device value/plan limit." },
      { speaker: "customer", text: "Well, I want the newest Pro model." },
      { speaker: "bot", text: "Requested amount is far above covered limits; claim appears inflated and cannot be approved as submitted." }
    ],
    summary: "Liquid damage to mid-range tablet; claimed amount grossly exceeds device value and plan limits.",
    generation_reasoning: {
      why_this_scenario: "Demonstrate amount_anomaly: claim demands replacement beyond device value/plan cap.",
      policy_reference: "Benefits are limited to repair or replacement up to device value/plan limit; upgrades to higher-tier models are not covered.",
      parameter_effects: {
        covered: "not_covered ⇒ emphasize denial given inflated amount.",
        configured_failure_modes: "amount_anomaly ⇒ claimed amount >> device value/limit.",
        incidentTypes: "liquid ⇒ typically covered when reasonable, but here the amount creates a denial."
      },
      edgecase_factors: ["Claimed replacement is for higher-tier device"],
      evidence_needed: ["Technician estimate to establish reasonable repair"]
    }
  }
];

const mapLengthCategory = (
  len?: "short" | "medium" | "long",
  turns?: number
): "short" | "medium" | "long" =>
  len ?? (turns ? (turns <= 6 ? "short" : turns <= 10 ? "medium" : "long") : "medium");

/**
 * Build a user prompt that instructs the model to output one JSON object only.
 * - policyText: full policy file text (inserted verbatim)
 * - opts: generation options
 */
export function buildPrompt(policyText: string, opts: PromptOptions) {
  const requestedCoverage: CoverageDecision = opts.covered ?? "edgecase";

  const coveredNote = `Ground-truth: coverage_decision = ${requestedCoverage}.`;

  const noiseNote = opts.noise
    ? "Introduce mild realistic noise (typos) in customer messages where appropriate."
    : "No intentional typos.";

  const failureModesConfigText = opts.configured_failure_modes
    ? `Failure-mode configuration for this run (echo into metadata): ${JSON.stringify(opts.configured_failure_modes)}.`
    : "";

  const incidentExamples = opts.incidentTypes?.length
    ? `Prefer incident types from this list: ${opts.incidentTypes.join(", ")}.`
    : "";

  // Fixed metadata instructions
  const fixedMetadataNote = `
Set metadata fields EXACTLY to these values:
- id = "${opts.id}"
- difficulty = "${opts.difficulty ?? "medium"}"
- tone = "${opts.tone ?? "neutral"}"
- turns = ${opts.turns ?? 6}
- length_category = "${mapLengthCategory(opts.length, opts.turns)}"
- ground_truth.requested_coverage_decision = "${requestedCoverage}"
- ground_truth.provided_by_user = true
- parameters = ${JSON.stringify(opts)}
${opts.configured_failure_modes ? "- configured_failure_modes = provided above" : ""}`.trim();

  const userInstruction = `
You MUST output exactly one JSON object and NOTHING ELSE. The JSON must follow this schema exactly:

{
  "id": string,
  "metadata": {
    "id": string,
    "configured_failure_modes": { "fraudProbability": number, "inconsistentProbability": number, "missingInfoProbability": number, "amountAnomalyProbability": number } (optional),
    "observed_failure_modes": [string] (optional),
    "difficulty": "easy" | "medium" | "hard",
    "tone": string,
    "turns": integer,
    "length_category": "short" | "medium" | "long",
    "ground_truth": {
      "requested_coverage_decision": "covered" | "not_covered" | "edgecase",
      "provided_by_user": boolean
    },
    "parameters": object
  },
  "messages": [
    { "speaker": "customer" | "bot", "text": string, "timestamp": string (optional) }
  ],
  "summary": string,
  "generation_reasoning": {
    "why_this_scenario": string,
    "policy_reference": string,  // quote or paraphrase the specific clause
    "parameter_effects": object,
    "edgecase_factors": [string] (optional),
    "evidence_needed": [string] (optional)
  }
}

Constraints & instructions:
- Consult the POLICY text and the ground truth (covered, not_covered, edgecase) provided below to generate a multi-turn conversation scenario. Include a concise policy_reference that quotes or paraphrases the specific clause used.
- Messages MUST alternate speaker roles, start with the customer, and the number of messages MUST equal the 'turns' metadata value.
- The bot must try to collect these fields: policy number, claimant name, contact number, device model, incident date/time, incident type, description, claimed amount, photos_provided (yes/no). If information is missing, the bot should ask follow-ups.
- If a failure mode is configured, adhere to it. In these cases, the ground truth may not be 'covered' (use 'not_covered' or 'edgecase' as appropriate to the failure).
- Failure modes that could be provided (can be combined):
  - fraud_attempt: fabricated receipts, mismatched serial numbers, obviously inconsistent evidence.
  - inconsistent_statement: conflicting times, changing details (e.g., device model differs mid-conversation), self-contradictions.
  - missing_info: customer does not provide policy number/receipt/serial and cannot or will not provide details.
  - amount_anomaly: claim amount is implausibly high or deliberately inflated (you may use claimAmountOverride if provided).
- When a failure mode occurs, add its string keys to metadata.observed_failure_modes.
- ${coveredNote}
- ${noiseNote}
- ${failureModesConfigText}
- ${incidentExamples}
- ${fixedMetadataNote}

Policy (BEGIN FULL POLICY)
${policyText}
Policy (END FULL POLICY)

Here are ${EXAMPLES.length} example JSON objects (format reference). Match field names and structure exactly.
${JSON.stringify(EXAMPLES, null, 2)}

Now produce one conversation JSON object that follows these instructions and matches the requested parameters.
`.trim();

  return userInstruction;
}

/**
 * Helper to produce stable model parameters (temperature) based on difficulty.
 */
export function getModelParams(opts: PromptOptions): { temperature: number } {
  const temperature = TEMPERATURE_BY_DIFFICULTY[opts.difficulty ?? "medium"];
  return { temperature };
}

/**
 * Example usage (pseudo-code):
 *
 * const prompt = buildPrompt(fullPolicyText, {
 *   id: "run_042",
 *   covered: "edgecase",
 *   difficulty: "hard",
 *   turns: 8,
 *   tone: "professional",
 *   length: "medium",
 *   noise: true,
 *   incidentTypes: ["liquid", "drop"],
 *   configured_failure_modes: { missingInfoProbability: 0.7, inconsistentProbability: 0.3 },
 *   claimAmountOverride: 1299,
 * });
 *
 * const params = getModelParams({ id: "run_042", covered: "edgecase", difficulty: "hard" });
 * // openai.chat.completions.create({ model: "...", messages: [...], temperature: params.temperature });
 */