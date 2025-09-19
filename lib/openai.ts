import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  // Runtime will still allow startup, but API calls will fail; log a visible warning for developers.
  console.warn("OPENAI_API_KEY is not set. Set it in your environment (e.g. .env.local) before calling the API.");
}

export const openai = new OpenAI({
  apiKey,
});

export type ChatCompletionParams = {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  n?: number;
  stop?: string[] | string;
};

/**
 * Thin wrapper for creating a chat completion with the OpenAI client.
 * Keep this wrapper so we can centralize logging, retries, and future instrumentation.
 */
export async function createChatCompletion(params: ChatCompletionParams) {
  return openai.chat.completions.create(params);
}
