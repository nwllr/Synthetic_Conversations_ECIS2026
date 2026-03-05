import { z } from "zod";

export const MessageSchema = z.object({
  speaker: z.enum(["customer", "bot"]),
  text: z.string(),
  timestamp: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

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
  configured_failure_modes: ConfiguredFailureModesSchema.optional(),
  observed_failure_modes: z.array(z.string()).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  tone: z.string().optional(),
  turns: z.number().int().nonnegative(),
  length_category: z.enum(["short", "medium", "long"]).optional(),
  ground_truth: z.object({
    requested_coverage_decision: z.enum(["covered","not_covered","edgecase"]),
    provided_by_user: z.boolean(),
  }).optional(),
  parameters: z.record(z.any()).optional(),
});
export type Metadata = z.infer<typeof MetadataSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  metadata: MetadataSchema,
  messages: z.array(MessageSchema).min(1),
  summary: z.string(),
  generation_reasoning: z.object({
    why_this_scenario: z.string(),
    policy_reference: z.string(),
    parameter_effects: z.record(z.any()),
    edgecase_factors: z.array(z.string()).optional(),
    evidence_needed: z.array(z.string()).optional(),
  }),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export function parseAndValidateConversation(jsonText: string) {
  const parsed = JSON.parse(jsonText);
  return ConversationSchema.parse(parsed);
}