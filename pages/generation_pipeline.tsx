import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import policyAnchorsJson from "../policy/policy_anchors.json";

type FormState = {
  covered: string;
  notCovered: string;
  edgeCase: string;
  scenarioModel: string;
  scenarioTemperature: string;
  scenarioMaxTokens: string;
  conversationModel: string;
  conversationTemperature: string;
  conversationMaxTokens: string;
  conversationMaxTurns: string;
  personaIndex: string;
  seed: string;
};

type MessageRecord = {
  speaker: string;
  text?: string;
  raw_text?: string;
};

type ConversationRecord = {
  id?: string;
  created_at?: string;
  messages?: MessageRecord[];
  scenario_label?: string;
  scenario?: any;
  persona?: any;
  system_prompts?: {
    customer?: string;
    bot?: string;
  };
  model?: string;
  temperature?: number;
  max_tokens?: number;
  max_turns?: number;
  ended_within_turn_limit?: boolean;
  [key: string]: any;
};

type ProgressState = {
  total: number;
  generated: number;
  errors: number;
  scenariosGenerated: number;
};

type ScenarioRecord = {
  index: number;
  label?: string;
  scenario: any;
};

type LogEntry = {
  id: string;
  stream: "stdout" | "stderr" | "info";
  message: string;
};

type WarningEntry = {
  message: string;
  path?: string;
};

type RunInfo = {
  runId: string;
  outputDir: string;
  total: number;
};

type DonePayload = {
  stdout: string;
  stderr: string;
};

type FatalPayload = {
  message: string;
  stdout?: string;
  stderr?: string;
  runId?: string;
  outputDir?: string;
  total?: number;
  generated?: number;
  errors?: number;
  conversations?: ConversationRecord[];
  scenariosGenerated?: number;
  scenarios?: ScenarioRecord[];
};

type GeneratorEvent =
  | { type: "start"; data: { runId: string; outputDir: string; total: number; scenariosGenerated?: number } }
  | { type: "progress"; data: ProgressState }
  | { type: "item"; data: { index: number; conversation: ConversationRecord } }
  | { type: "scenario"; data: ScenarioRecord }
  | { type: "log"; data: { stream?: "stdout" | "stderr"; message?: string } }
  | { type: "error"; data: WarningEntry }
  | { type: "done"; data: { runId: string; outputDir: string; total: number; generated: number; errors: number; stdout?: string; stderr?: string; conversations?: ConversationRecord[]; scenariosGenerated?: number; scenarios?: ScenarioRecord[] } }
  | { type: "fatal"; data: FatalPayload & { scenariosGenerated?: number; scenarios?: ScenarioRecord[] } };

type EmbeddingCacheEntry = {
  fingerprint: string;
  vector: number[];
};

type EmbeddingItem = {
  id: string;
  label: string;
  labelKey: string;
  title: string;
  description: string;
  text: string;
  fingerprint: string;
  isAnchor?: boolean;
  anchorSection?: string;
  embeddingText: string;
};

type EmbeddingApiResult = {
  id: string;
  embedding: number[];
};

type SemanticPoint = {
  id: string;
  label: string;
  labelKey: string;
  title: string;
  description: string;
  x: number;
  y: number;
  isAnchor?: boolean;
  anchorSection?: string;
  embeddingText: string;
};

type NormalizedSemanticPoint = SemanticPoint & {
  xPct: number;
  yPct: number;
};

type EvaluationDashboardProps = {
  scenarios: ScenarioRecord[];
  conversations: ConversationRecord[];
};

type PolicyAnchor = {
  id: string;
  section: string;
  title: string;
  snippet: string;
};

type CoverageListProps = {
  title: string;
  total: number;
  entries: CoverageGroup[];
  formatter?: (label: string) => string;
};

type WordStatsBlockProps = {
  title: string;
  stats: WordStats;
  itemCount: number;
  extraDetails?: (string | undefined)[];
};

type SemanticLayoutState = {
  loading: boolean;
  error: string | null;
  points: SemanticPoint[];
};

type SemanticLayoutInfo = {
  nNeighbors: number;
  minDist: number;
};

type CoverageGroup = {
  label: string;
  count: number;
  percentage: number;
};

type WordStats = {
  totalTokens: number;
  uniqueTokens: number;
  lexicalDiversity: number;
  averagePerItem: number;
  medianPerItem: number;
  entropy: number;
  uniqueBigrams: number;
  topTokens: { token: string; count: number }[];
  topBigrams: { bigram: string; count: number }[];
};

const LABEL_COLOR_MAP: Record<string, string> = {
  covered: "#16a34a",
  not_covered: "#dc2626",
  edge_case: "#facc15",
  policy_reference: "#000000",
};

const LABEL_DISPLAY_MAP: Record<string, string> = {
  covered: "Covered",
  not_covered: "Not Covered",
  edge_case: "Edge Case",
  policy_reference: "Policy Reference",
};

const WORD_STATS_EMPTY: WordStats = {
  totalTokens: 0,
  uniqueTokens: 0,
  lexicalDiversity: 0,
  averagePerItem: 0,
  medianPerItem: 0,
  entropy: 0,
  uniqueBigrams: 0,
  topTokens: [],
  topBigrams: [],
};

