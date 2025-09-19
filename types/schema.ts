import { z } from "zod";

/**
 * Schema for a single message in the conversation.
 * speaker: "customer" | "bot"
 * text: the message contents
 */
export const MessageSchema = z.object({
  speaker: z.enum(["customer", "bot"]),
  text: z.string(),
  timestamp: z.string().optional(), // ISO 8601 if present
});

export type Message = z.infer<typeof MessageSchema>;

/**
 * Metadata for each conversation run and per-conversation metadata.
 * - seed: numeric seed used for deterministic generation
 * - configured_failure_modes: record of failure-mode config used for this run
 */
export const ConfiguredFailureModesSchema = z.object({
  fraudProbability: z.number().min(0).max(1).optional(),
  inconsistentProbability: z.number().min(0).max(1).optional(),
  missingInfoProbability: z.number().min(0).max(1).optional(),
  amountAnomalyProbability: z.number().min(0).max(1).optional(),
});

export type ConfiguredFailureModes = z.infer<typeof ConfiguredFailureModesSchema>;

export const MetadataSchema = z.object({
  id: z.string(),
  seed: z.number().int().optional(),
  // original UI-run configuration echoed into each conversation
  configured_failure_modes: ConfiguredFailureModesSchema.optional(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  tone: z.string().optional(),
  turns: z.number().int().nonnegative(),
  length_category: z.enum(["short", "medium", "long"]).optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

/**
 * Labels produced for each conversation. Replaces single boolean 'covered'
 * with a three-way decision and includes policy references and failure flags.
 */
export const LabelsSchema = z.object({
  // Backwards-compatible boolean derived from coverage_decision (optional)
  covered: z.boolean().optional(),
  // New three-way decision
  coverage_decision: z.enum(["covered", "not_covered", "edgecase"]),
  reason: z.string(),
  policy_reference: z.string().optional(), // short excerpt or clause id
  claim_amount_estimate: z.number().nullable().optional(),
  photos_provided: z.boolean().optional(),
  fraud_suspected: z.boolean().optional(),
  failure_modes: z.array(z.string()).optional(), // e.g., ["missing_info","inconsistent_statement"]
});

export type Labels = z.infer<typeof LabelsSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  metadata: MetadataSchema,
  messages: z.array(MessageSchema).min(1),
  summary: z.string(),
  labels: LabelsSchema,
});

export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * For validating responses that may contain multiple conversations (JSON array)
 */
export const ConversationsArraySchema = z.array(ConversationSchema);

export type ConversationsArray = z.infer<typeof ConversationsArraySchema>;

/**
 * Helpful wrapper validator that attempts to parse a JSON string and then validate
 * against the Conversation schema. Returns the parsed object on success or throws
 * a zod error on failure.
 */
export function parseAndValidateConversation(jsonText: string) {
  // Attempt to parse as JSON - model responses are sometimes JSON-with-trailing-text.
  const parsed = JSON.parse(jsonText);
  return ConversationSchema.parse(parsed);
}

export function parseAndValidateConversationsArray(jsonText: string) {
  const parsed = JSON.parse(jsonText);
  return ConversationsArraySchema.parse(parsed);
}
