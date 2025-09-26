import type { NextApiRequest, NextApiResponse } from "next";
import { openai } from "../../lib/openai";

type ScenarioEmbeddingItem = {
  id: string;
  text: string;
};

type EmbeddingResult = {
  id: string;
  embedding: number[];
};

type ScenarioEmbeddingResponse = {
  results: EmbeddingResult[];
  model?: string;
};

const MAX_ITEMS_PER_REQUEST = 64;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ScenarioEmbeddingResponse | { error: string }>
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
    return;
  }

  const itemsRaw = Array.isArray((req.body as any)?.items) ? ((req.body as any).items as ScenarioEmbeddingItem[]) : [];
  const items = itemsRaw
    .map((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string") {
        return null;
      }
      const cleaned = item.text.trim();
      if (!cleaned) return null;
      return {
        id: item.id,
        text: cleaned.length > 8000 ? cleaned.slice(0, 8000) : cleaned,
      };
    })
    .filter((item): item is ScenarioEmbeddingItem => Boolean(item));

  if (items.length === 0) {
    res.status(400).json({ error: "Provide at least one scenario text" });
    return;
  }

  const model =
    typeof (req.body as any)?.model === "string" && (req.body as any).model.trim()
      ? (req.body as any).model.trim()
      : "text-embedding-3-small";

  try {
    const results: EmbeddingResult[] = [];

    for (let start = 0; start < items.length; start += MAX_ITEMS_PER_REQUEST) {
      const chunk = items.slice(start, start + MAX_ITEMS_PER_REQUEST);
      const response = await openai.embeddings.create({
        model,
        input: chunk.map((item) => item.text),
      });

      response.data.forEach((entry, idx) => {
        const target = chunk[idx];
        if (!target) return;
        if (!Array.isArray(entry.embedding)) return;
        results.push({ id: target.id, embedding: entry.embedding });
      });
    }

    res.status(200).json({ results, model });
  } catch (err: any) {
    const message = err?.response?.data?.error?.message ?? err?.message ?? "Failed to compute embeddings";
    res.status(500).json({ error: message });
  }
}