const formatNumber = (value: number, fractionDigits = 1) => {
  if (!Number.isFinite(value)) {
    return (0).toFixed(fractionDigits);
  }
  return value.toFixed(fractionDigits);
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(1)}%`;
};

const POLICY_ANCHOR_LABEL_KEY = "policy_reference";
const POLICY_ANCHOR_STORAGE_KEY = "policy-anchor-embeddings-v1";
const policyAnchors: PolicyAnchor[] = policyAnchorsJson as PolicyAnchor[];

const normalizeLabelKey = (value?: string) => {
  if (!value) return "unlabeled";
  const normalized = value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unlabeled";
};

const humanizeKey = (value: string) => {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const getLabelColor = (labelKey: string) => LABEL_COLOR_MAP[labelKey] ?? "#6b7280";

const toDisplayLabel = (labelKey: string, fallback?: string) => LABEL_DISPLAY_MAP[labelKey] ?? fallback ?? humanizeKey(labelKey);

const tokenizeWords = (text: string): string[] => {
  if (!text) return [];
  const matches = text.toLowerCase().match(/[a-z0-9']+/g);
  return matches ? matches : [];
};

const computeMedian = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const computeEntropy = (counts: Map<string, number>, total: number): number => {
  if (total <= 0) return 0;
  let entropy = 0;
  counts.forEach((count) => {
    const probability = count / total;
    if (probability > 0) {
      entropy -= probability * Math.log2(probability);
    }
  });
  return entropy;
};

const countsToArray = (counts: Map<string, number>, total: number): CoverageGroup[] => {
  return Array.from(counts.entries())
    .map(([label, count]) => ({
      label,
      count,
      percentage: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count);
};

const computeWordStats = (texts: string[]): WordStats => {
  if (!texts.length) {
    return { ...WORD_STATS_EMPTY };
  }

  const tokenCounts = new Map<string, number>();
  const bigramCounts = new Map<string, number>();
  const lengths: number[] = [];
  let totalTokens = 0;

  texts.forEach((text) => {
    const tokens = tokenizeWords(text);
    lengths.push(tokens.length);
    totalTokens += tokens.length;

    tokens.forEach((token) => {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    });

    for (let idx = 0; idx < tokens.length - 1; idx += 1) {
      const bigram = `${tokens[idx]} ${tokens[idx + 1]}`;
      bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
    }
  });

  const uniqueTokens = tokenCounts.size;
  const lexicalDiversity = totalTokens > 0 ? uniqueTokens / totalTokens : 0;
  const averagePerItem = totalTokens / texts.length;
  const medianPerItem = computeMedian(lengths);
  const entropy = computeEntropy(tokenCounts, totalTokens);
  const uniqueBigrams = bigramCounts.size;

  const topTokens = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([token, count]) => ({ token, count }));

  const topBigrams = Array.from(bigramCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([bigram, count]) => ({ bigram, count }));

  return {
    totalTokens,
    uniqueTokens,
    lexicalDiversity,
    averagePerItem,
    medianPerItem,
    entropy,
    uniqueBigrams,
    topTokens,
    topBigrams,
  };
};

async function computeUmapPoints(
  items: EmbeddingItem[],
  cache: Map<string, EmbeddingCacheEntry>
): Promise<{ points: SemanticPoint[]; info: SemanticLayoutInfo | null }> {
  const itemsWithVectors = items
    .map((item) => {
      const cached = cache.get(item.id);
      if (!cached || cached.fingerprint !== item.fingerprint || !Array.isArray(cached.vector)) {
        return null;
      }
      return { item, vector: cached.vector };
    })
    .filter((entry): entry is { item: EmbeddingItem; vector: number[] } => Boolean(entry));

  if (!itemsWithVectors.length) {
    return { points: [], info: null };
  }

  const vectors = itemsWithVectors.map((entry) => entry.vector);
  const sampleCount = vectors.length;

  if (sampleCount === 1) {
    const only = itemsWithVectors[0];
    return {
      points: [
        {
          id: only.item.id,
          label: only.item.label,
          labelKey: only.item.labelKey,
          title: only.item.title,
          description: only.item.description,
          x: 0,
          y: 0,
          isAnchor: only.item.isAnchor,
          anchorSection: only.item.anchorSection,
          embeddingText: only.item.embeddingText,
        },
      ],
      info: { nNeighbors: 1, minDist: 0.1 },
    };
  }

  const maxNeighbors = Math.max(1, sampleCount - 1);
  const nNeighbors = Math.min(10, maxNeighbors);
  const minDist = 0.1;

  const response = await fetch("/api/umap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors,
      nNeighbors,
      minDist,
      metric: "cosine",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText || `UMAP request failed (${response.status})`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed?.error) {
        message = parsed.error;
      }
    } catch {
      // ignore JSON parse errors and use raw message
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as { coords?: number[][] };
  if (!payload?.coords || !Array.isArray(payload.coords)) {
    throw new Error("UMAP response missing coordinates");
  }

  const coords = payload.coords;

  const points: SemanticPoint[] = itemsWithVectors.map((entry, idx) => {
    const coord = coords[idx] ?? [0, 0];
    return {
      id: entry.item.id,
      label: entry.item.label,
      labelKey: entry.item.labelKey,
      title: entry.item.title,
      description: entry.item.description,
      x: Array.isArray(coord) ? coord[0] ?? 0 : 0,
      y: Array.isArray(coord) ? coord[1] ?? 0 : 0,
      isAnchor: entry.item.isAnchor,
      anchorSection: entry.item.anchorSection,
      embeddingText: entry.item.embeddingText,
    };
  });

  return {
    points,
    info: { nNeighbors, minDist },
  };
}
function EvaluationDashboard({ scenarios, conversations }: EvaluationDashboardProps) {
  const scenarioRecords = useMemo(
    () => scenarios.filter((record): record is ScenarioRecord => Boolean(record?.scenario)),
    [scenarios]
  );
  const conversationRecords = useMemo(
    () => conversations.filter((record): record is ConversationRecord => Boolean(record)),
    [conversations]
  );

  const embeddingCacheRef = useRef<Map<string, EmbeddingCacheEntry>>(new Map());
  const [semanticState, setSemanticState] = useState<SemanticLayoutState>({
    loading: false,
    error: null,
    points: [],
  });
  const [layoutInfo, setLayoutInfo] = useState<SemanticLayoutInfo | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<NormalizedSemanticPoint | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(POLICY_ANCHOR_STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Record<string, EmbeddingCacheEntry>;
      const cache = embeddingCacheRef.current;
      Object.entries(stored).forEach(([id, entry]) => {
        if (!entry || typeof entry.fingerprint !== "string" || !Array.isArray(entry.vector)) {
          return;
        }
        cache.set(id, entry);
      });
    } catch {
      // Ignore malformed storage
    }
  }, []);

  const policyAnchorItems = useMemo<EmbeddingItem[]>(() => {
    return policyAnchors.map((anchor) => {
      const snippet = anchor.snippet.trim();
      const anchorId = `policy::${anchor.id}`;
        return {
          id: anchorId,
          label: `Policy §${anchor.section}`,
          labelKey: POLICY_ANCHOR_LABEL_KEY,
          title: `${anchor.title} (§${anchor.section})`,
          description: snippet,
          text: snippet,
          fingerprint: `${anchorId}::${snippet}`,
          isAnchor: true,
          anchorSection: anchor.section,
          embeddingText: snippet,
        };
      });
  }, []);

  const embeddingItems = useMemo<EmbeddingItem[]>(() => {
    const scenarioItems = scenarioRecords
      .map((record, idx) => {
        const scenario = record?.scenario ?? {};
        const scenarioId =
          typeof scenario.id === "string" && scenario.id.trim()
            ? scenario.id.trim()
            : `Scenario-${typeof record.index === "number" ? record.index : idx}`;
        const title =
          typeof scenario.title === "string" && scenario.title.trim()
            ? scenario.title.trim()
            : "Untitled scenario";
        const description = typeof scenario.description === "string" ? scenario.description : "";
        const labelRaw = record.label ?? scenario.ground_truth ?? "Unlabeled";
        const labelKey = normalizeLabelKey(typeof labelRaw === "string" ? labelRaw : String(labelRaw));
        const segments: string[] = [title, description];
        if (typeof scenario.reasoning === "string") segments.push(scenario.reasoning);
        if (typeof scenario.claim_type === "string") segments.push(`Claim type: ${scenario.claim_type}`);
        if (Array.isArray(scenario.policy_references)) {
          scenario.policy_references.slice(0, 4).forEach((ref: any) => {
            if (ref && typeof ref.snippet === "string" && ref.snippet.trim()) {
              segments.push(ref.snippet);
            }
          });
        }
        const combined = segments.filter(Boolean).join(". ");
        const truncated = combined.length > 8000 ? combined.slice(0, 8000) : combined;
        return {
          id: scenarioId,
          label: typeof labelRaw === "string" ? labelRaw : String(labelRaw ?? "Unlabeled"),
          labelKey,
          title,
          description,
          text: truncated,
          fingerprint: `${scenarioId}::${truncated}`,
          embeddingText: truncated,
        };
      })
      .filter((item) => item.text.trim().length > 0);

    return [...scenarioItems, ...policyAnchorItems];
  }, [scenarioRecords, policyAnchorItems]);

  const persistAnchorEmbeddings = useCallback(() => {
    if (typeof window === "undefined") return;
    const cache = embeddingCacheRef.current;
    const payload: Record<string, EmbeddingCacheEntry> = {};
    embeddingItems.forEach((item) => {
      if (!item.isAnchor) return;
      const cached = cache.get(item.id);
      if (!cached || cached.fingerprint !== item.fingerprint || !Array.isArray(cached.vector)) {
        return;
      }
      payload[item.id] = cached;
    });

    try {
      window.localStorage.setItem(POLICY_ANCHOR_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Best-effort persistence only
    }
  }, [embeddingItems]);

  useEffect(() => {
    if (scenarioRecords.length === 0) {
      const cache = embeddingCacheRef.current;
      const anchorIds = new Set(policyAnchorItems.map((anchor) => anchor.id));
      Array.from(cache.keys()).forEach((key) => {
        if (!anchorIds.has(key)) {
          cache.delete(key);
        }
      });
      setSemanticState({ loading: false, error: null, points: [] });
      setLayoutInfo(null);
      setHoveredPoint(null);
    }
  }, [scenarioRecords.length, policyAnchorItems]);

  useEffect(() => {
    if (scenarioRecords.length === 0 || embeddingItems.length === 0) {
      setSemanticState({ loading: false, error: null, points: [] });
      setLayoutInfo(null);
      setHoveredPoint(null);
      return;
    }

    const cache = embeddingCacheRef.current;
    const missing = embeddingItems.filter((item) => {
      const cached = cache.get(item.id);
      return !cached || cached.fingerprint !== item.fingerprint;
    });

    let cancelled = false;
    const controller = new AbortController();

    const fetchChunk = async (chunk: EmbeddingItem[]) => {
      const response = await fetch("/api/scenario-embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: chunk.map((item) => ({ id: item.id, text: item.text })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Embedding request failed (${response.status})`);
      }
      const payload = await response.json();
      const results = Array.isArray(payload?.results) ? (payload.results as EmbeddingApiResult[]) : [];
      const chunkMap = new Map(chunk.map((item) => [item.id, item]));
      results.forEach((result) => {
        if (!result || typeof result.id !== "string" || !Array.isArray(result.embedding)) return;
        const target = chunkMap.get(result.id);
        if (!target) return;
        cache.set(result.id, {
          fingerprint: target.fingerprint,
          vector: result.embedding,
        });
      });
    };

    const run = async () => {
      try {
        setSemanticState((prev) => ({ ...prev, loading: true, error: null }));
        if (missing.length > 0) {
          const CHUNK_SIZE = 64;
          for (let start = 0; start < missing.length; start += CHUNK_SIZE) {
            if (cancelled) return;
            const chunk = missing.slice(start, start + CHUNK_SIZE);
            await fetchChunk(chunk);
          }
        }
        if (cancelled) return;
        const { points, info } = await computeUmapPoints(embeddingItems, cache);
        if (cancelled) return;
        setLayoutInfo(info);
        setSemanticState({ loading: false, error: null, points });
        persistAnchorEmbeddings();
      } catch (err: any) {
        if (cancelled) return;
        setLayoutInfo(null);
        setSemanticState((prev) => ({
          ...prev,
          loading: false,
          error: err?.message ?? "Failed to compute embeddings",
        }));
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [scenarioRecords.length, embeddingItems, persistAnchorEmbeddings]);

  const normalizedPoints = useMemo<NormalizedSemanticPoint[]>(() => {
    if (!semanticState.points.length) return [];
    const xs = semanticState.points.map((point) => point.x);
    const ys = semanticState.points.map((point) => point.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;
    return semanticState.points.map((point) => ({
      ...point,
      xPct: ((point.x - xMin) / xRange) * 100,
      yPct: (1 - (point.y - yMin) / yRange) * 100,
    }));
  }, [semanticState.points]);

  useEffect(() => {
    setHoveredPoint(null);
  }, [normalizedPoints.length]);

  const legendEntries = useMemo(
    () =>
      semanticState.points.length === 0
        ? []
        : Array.from(
            semanticState.points.reduce((acc, point) => {
              const displayLabel = toDisplayLabel(point.labelKey, point.label);
              const current = acc.get(point.labelKey);
              if (current) {
                current.count += 1;
              } else {
                acc.set(point.labelKey, { label: displayLabel, count: 1 });
              }
              return acc;
            }, new Map<string, { label: string; count: number }>())
          )
            .map(([labelKey, value]) => ({
              labelKey,
              label: value.label,
              count: value.count,
            }))
            .sort((a, b) => b.count - a.count),
    [semanticState.points]
  );

  const layoutSummary = useMemo(() => {
    if (!layoutInfo) return null;
    return `UMAP · n_neighbors=${layoutInfo.nNeighbors}, min_dist=${formatNumber(layoutInfo.minDist, 2)}`;
  }, [layoutInfo]);

  const coverageSummary = useMemo(() => {
    const labelCounts = new Map<string, number>();
    const claimCounts = new Map<string, number>();
    const serviceCounts = new Map<string, number>();

    scenarioRecords.forEach((record) => {
      const scenario = record.scenario ?? {};
      const labelKey = normalizeLabelKey(record.label ?? scenario.ground_truth ?? "unlabeled");
      labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);

      const claimType =
        typeof scenario.claim_type === "string" && scenario.claim_type.trim()
          ? scenario.claim_type.trim()
          : "Unspecified";
      claimCounts.set(claimType, (claimCounts.get(claimType) ?? 0) + 1);

      const serviceState = scenario?.service_fee?.applies;
      let serviceKey = "unspecified";
      if (typeof serviceState === "boolean") {
        serviceKey = serviceState ? "service fee applies" : "service fee waived";
      } else if (typeof serviceState === "string" && serviceState.trim()) {
        serviceKey = serviceState.trim();
      }
      serviceCounts.set(serviceKey, (serviceCounts.get(serviceKey) ?? 0) + 1);
    });

    const personaCounts = new Map<string, number>();
    const conversationLengths: number[] = [];
    let endedWithinLimit = 0;

    conversationRecords.forEach((conversation) => {
      const length = Array.isArray(conversation.messages) ? conversation.messages.length : 0;
      if (length > 0) {
        conversationLengths.push(length);
      }
      if (conversation.ended_within_turn_limit) {
        endedWithinLimit += 1;
      }
      const persona = conversation.persona ?? {};
      const personaLabel =
        typeof persona.name === "string" && persona.name.trim()
          ? persona.name.trim()
          : typeof persona["occupation category"] === "string" && persona["occupation category"].trim()
          ? persona["occupation category"].trim()
          : typeof persona.occupation === "string" && persona.occupation.trim()
          ? persona.occupation.trim()
          : undefined;
      if (personaLabel) {
        personaCounts.set(personaLabel, (personaCounts.get(personaLabel) ?? 0) + 1);
      }
    });

    const averageTurns =
      conversationLengths.length > 0
        ? conversationLengths.reduce((sum, value) => sum + value, 0) / conversationLengths.length
        : 0;

    return {
      totalScenarios: scenarioRecords.length,
      totalConversations: conversationRecords.length,
      labels: countsToArray(labelCounts, scenarioRecords.length),
      claimTypes: countsToArray(claimCounts, scenarioRecords.length),
      serviceStates: countsToArray(serviceCounts, scenarioRecords.length),
      personaOccupations: countsToArray(personaCounts, conversationRecords.length),
      endedWithinLimit,
      averageTurns,
      medianTurns: computeMedian(conversationLengths),
    };
  }, [scenarioRecords, conversationRecords]);

  const scenarioTexts = useMemo(() => {
    return scenarioRecords
      .map((record) => {
        const scenario = record.scenario ?? {};
        const parts: string[] = [];
        if (typeof scenario.title === "string") parts.push(scenario.title);
        if (typeof scenario.description === "string") parts.push(scenario.description);
        if (typeof scenario.reasoning === "string") parts.push(scenario.reasoning);
        return parts.filter(Boolean).join(" ");
      })
      .filter((text) => text.trim().length > 0);
  }, [scenarioRecords]);

  const conversationTexts = useMemo(() => {
    const texts: string[] = [];
    conversationRecords.forEach((conversation) => {
      conversation.messages?.forEach((message) => {
        const candidate = message?.text ?? message?.raw_text;
        if (typeof candidate === "string" && candidate.trim()) {
          texts.push(candidate);
        }
      });
    });
    return texts;
  }, [conversationRecords]);

  const scenarioWordStats = useMemo(() => computeWordStats(scenarioTexts), [scenarioTexts]);
  const conversationWordStats = useMemo(() => computeWordStats(conversationTexts), [conversationTexts]);

  const uniqueOpenings = useMemo(() => {
    const openings = new Set<string>();
    conversationRecords.forEach((conversation) => {
      const first = conversation.messages?.[0]?.text;
      if (typeof first === "string" && first.trim()) {
        openings.add(first.trim());
      }
    });
    return openings.size;
  }, [conversationRecords]);

  if (!scenarioRecords.length) {
    return null;
  }

  return (
    <section
      style={{
        marginTop: 32,
        padding: 24,
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        background: "#f8fafc",
      }}
    >
      <h2 style={{ marginTop: 0, marginBottom: 12 }}>Automatic Evaluation</h2>
      <p style={{ marginTop: 0, marginBottom: 24, color: "#475569", maxWidth: 760 }}>
        Quick analytics over the latest run to understand semantic coverage, taxonomy balance, and language variety across the generated assets.
      </p>

      <div style={{ display: "grid", gap: 24 }}>
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, background: "#ffffff" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0 }}>Semantic Layout</h3>
            <span style={{ fontSize: 13, color: "#64748b" }}>
              {semanticState.loading ? "Computing embeddings…" : `${semanticState.points.length} scenarios`}
            </span>
          </div>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
            UMAP embeds scenario narratives and projects them into a two-dimensional map so you can spot dense clusters or outliers at a glance.
          </p>

          <div
            style={{
              position: "relative",
              height: 320,
              border: "1px dashed #cbd5f5",
              borderRadius: 12,
              background: "#f8fafc",
              marginTop: 12,
            }}
          >
            {semanticState.error ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#b91c1c",
                  fontSize: 13,
                  padding: 16,
                  textAlign: "center",
                }}
              >
                {semanticState.error}
              </div>
            ) : normalizedPoints.length === 0 ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#94a3b8",
                  fontSize: 13,
                }}
              >
                Waiting for embeddings…
              </div>
            ) : (
              <>
                {normalizedPoints.map((point) => (
                  <div
                    key={point.id}
                    title={`${point.title} • ${toDisplayLabel(point.labelKey, point.label)}`}
                    onMouseEnter={() => setHoveredPoint(point)}
                    onMouseLeave={() => {
                      setHoveredPoint((current) => (current?.id === point.id ? null : current));
                    }}
                    style={{
                      position: "absolute",
                      left: `calc(${point.xPct}% - 6px)`,
                      top: `calc(${point.yPct}% - 6px)`,
                      width: point.isAnchor ? 14 : 12,
                      height: point.isAnchor ? 14 : 12,
                      borderRadius: point.isAnchor ? 4 : "50%",
                      background: getLabelColor(point.labelKey),
                      border: "1px solid rgba(15,23,42,0.2)",
                      boxShadow: "0 1px 3px rgba(15,23,42,0.25)",
                      cursor: "pointer",
                    }}
                  />
                ))}
                {hoveredPoint && (
                  <div
                    style={{
                      position: "absolute",
                      left: `${hoveredPoint.xPct}%`,
                      top: `${hoveredPoint.yPct}%`,
                      transform: "translate(-50%, -130%)",
                      background: "#0f172a",
                      color: "#ffffff",
                      padding: "8px 12px",
                      borderRadius: 10,
                      fontSize: 12,
                      boxShadow: "0 8px 16px rgba(15,23,42,0.25)",
                      pointerEvents: "none",
                      maxWidth: 260,
                      textAlign: "left",
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{hoveredPoint.title}</div>
                    <div style={{ marginTop: 2, opacity: 0.85 }}>
                      {hoveredPoint.isAnchor
                        ? `Policy reference (§${hoveredPoint.anchorSection ?? ""})`
                        : toDisplayLabel(hoveredPoint.labelKey, hoveredPoint.label)}
                    </div>
                    {hoveredPoint.embeddingText ? (
                      <div style={{ marginTop: 6, opacity: 0.75, lineHeight: 1.35 }}>
                        {hoveredPoint.embeddingText.length > 230
                          ? `${hoveredPoint.embeddingText.slice(0, 227)}…`
                          : hoveredPoint.embeddingText}
                      </div>
                    ) : null}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#475569" }}>
            {layoutSummary && <span>{layoutSummary}</span>}
            {normalizedPoints.length < 2 && !semanticState.error && (
              <span style={{ color: "#94a3b8" }}>Generate at least two scenarios to see the relative layout.</span>
            )}
          </div>

          {legendEntries.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 14 }}>
              {legendEntries.map((entry) => (
                <div
                  key={entry.labelKey}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#475569" }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: getLabelColor(entry.labelKey),
                      display: "inline-block",
                    }}
                  />
                  <span>
                    {toDisplayLabel(entry.labelKey, entry.label)} ({entry.count})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, background: "#ffffff" }}>
          <h3 style={{ marginTop: 0 }}>Coverage Dashboard</h3>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
            Distribution across policy labels, claim types, and service fee states. Helps surface blind spots in the generated batch.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 16,
              marginTop: 16,
            }}
          >
            <CoverageList
              title="Scenario Labels"
              total={coverageSummary.totalScenarios}
              entries={coverageSummary.labels}
              formatter={(label) => toDisplayLabel(label)}
            />
            <CoverageList
              title="Claim Types"
              total={coverageSummary.totalScenarios}
              entries={coverageSummary.claimTypes}
              formatter={(label) => humanizeKey(label)}
            />
            <CoverageList
              title="Service Fee State"
              total={coverageSummary.totalScenarios}
              entries={coverageSummary.serviceStates}
              formatter={(label) => humanizeKey(label)}
            />
          </div>

          <div style={{ marginTop: 20 }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 14, color: "#0f172a" }}>Conversation Highlights</h4>
            {coverageSummary.totalConversations === 0 ? (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>No simulated conversations yet.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#475569", display: "grid", gap: 4 }}>
                <li>Conversations: {coverageSummary.totalConversations}</li>
                <li>
                  Average turns: {formatNumber(coverageSummary.averageTurns, 1)} · Median: {formatNumber(coverageSummary.medianTurns, 0)}
                </li>
                <li>
                  Stayed within turn limit: {coverageSummary.endedWithinLimit} (
                  {formatPercent(
                    coverageSummary.totalConversations
                      ? coverageSummary.endedWithinLimit / coverageSummary.totalConversations
                      : 0
                  )}
                  )
                </li>
                {coverageSummary.personaOccupations.slice(0, 3).map((entry) => (
                  <li key={entry.label}>
                    Persona signal: {entry.label} — {entry.count}
                    {coverageSummary.totalConversations ? ` (${formatPercent(entry.percentage)})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 20, background: "#ffffff" }}>
          <h3 style={{ marginTop: 0 }}>Linguistic Variety</h3>
          <p style={{ fontSize: 13, color: "#64748b", marginTop: 6 }}>
            Lexical diversity, n-gram reuse, and other lightweight signals to ensure the content stays fresh.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16,
              marginTop: 16,
            }}
          >
            <WordStatsBlock title="Scenario Narratives" stats={scenarioWordStats} itemCount={scenarioRecords.length} />
            <WordStatsBlock
              title="Conversation Messages"
              stats={conversationWordStats}
              itemCount={conversationTexts.length}
              extraDetails={[
                coverageSummary.totalConversations ? `Avg turns: ${formatNumber(coverageSummary.averageTurns, 1)}` : undefined,
                `Distinct openings: ${uniqueOpenings}`,
              ]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function CoverageList({ title, total, entries, formatter }: CoverageListProps) {
  const displayEntries = entries.slice(0, 5);
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{title}</div>
      {displayEntries.length === 0 ? (
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>No data yet.</p>
      ) : (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#475569", display: "grid", gap: 4 }}>
          {displayEntries.map((entry) => (
            <li key={`${title}-${entry.label}`}>
              {formatter ? formatter(entry.label) : entry.label}
              {" "}— {entry.count}
              {total > 0 ? ` (${formatPercent(entry.percentage)})` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WordStatsBlock({ title, stats, itemCount, extraDetails }: WordStatsBlockProps) {
  const topTokens = stats.topTokens.slice(0, 6);
  const topBigrams = stats.topBigrams.slice(0, 3);

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, color: "#0f172a" }}>{title}</div>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#475569", display: "grid", gap: 4 }}>
        <li>Items: {itemCount}</li>
        <li>
          Words: {stats.totalTokens} · Unique: {stats.uniqueTokens}
        </li>
        <li>Lexical diversity: {formatPercent(stats.lexicalDiversity)}</li>
        <li>Median length: {formatNumber(stats.medianPerItem, 0)} words</li>
        <li>Entropy: {formatNumber(stats.entropy, 2)} bits</li>
      </ul>

      {extraDetails?.filter(Boolean).length ? (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#475569", display: "grid", gap: 4 }}>
          {extraDetails
            .filter(Boolean)
            .map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
        </ul>
      ) : null}

      {topTokens.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#475569" }}>
          <span style={{ fontWeight: 600 }}>Top tokens:</span>{" "}
          {topTokens.map((item) => `${item.token} (${item.count})`).join(", ")}
        </div>
      )}

      {topBigrams.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#475569" }}>
          <span style={{ fontWeight: 600 }}>Top bigrams:</span>{" "}
          {topBigrams.map((item) => `${item.bigram} (${item.count})`).join(", ")}
        </div>
      )}
    </div>
  );
}


const initialForm: FormState = {
  covered: "2",
  notCovered: "1",
  edgeCase: "1",
  scenarioModel: "gpt-4.1",
  scenarioTemperature: "0.35",
  scenarioMaxTokens: "2800",
  conversationModel: "gpt-4.1-mini",
  conversationTemperature: "0.7",
  conversationMaxTokens: "400",
  conversationMaxTurns: "20",
  personaIndex: "",
  seed: "",
};

const parseNumber = (value: string): number | undefined => {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const formatDate = (iso?: string) => {
  if (!iso) return "Unknown";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

const prettySpeaker = (speaker?: string) => {
  if (!speaker) return "Unknown";
  return speaker.charAt(0).toUpperCase() + speaker.slice(1);
};

const MetadataRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 11, textTransform: "uppercase", color: "#64748b", letterSpacing: "0.05em" }}>{label}</div>
    <div style={{ fontSize: 14, color: "#1e293b" }}>{value}</div>
  </div>
);

const makeLogId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function GenerationPipelinePage() {
  const [form, setForm] = useState<FormState>({ ...initialForm });
  const [loading, setLoading] = useState(false);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ total: 0, generated: 0, errors: 0, scenariosGenerated: 0 });
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioRecord[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [warnings, setWarnings] = useState<WarningEntry[]>([]);
  const [donePayload, setDonePayload] = useState<DonePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatalDetail, setFatalDetail] = useState<FatalPayload | null>(null);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (conversations.length === 0) {
      if (selectedIndex !== null) {
        setSelectedIndex(null);
      }
      return;
    }

    if (selectedIndex === null) {
      setSelectedIndex(0);
      return;
    }

    if (selectedIndex >= conversations.length) {
      setSelectedIndex(conversations.length - 1);
    }
  }, [conversations, selectedIndex]);

  const handleSubmit = async (evt: React.FormEvent<HTMLFormElement>) => {
    evt.preventDefault();

    const coveredCount = Math.max(0, Math.floor(parseNumber(form.covered) ?? 0));
    const notCoveredCount = Math.max(0, Math.floor(parseNumber(form.notCovered) ?? 0));
    const edgeCaseCount = Math.max(0, Math.floor(parseNumber(form.edgeCase) ?? 0));
    const totalScenarios = coveredCount + notCoveredCount + edgeCaseCount;

    if (totalScenarios <= 0) {
      setError("Enter at least one scenario to generate.");
      return;
    }

    setLoading(true);
    setRunInfo(null);
    setProgress({ total: totalScenarios, generated: 0, errors: 0, scenariosGenerated: 0 });
    setConversations([]);
    setScenarios([]);
    setSelectedIndex(null);
    setLogs([]);
    setWarnings([]);
    setDonePayload(null);
    setError(null);
    setFatalDetail(null);

    const payload = {
      counts: {
        covered: coveredCount,
        notCovered: notCoveredCount,
        edgeCase: edgeCaseCount,
      },
      scenarioModel: form.scenarioModel.trim() || undefined,
      scenarioTemperature: parseNumber(form.scenarioTemperature),
      scenarioMaxTokens: parseNumber(form.scenarioMaxTokens),
      conversationModel: form.conversationModel.trim() || undefined,
      conversationTemperature: parseNumber(form.conversationTemperature),
      conversationMaxTokens: parseNumber(form.conversationMaxTokens),
      conversationMaxTurns: parseNumber(form.conversationMaxTurns),
      personaIndex: parseNumber(form.personaIndex),
      seed: parseNumber(form.seed),
    };

    try {
      const resp = await fetch("/api/generation-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok || !resp.body) {
        const text = await resp.text();
        throw new Error(text || `Server returned ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let running = true;

      while (running) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n").map((line) => line.trim()).filter(Boolean);
          if (lines.length === 0) continue;
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          const eventName = eventLine ? eventLine.slice("event:".length).trim() : "message";
          const jsonText = dataLine.slice("data:".length).trim();
          let payloadData: any;
          try {
            payloadData = JSON.parse(jsonText);
          } catch (err) {
            continue;
          }

          if (!["start", "progress", "scenario", "item", "log", "error", "done", "fatal"].includes(eventName)) {
            continue;
          }

          const eventType = eventName as GeneratorEvent["type"];
          const eventData = payloadData as any;

          switch (eventType) {
            case "start":
              setRunInfo({
                runId: eventData.runId,
                outputDir: eventData.outputDir,
                total: eventData.total,
              });
              setConversations([]);
              setScenarios([]);
              setProgress({
                total: eventData.total,
                generated: 0,
                errors: 0,
                scenariosGenerated: eventData.scenariosGenerated ?? 0,
              });
              break;
            case "progress":
              setProgress((prev) => ({
                total: typeof (eventData as ProgressState)?.total === "number" ? (eventData as ProgressState).total : prev.total,
                generated: typeof (eventData as ProgressState)?.generated === "number" ? (eventData as ProgressState).generated : prev.generated,
                errors: typeof (eventData as ProgressState)?.errors === "number" ? (eventData as ProgressState).errors : prev.errors,
                scenariosGenerated:
                  typeof (eventData as ProgressState)?.scenariosGenerated === "number"
                    ? (eventData as ProgressState).scenariosGenerated
                    : prev.scenariosGenerated,
              }));
              break;
            case "scenario":
              {
                const record = eventData as ScenarioRecord;
                setScenarios((prev) => {
                  const next = [...prev];
                  const targetIndex = typeof record.index === "number" ? record.index : next.length;
                  next[targetIndex] = record;
                  return next;
                });
                setProgress((prev) => ({
                  ...prev,
                  scenariosGenerated: Math.max(
                    prev.scenariosGenerated,
                    (typeof record.index === "number" ? record.index : prev.scenariosGenerated) + 1
                  ),
                }));
              }
              break;
            case "item":
              setConversations((prev) => {
                const next = [...prev];
                next[eventData.index] = eventData.conversation;
                return next;
              });
              break;
            case "log":
              if ((eventData as any)?.message) {
                setLogs((prev) => [
                  ...prev,
                  {
                    id: makeLogId(),
                    stream: (eventData as any).stream ?? "info",
                    message: (eventData as any).message,
                  },
                ]);
              }
              break;
            case "error":
              setWarnings((prev) => [...prev, eventData as WarningEntry]);
              break;
            case "done":
              setRunInfo({
                runId: (eventData as any).runId,
                outputDir: (eventData as any).outputDir,
                total: (eventData as any).total,
              });
              if (Array.isArray((eventData as any)?.conversations)) {
                setConversations((eventData as any).conversations);
              }
              if (Array.isArray((eventData as any)?.scenarios)) {
                setScenarios((eventData as any).scenarios);
              }
              setProgress({
                total: (eventData as any).total,
                generated: (eventData as any).generated,
                errors: (eventData as any).errors,
                scenariosGenerated:
                  typeof (eventData as any).scenariosGenerated === "number"
                    ? (eventData as any).scenariosGenerated
                    : Array.isArray((eventData as any)?.scenarios)
                    ? (eventData as any).scenarios.length
                    : (eventData as any).generated,
              });
              setDonePayload({
                stdout: (eventData as any).stdout ?? "",
                stderr: (eventData as any).stderr ?? "",
              });
              running = false;
              break;
            case "fatal":
              setFatalDetail(eventData as FatalPayload);
              if (Array.isArray((eventData as any)?.conversations)) {
                setConversations((eventData as any).conversations);
              }
              if (Array.isArray((eventData as any)?.scenarios)) {
                setScenarios((eventData as any).scenarios);
              }
              setProgress((prev) => ({
                total: typeof (eventData as any)?.total === "number" ? (eventData as any).total : prev.total,
                generated: typeof (eventData as any)?.generated === "number" ? (eventData as any).generated : prev.generated,
                errors: typeof (eventData as any)?.errors === "number" ? (eventData as any).errors : prev.errors,
                scenariosGenerated:
                  typeof (eventData as any)?.scenariosGenerated === "number"
                    ? (eventData as any).scenariosGenerated
                    : Array.isArray((eventData as any)?.scenarios)
                    ? (eventData as any).scenarios.length
                    : prev.scenariosGenerated,
              }));
              if ((eventData as any)?.runId && (eventData as any)?.outputDir) {
                setRunInfo((prev) => ({
                  runId: (eventData as any).runId,
                  outputDir: (eventData as any).outputDir,
                  total: typeof (eventData as any).total === "number" ? (eventData as any).total : prev?.total ?? 0,
                }));
              }
              setDonePayload({
                stdout: (eventData as any).stdout ?? "",
                stderr: (eventData as any).stderr ?? "",
              });
              setError((eventData as any).message ?? "Python generator failed");
              running = false;
              break;
            default:
              break;
          }
        }
      }

      try {
        reader.releaseLock();
      } catch {}
    } catch (err: any) {
      setError(err?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setForm({ ...initialForm });
  };

  const selectedConversation = useMemo(() => {
    if (selectedIndex === null) return null;
    return conversations[selectedIndex] ?? null;
  }, [conversations, selectedIndex]);

  const downloadConversation = (conversation: ConversationRecord | null) => {
    if (!conversation) return;
    const filename = `${conversation.id ?? "conversation"}.json`;
    const blob = new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const scenarioCount = scenarios.filter(Boolean).length;
  const conversationCount = conversations.filter(Boolean).length;
  const scenarioProgressPercent = progress.total > 0 ? Math.min(100, Math.round((progress.scenariosGenerated / progress.total) * 100)) : 0;
  const conversationProgressPercent = progress.total > 0 ? Math.min(100, Math.round((progress.generated / progress.total) * 100)) : 0;

  return (
    <div style={{ maxWidth: 1100, margin: "32px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Scenario Generation Pipeline</h1>
        <p style={{ margin: "8px 0 0", color: "#475569" }}>
          Generate fresh scenarios and automatically simulate one conversation per scenario.
        </p>
        <p style={{ margin: "4px 0 0", color: "#64748b" }}>
          Need the conversation-only runner? Visit <Link href="/python-generator">/python-generator</Link>.
        </p>
      </header>

      <section style={{ padding: 24, border: "1px solid #e2e8f0", borderRadius: 12, marginBottom: 24 }}>
        <form onSubmit={handleSubmit}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Scenarios</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Covered scenarios</span>
              <input
                type="number"
                min={0}
                value={form.covered}
                onChange={(e) => updateField("covered", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Not covered scenarios</span>
              <input
                type="number"
                min={0}
                value={form.notCovered}
                onChange={(e) => updateField("notCovered", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Edge case scenarios</span>
              <input
                type="number"
                min={0}
                value={form.edgeCase}
                onChange={(e) => updateField("edgeCase", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
          </div>

          <h2 style={{ marginTop: 24, fontSize: 18 }}>Scenario generation settings</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Scenario model</span>
              <input
                type="text"
                value={form.scenarioModel}
                onChange={(e) => updateField("scenarioModel", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Scenario temperature</span>
              <input
                type="number"
                step="0.05"
                value={form.scenarioTemperature}
                onChange={(e) => updateField("scenarioTemperature", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Scenario max tokens</span>
              <input
                type="number"
                min={256}
                value={form.scenarioMaxTokens}
                onChange={(e) => updateField("scenarioMaxTokens", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
          </div>

          <h2 style={{ marginTop: 24, fontSize: 18 }}>Conversation settings</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Conversation model</span>
              <input
                type="text"
                value={form.conversationModel}
                onChange={(e) => updateField("conversationModel", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Conversation temperature</span>
              <input
                type="number"
                step="0.05"
                value={form.conversationTemperature}
                onChange={(e) => updateField("conversationTemperature", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Conversation max tokens</span>
              <input
                type="number"
                min={64}
                value={form.conversationMaxTokens}
                onChange={(e) => updateField("conversationMaxTokens", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Conversation max turns</span>
              <input
                type="number"
                min={2}
                value={form.conversationMaxTurns}
                onChange={(e) => updateField("conversationMaxTurns", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Persona index (optional)</span>
              <input
                type="number"
                value={form.personaIndex}
                onChange={(e) => updateField("personaIndex", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Seed (optional)</span>
              <input
                type="number"
                value={form.seed}
                onChange={(e) => updateField("seed", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
          </div>

          <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
            <button type="submit" disabled={loading} style={{ padding: "10px 16px" }}>
              {loading ? "Running…" : "Run generation pipeline"}
            </button>
            <button type="button" onClick={resetForm} disabled={loading} style={{ padding: "10px 16px" }}>
              Reset
            </button>
          </div>
        </form>
      </section>

      {error && (
        <section
          style={{
            padding: 16,
            border: "1px solid #fca5a5",
            borderRadius: 12,
            marginBottom: 24,
            background: "#fff1f2",
          }}
        >
          <h2 style={{ marginTop: 0 }}>Error</h2>
          <p>{error}</p>
          {fatalDetail?.stderr && (
            <details>
              <summary>stderr</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{fatalDetail.stderr}</pre>
            </details>
          )}
          {fatalDetail?.stdout && (
            <details>
              <summary>stdout</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>{fatalDetail.stdout}</pre>
            </details>
          )}
        </section>
      )}

      {(runInfo || loading || conversationCount > 0 || warnings.length > 0 || donePayload) && (
        <section
          style={{
            padding: 16,
            border: "1px solid #c5e1a5",
            borderRadius: 12,
            marginBottom: 24,
            background: "#f5fff0",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h2 style={{ marginTop: 0, marginBottom: 4 }}>
                {runInfo ? `Run ${runInfo.runId}` : "Current run"}
              </h2>
              {runInfo && (
                <p style={{ margin: 0 }}>
                  Output directory: <code>{runInfo.outputDir}</code>
                </p>
              )}
            </div>
            <div style={{ fontSize: 13, color: "#475569" }}>
              {loading ? "Running…" : donePayload ? "Completed" : conversationCount ? "Idle" : ""}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>Progress</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ minWidth: 130, fontSize: 12, color: "#475569" }}>Scenarios</div>
                <div style={{ flex: 1, height: 10, background: "#e2e8f0", borderRadius: 999 }}>
                  <div
                    style={{
                      width: `${scenarioProgressPercent}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: "#10b981",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "#047857" }}>
                  {progress.scenariosGenerated} / {progress.total}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ minWidth: 130, fontSize: 12, color: "#475569" }}>Conversations</div>
                <div style={{ flex: 1, height: 10, background: "#e2e8f0", borderRadius: 999 }}>
                  <div
                    style={{
                      width: `${conversationProgressPercent}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: "#0ea5e9",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "#0f172a" }}>
                  {progress.generated} / {progress.total}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "#dc2626", textAlign: "right" }}>Errors: {progress.errors}</div>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>Scenarios ({scenarioCount})</div>
            {scenarioCount === 0 ? (
              <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>Waiting for scenarios…</p>
            ) : (
              <div style={{
                marginTop: 8,
                maxHeight: 200,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}>
                {scenarios.map((record, idx) => {
                  if (!record) return null;
                  const scenario = record?.scenario ?? {};
                  const scenarioId = scenario?.id ?? `Scenario ${idx + 1}`;
                  const title = scenario?.title ?? "Untitled scenario";
                  const label = record?.label ?? scenario?.ground_truth ?? "";
                  return (
                    <div
                      key={`${scenarioId}-${idx}`}
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        padding: 10,
                        background: "#fff",
                        fontSize: 13,
                        color: "#0f172a",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                        <strong>{scenarioId}</strong>
                        {label && <span style={{ fontSize: 11, textTransform: "uppercase", color: "#475569" }}>{label}</span>}
                      </div>
                      <div style={{ color: "#475569", marginTop: 4 }}>{title}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {warnings.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>Warnings</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {warnings.map((w, idx) => (
                  <li key={`${w.message}-${idx}`} style={{ fontSize: 13, color: "#b45309" }}>
                    {w.message}
                    {w.path ? <span> ({w.path})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: conversationCount ? "280px 1fr" : "1fr", gap: 20, marginTop: 20 }}>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>Conversations</h3>
                <span style={{ fontSize: 13, color: "#475569" }}>{conversationCount}</span>
              </div>
              {conversationCount === 0 ? (
                <p style={{ color: "#64748b" }}>No JSON output yet.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflowY: "auto" }}>
                  {conversations.map((conv, idx) => {
                    if (!conv) return null;
                    const label = conv?.id ?? `Conversation ${idx + 1}`;
                    const messagesCount = Array.isArray(conv?.messages) ? conv.messages.length : 0;
                    const createdAt = formatDate(conv?.created_at);
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={`${label}-${idx}`}
                        type="button"
                        onClick={() => setSelectedIndex(idx)}
                        style={{
                          textAlign: "left",
                          borderRadius: 8,
                          padding: "10px 12px",
                          border: isSelected ? "1px solid #0ea5e9" : "1px solid #e2e8f0",
                          background: isSelected ? "#e0f2fe" : "#fff",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontWeight: 600, fontSize: 14, color: "#0f172a" }}>{label}</div>
                        <div style={{ fontSize: 12, color: "#475569" }}>Messages: {messagesCount}</div>
                        <div style={{ fontSize: 12, color: "#475569" }}>{createdAt}</div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {selectedConversation ? (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1fr) 320px", gap: 16, alignItems: "start" }}>
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{selectedConversation.id ?? "Conversation"}</h3>
                      <div style={{ fontSize: 12, color: "#475569" }}>
                        {selectedConversation.scenario_label ?? selectedConversation.scenario?.id ?? "Unknown scenario"} · {formatDate(selectedConversation.created_at)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => downloadConversation(selectedConversation)} style={{ padding: "6px 12px" }}>
                        Download JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(JSON.stringify(selectedConversation, null, 2))}
                        style={{ padding: "6px 12px" }}
                      >
                        Copy JSON
                      </button>
                    </div>
                  </div>

                  <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    <div
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 8,
                        padding: 12,
                        background: "#ffffff",
                        maxHeight: 520,
                        overflowY: "auto",
                        display: "flex",
                        flexDirection: "column",
                        gap: 12,
                      }}
                    >
                      {selectedConversation.messages?.length ? (
                        selectedConversation.messages.map((msg, idx) => {
                          const isCustomer = msg.speaker === "customer";
                          return (
                            <div key={idx} style={{ display: "flex", justifyContent: isCustomer ? "flex-start" : "flex-end" }}>
                              <div
                                style={{
                                  maxWidth: "75%",
                                  padding: 12,
                                  borderRadius: 12,
                                  background: isCustomer ? "#f8fafc" : "#0ea5e9",
                                  color: isCustomer ? "#0f172a" : "#ffffff",
                                  boxShadow: "0 1px 2px rgba(15,23,42,0.08)",
                                }}
                              >
                                <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.75, marginBottom: 6 }}>
                                  {prettySpeaker(msg.speaker)}
                                </div>
                                <div style={{ whiteSpace: "pre-wrap" }}>{msg.text || ""}</div>
                                {msg.raw_text && msg.raw_text !== msg.text && (
                                  <details style={{ marginTop: 8 }}>
                                    <summary style={{ fontSize: 12 }}>Raw response</summary>
                                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{msg.raw_text}</pre>
                                  </details>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>No messages captured.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 16, background: "#ffffff" }}>
                  <h3 style={{ marginTop: 0 }}>Metadata</h3>
                  <MetadataRow label="Model" value={selectedConversation.model ?? "n/a"} />
                  <MetadataRow label="Temperature" value={selectedConversation.temperature ?? "n/a"} />
                  <MetadataRow label="Max tokens" value={selectedConversation.max_tokens ?? "n/a"} />
                  <MetadataRow label="Max turns" value={selectedConversation.max_turns ?? "n/a"} />
                  <MetadataRow label="Ended within turn limit" value={String(!!selectedConversation.ended_within_turn_limit)} />
                  <MetadataRow
                    label="Scenario"
                    value={selectedConversation.scenario_label ?? selectedConversation.scenario?.id ?? "n/a"}
                  />
                  {selectedConversation.persona?.name && <MetadataRow label="Persona" value={selectedConversation.persona.name} />}

                  <details style={{ marginTop: 12 }}>
                    <summary>Scenario JSON</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                      {JSON.stringify(selectedConversation.scenario ?? {}, null, 2)}
                    </pre>
                  </details>

                  <details style={{ marginTop: 12 }}>
                    <summary>Persona JSON</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                      {JSON.stringify(selectedConversation.persona ?? {}, null, 2)}
                    </pre>
                  </details>

                  <details style={{ marginTop: 12 }}>
                    <summary>System prompts</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                      {JSON.stringify(selectedConversation.system_prompts ?? {}, null, 2)}
                    </pre>
                  </details>

                  <details style={{ marginTop: 12 }}>
                    <summary>Full conversation JSON</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                      {JSON.stringify(selectedConversation, null, 2)}
                    </pre>
                  </details>
                </div>
              </div>
            ) : (
              conversationCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
                  Select a conversation to inspect messages and metadata.
                </div>
              )
            )}
          </div>

          {logs.length > 0 && (
            <details style={{ marginTop: 20 }}>
              <summary>Logs</summary>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {logs.slice(-200).map((log) => (
                  <li key={log.id} style={{ fontSize: 12, color: log.stream === "stderr" ? "#b91c1c" : "#475569" }}>
                    <strong>{log.stream}:</strong> {log.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {donePayload && (
            <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
              {donePayload.stderr && (
                <details>
                  <summary>stderr</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{donePayload.stderr}</pre>
                </details>
              )}
              {donePayload.stdout && (
                <details>
                  <summary>stdout</summary>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{donePayload.stdout}</pre>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {scenarioCount > 0 && (
        <EvaluationDashboard scenarios={scenarios} conversations={conversations} />
      )}

    </div>
  );
}
