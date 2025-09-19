import React, { useState, useMemo } from "react";

/** Strict unions for UI selections */
type CoverageChoice = "covered" | "not_covered" | "edgecase";
type DifficultyChoice = "easy" | "medium" | "hard" | "random";
type LengthChoice = "short" | "medium" | "long" | "random";
type ToneChoice =
  | "friendly"
  | "professional"
  | "neutral"
  | "apologetic"
  | "assertive"
  | "casual"
  | "custom"
  | "random";
type TurnsMode = "short" | "average" | "long" | "random";

type GenerateOptions = {
  total: number;
  covered: CoverageChoice;                 // ground truth only these 3
  difficulty: DifficultyChoice;            // includes "random"
  turnsMode: TurnsMode;                    // steering, not a number
  length: LengthChoice;                    // includes "random"
  tone: ToneChoice;                        // includes "random"
  noise: boolean;                          // toggle typos/noise in customer messages
  liveProgress: boolean;                   // default streaming ON
  failureModesConfig: {
    fraudProbability: number;
    inconsistentProbability: number;
    missingInfoProbability: number;
    amountAnomalyProbability: number;
  };
};

type Conversation = any; // kept loose for UI

function Badge({ text, color }: { text: string; color?: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 8px",
        borderRadius: 12,
        background: color ?? "#eee",
        color: color ? "#fff" : "#333",
        fontSize: 12,
        marginRight: 6,
      }}
    >
      {text}
    </span>
  );
}

/** Option pools (for filters only) */
const TONES: Exclude<ToneChoice, "random">[] = [
  "friendly",
  "professional",
  "neutral",
  "apologetic",
  "assertive",
  "casual",
  "custom",
];

const TURNS_RANGES: Record<Exclude<TurnsMode, "random">, [number, number]> = {
  short: [2, 6],     // up to 6 messages
  average: [6, 10],  // 6–10 messages
  long: [10, 20],    // 10–20 messages
};
const turnsBucket = (turns?: number): Exclude<TurnsMode, "random"> | "unknown" => {
  if (!turns || typeof turns !== "number") return "unknown";
  if (turns <= 6) return "short";
  if (turns <= 10) return "average";
  return "long";
};

export default function HomePage() {
  const [options, setOptions] = useState<GenerateOptions>({
    total: 10,
    covered: "edgecase",
    difficulty: "random",
    turnsMode: "average",
    length: "random",
    tone: "random",
    noise: false,
    liveProgress: true, // default streaming ON
    failureModesConfig: {
      fraudProbability: 0.2,
      inconsistentProbability: 0.1,
      missingInfoProbability: 0.2,
      amountAnomalyProbability: 0.1,
    },
  });

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ requested: 0, generated: 0, errors: 0 });
  const [results, setResults] = useState<Conversation[]>([]);
  const [errorLog, setErrorLog] = useState<any[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);

  // Filters (cover all top-level inputs)
  const [filters, setFilters] = useState({
    coverage: "all",
    failureMode: "all",
    difficulty: "all",
    tone: "all",
    length: "all",
    noise: "all",            // all | true | false
    turnsBucket: "all",      // all | short | average | long
    search: "",
  });

  // UI tab state for the selected conversation inspector
  const [activeTab, setActiveTab] = useState<"messages" | "labels" | "prompt" | "raw">("messages");
  // Toggle to redact full policy text when displaying prompt in the UI
  const [redactPolicy, setRedactPolicy] = useState<boolean>(true);

  function updateOption<K extends keyof GenerateOptions>(key: K, value: GenerateOptions[K]) {
    setOptions((o) => ({ ...o, [key]: value }));
  }
  function updateFailureConfig<K extends keyof GenerateOptions["failureModesConfig"]>(key: K, value: number) {
    setOptions((o) => ({ ...o, failureModesConfig: { ...o.failureModesConfig, [key]: value } }));
  }

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setGenerating(true);
    setProgress({ requested: 0, generated: 0, errors: 0 });
    setResults([]);
    setErrorLog([]);
    setSelected(null);

    // IMPORTANT: do NOT resolve "random" on the client. Send as-is to the server.
    const body: any = {
      total: Number(options.total),
      covered: options.covered,           // "covered" | "not_covered" | "edgecase"
      difficulty: options.difficulty,     // "easy" | "medium" | "hard" | "random"
      turnsMode: options.turnsMode,       // "short" | "average" | "long" | "random"
      tone: options.tone,                 // tone or "random"
      length: options.length,             // "short" | "medium" | "long" | "random"
      noise: options.noise,
      failureModesConfig: options.failureModesConfig,
    };

    try {
      if (options.liveProgress) {
        // Streamed generation using the generate-stream endpoint.
        const resp = await fetch("/api/generate-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!resp.ok || !resp.body) {
          const text = await resp.text();
          throw new Error(`Server returned ${resp.status}: ${text}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let running = true;

        while (running) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Split on double-newline for event blocks
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const lines = part.split("\n").map((l) => l.trim());
            const eventLine = lines.find((l) => l.startsWith("event:"));
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice("event:".length).trim();
            const dataText = dataLine.slice("data:".length).trim();
            let payload: any = null;
            try {
              payload = JSON.parse(dataText);
            } catch {
              continue;
            }

            if (event === "progress") {
              setProgress((_) => ({
                requested: payload.requested ?? 0,
                generated: payload.generated ?? 0,
                errors: payload.errors ?? 0,
              }));
            } else if (event === "item") {
              const conv = payload.conversation;
              setResults((prev) => [...prev, conv]);
            } else if (event === "error") {
              setErrorLog((prev) => [...prev, payload]);
            } else if (event === "done") {
              setProgress((_) => ({
                requested: payload.requested ?? 0,
                generated: payload.generated ?? 0,
                errors: payload.errors ?? 0,
              }));
              running = false;
              break;
            }
          }
        }

        setGenerating(false);
      } 
    } catch (err: any) {
      setErrorLog((prev) => [...prev, { fatal: true, message: String(err) }]);
      setGenerating(false);
    }
  };

  const downloadJSONL = () => {
    if (!results || results.length === 0) return;
    const lines = results.map((r) => JSON.stringify(r)).join("\n");
    const blob = new Blob([lines], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `synthetic_conversations_${Date.now()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadCSV = () => {
    if (!results || results.length === 0) return;
    const headers = [
      "id",
      "coverage_ground_truth",
      "observed_failure_modes",
      "difficulty",
      "tone",
      "length_category",
      "turns",
      "noise",
    ];
    const rows = results.map((r) => [
      r.id,
      r.metadata?.ground_truth?.requested_coverage_decision ?? "",
+     (r.metadata?.observed_failure_modes ?? []).join("|"),
      r.metadata?.difficulty ?? "",
      r.metadata?.tone ?? "",
      r.metadata?.length_category ?? "",
      r.metadata?.turns ?? "",
      (r.metadata?.parameters?.noise ?? r.metadata?.noise) ?? "",
    ]);
    const csv =
      [headers.join(",")].concat(
        rows.map((r) =>
          r.map((c: any) => `"${String(c).replace(/"/g, '""')}"`).join(",")
        )
      ).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `synthetic_conversations_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const filtered = useMemo(() => {
    return results.filter((r) => {
      if (!r) return false;

      // Coverage (prefer metadata.ground_truth; fallback to labels for older runs)
      if (filters.coverage !== "all") {
        const cov =
          r.metadata?.ground_truth?.requested_coverage_decision ?? "unknown";
        if (cov !== filters.coverage) return false;
      }

      // Failure modes presence (prefer metadata.observed_failure_modes; fallback to labels)
      if (filters.failureMode !== "all") {
        const fms: string[] =
          (Array.isArray(r.metadata?.observed_failure_modes) && r.metadata.observed_failure_modes) ||
          (Array.isArray(r.labels?.failure_modes) && r.labels.failure_modes) ||
          [];
        if (!fms.includes(filters.failureMode)) return false;
      }

      // Difficulty
      if (filters.difficulty !== "all" && r.metadata?.difficulty !== filters.difficulty) return false;

      // Tone
      if (filters.tone !== "all" && r.metadata?.tone !== filters.tone) return false;

      // Length (length_category in metadata)
      if (filters.length !== "all" && r.metadata?.length_category !== filters.length) return false;

      // Noise (metadata.parameters.noise preferred, fallback to metadata.noise)
      if (filters.noise !== "all") {
        const n = (r.metadata?.parameters?.noise ?? r.metadata?.noise);
        if (String(n) !== filters.noise) return false;
      }

      // Turns bucket (derived from metadata.turns)
      if (filters.turnsBucket !== "all") {
        const b = turnsBucket(r.metadata?.turns);
        if (b !== filters.turnsBucket) return false;
      }

      // Search
      if (filters.search) {
        const s = filters.search.toLowerCase();
        const hay = JSON.stringify(r).toLowerCase();
        if (!hay.includes(s)) return false;
      }

      return true;
    });
  }, [results, filters]);

  return (
    <div style={{ maxWidth: 1100, margin: "18px auto", fontFamily: "Inter, system-ui, Arial" }}>
      <h1>Synthetic Conversation Generator</h1>

      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 20 }}>
        <div style={{ padding: 12, border: "1px solid #eee", borderRadius: 8 }}>
          <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
            <label>
              Total samples
              <input
                type="number"
                min={1}
                max={5000}
                value={options.total}
                onChange={(e) => updateOption("total", Number(e.target.value))}
                disabled={generating}
                style={{ width: "100%" }}
              />
            </label>

            <label>
              Covered (ground truth)
              <select
                value={options.covered}
                onChange={(e) => updateOption("covered", e.target.value as CoverageChoice)}
                disabled={generating}
                style={{ width: "100%" }}
              >
                <option value="covered">Covered</option>
                <option value="not_covered">Not Covered</option>
                <option value="edgecase">Edgecase</option>
              </select>
            </label>

            <label>
              Difficulty
              <select
                value={options.difficulty}
                onChange={(e) => updateOption("difficulty", e.target.value as DifficultyChoice)}
                disabled={generating}
                style={{ width: "100%" }}
              >
                <option value="random">Random</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </label>

            <label>
              Conversation length (turns)
              <select
                value={options.turnsMode}
                onChange={(e) => updateOption("turnsMode", e.target.value as TurnsMode)}
                disabled={generating}
                style={{ width: "100%" }}
              >
                <option value="random">Random</option>
                <option value="short">Short (≤6 messages)</option>
                <option value="average">Average (6–10 messages)</option>
                <option value="long">Long (10–20 messages)</option>
              </select>
            </label>

            <label>
              Length (overall)
              <select
                value={options.length}
                onChange={(e) => updateOption("length", e.target.value as LengthChoice)}
                disabled={generating}
                style={{ width: "100%" }}
              >
                <option value="random">Random</option>
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
            </label>

            <label>
              Tone
              <select
                value={options.tone}
                onChange={(e) => updateOption("tone", e.target.value as ToneChoice)}
                disabled={generating}
                style={{ width: "100%" }}
              >
                <option value="random">Random</option>
                <option value="friendly">Friendly</option>
                <option value="professional">Professional</option>
                <option value="neutral">Neutral</option>
                <option value="apologetic">Apologetic</option>
                <option value="assertive">Assertive</option>
                <option value="casual">Casual</option>
                <option value="custom">Custom</option>
              </select>
            </label>

            <label>
              Typos/noise in customer messages
              <input
                type="checkbox"
                checked={!!options.noise}
                onChange={(e) => updateOption("noise", e.target.checked)}
                disabled={generating}
                style={{ marginLeft: 8 }}
              />
            </label>

            <label>
              Live progress (stream)
              <input
                type="checkbox"
                checked={!!options.liveProgress}
                onChange={(e) => updateOption("liveProgress", e.target.checked)}
                disabled={generating}
                style={{ marginLeft: 8 }}
              />
            </label>

            <fieldset style={{ border: "1px solid #ddd", padding: 8 }}>
              <legend style={{ fontSize: 13 }}>Failure modes (probabilities)</legend>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Fraud attempts: {Math.round(options.failureModesConfig.fraudProbability * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={options.failureModesConfig.fraudProbability}
                  onChange={(e) => updateFailureConfig("fraudProbability", Number(e.target.value))}
                  disabled={generating}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Inconsistent statements: {Math.round(options.failureModesConfig.inconsistentProbability * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={options.failureModesConfig.inconsistentProbability}
                  onChange={(e) => updateFailureConfig("inconsistentProbability", Number(e.target.value))}
                  disabled={generating}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Missing info: {Math.round(options.failureModesConfig.missingInfoProbability * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={options.failureModesConfig.missingInfoProbability}
                  onChange={(e) => updateFailureConfig("missingInfoProbability", Number(e.target.value))}
                  disabled={generating}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ display: "block", fontSize: 13 }}>
                Amount anomaly: {Math.round(options.failureModesConfig.amountAnomalyProbability * 100)}%
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={options.failureModesConfig.amountAnomalyProbability}
                  onChange={(e) => updateFailureConfig("amountAnomalyProbability", Number(e.target.value))}
                  disabled={generating}
                  style={{ width: "100%" }}
                />
              </label>
            </fieldset>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={generating} style={{ padding: "8px 12px" }}>
                {generating ? "Generating..." : "Start"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setResults([]);
                  setErrorLog([]);
                  setSelected(null);
                }}
                disabled={generating}
                style={{ padding: "8px 12px" }}
              >
                Clear
              </button>
            </div>
          </form>

          <div style={{ marginTop: 12 }}>
            <strong>Run status</strong>
            <div>Requested: {progress.requested}</div>
            <div>Generated: {progress.generated}</div>
            <div>Errors: {progress.errors}</div>
          </div>

          <div style={{ marginTop: 12 }}>
            <strong>Error log</strong>
            {errorLog && errorLog.length > 0 ? (
              <div style={{ maxHeight: 160, overflow: "auto", background: "#fff6f6", padding: 8, marginTop: 8 }}>
                {errorLog.map((e: any, idx: number) => (
                  <div key={idx} style={{ marginBottom: 8, borderBottom: "1px solid #fee", paddingBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      #{idx + 1} — {e.error ?? e.message ?? "Error"}
                    </div>
                    {e.raw ? (
                      <pre style={{ whiteSpace: "pre-wrap", maxHeight: 80, overflow: "auto", background: "#fff", padding: 6 }}>
                        {String(e.raw).slice(0, 1000)}
                      </pre>
                    ) : null}
                    <div style={{ marginTop: 6 }}>
                      <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(e, null, 2))} style={{ padding: "4px 8px", marginRight: 8 }}>
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ color: "#666", marginTop: 8 }}>No errors.</div>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <button onClick={downloadJSONL} disabled={results.length === 0} style={{ marginRight: 8, padding: "6px 10px" }}>
              Download JSONL
            </button>
            <button onClick={downloadCSV} disabled={results.length === 0} style={{ padding: "6px 10px" }}>
              Download CSV
            </button>
          </div>
        </div>

        <div>
          {/* Search + filters */}
          <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <input
                placeholder="Search..."
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                style={{ width: "100%", padding: 8 }}
              />
            </div>
          </div>

          {/* New: filter row for all input fields */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <select value={filters.coverage} onChange={(e) => setFilters({ ...filters, coverage: e.target.value })}>
              <option value="all">All coverage</option>
              <option value="covered">Covered</option>
              <option value="not_covered">Not covered</option>
              <option value="edgecase">Edgecase</option>
            </select>

            <select value={filters.difficulty} onChange={(e) => setFilters({ ...filters, difficulty: e.target.value })}>
              <option value="all">All difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>

            <select value={filters.tone} onChange={(e) => setFilters({ ...filters, tone: e.target.value })}>
              <option value="all">All tones</option>
              {TONES.map((t) => (
                <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>
              ))}
            </select>

            <select value={filters.length} onChange={(e) => setFilters({ ...filters, length: e.target.value })}>
              <option value="all">All lengths</option>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="long">Long</option>
            </select>

            <select value={filters.noise} onChange={(e) => setFilters({ ...filters, noise: e.target.value })}>
              <option value="all">Noise: all</option>
              <option value="true">Noise: true</option>
              <option value="false">Noise: false</option>
            </select>

            <select value={filters.turnsBucket} onChange={(e) => setFilters({ ...filters, turnsBucket: e.target.value })}>
              <option value="all">All turns</option>
              <option value="short">Short (≤6)</option>
              <option value="average">Average (6–10)</option>
              <option value="long">Long (10–20)</option>
            </select>

            <select value={filters.failureMode} onChange={(e) => setFilters({ ...filters, failureMode: e.target.value })}>
              <option value="all">All failure modes</option>
              <option value="fraud_attempt">fraud_attempt</option>
              <option value="inconsistent_statement">inconsistent_statement</option>
              <option value="missing_info">missing_info</option>
              <option value="amount_anomaly">amount_anomaly</option>
            </select>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, color: "#666" }}>
                No generated conversations. Run generation to populate results.
              </div>
            ) : (
              filtered.map((r: any) => {
                const coverage =
                  r.metadata?.ground_truth?.requested_coverage_decision ??
                  r.labels?.coverage_decision ??
                  "unknown";
                const badgeColor =
                  coverage === "covered" ? "#16a34a" : coverage === "edgecase" ? "#f59e0b" : "#ef4444";
                  const fms = r.metadata?.observed_failure_modes ?? [];
                return (
                  <div
                    key={r.id}
                    style={{
                      border: "1px solid #eee",
                      borderRadius: 8,
                      padding: 12,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong>{r.id}</strong>
                        <span>
                          <Badge text={coverage} color={badgeColor} />
                        </span>
                        <span style={{ color: "#666" }}>
                          {r.metadata?.difficulty ?? ""} • {r.metadata?.tone ?? ""} • {r.metadata?.length_category ?? ""} • {r.metadata?.turns ?? "?"} turns
                        </span>
                      </div>
                      <div style={{ marginTop: 8, color: "#333" }}>{r.summary}</div>
                      <div style={{ marginTop: 8, color: "#555", fontSize: 13 }}>
                        Failure modes: {Array.isArray(fms) && fms.length ? fms.join(", ") : "none"}
                      </div>
                    </div>
                    <div style={{ marginLeft: 12 }}>
                      <button onClick={() => setSelected(r)} style={{ padding: "6px 10px" }}>
                        Open
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2>Selected conversation</h2>

        {selected ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 420px", gap: 12 }}>
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
              {/* Tabs */}
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button
                  onClick={() => setActiveTab("messages")}
                  style={{
                    padding: "6px 10px",
                    background: activeTab === "messages" ? "#0ea5e9" : "#f3f4f6",
                    color: activeTab === "messages" ? "#fff" : "#111",
                    borderRadius: 6,
                  }}
                >
                  Messages
                </button>
                <button
                  onClick={() => setActiveTab("labels")}
                  style={{
                    padding: "6px 10px",
                    background: activeTab === "labels" ? "#0ea5e9" : "#f3f4f6",
                    color: activeTab === "labels" ? "#fff" : "#111",
                    borderRadius: 6,
                  }}
                >
                  Metadata
                </button>
                <button
                  onClick={() => setActiveTab("prompt")}
                  style={{
                    padding: "6px 10px",
                    background: activeTab === "prompt" ? "#0ea5e9" : "#f3f4f6",
                    color: activeTab === "prompt" ? "#fff" : "#111",
                    borderRadius: 6,
                  }}
                >
                  Prompt
                </button>
                <button
                  onClick={() => setActiveTab("raw")}
                  style={{
                    padding: "6px 10px",
                    background: activeTab === "raw" ? "#0ea5e9" : "#f3f4f6",
                    color: activeTab === "raw" ? "#fff" : "#111",
                    borderRadius: 6,
                  }}
                >
                  Raw output
                </button>
              </div>

              {/* Tab content */}
              {activeTab === "messages" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {selected.messages?.map((m: any, idx: number) => (
                    <div key={idx} style={{ display: "flex", justifyContent: m.speaker === "customer" ? "flex-start" : "flex-end" }}>
                      <div
                        style={{
                          maxWidth: "70%",
                          padding: 10,
                          borderRadius: 10,
                          background: m.speaker === "customer" ? "#f3f4f6" : "#0ea5e9",
                          color: m.speaker === "customer" ? "#111" : "#fff",
                        }}
                      >
                        <div style={{ fontSize: 13, marginBottom: 6, opacity: 0.85 }}>{m.speaker}</div>
                        <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "labels" && (
                <div>
                  <h3 style={{ marginTop: 0 }}>Metadata</h3>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                    {JSON.stringify(
                      {
                        metadata: selected.metadata,
                      },
                      null,
                      2
                    )}
                  </pre>
                  <div style={{ marginTop: 8 }}>
                    <button
                      onClick={() => navigator.clipboard?.writeText(JSON.stringify(selected, null, 2))}
                      style={{ padding: "6px 10px", marginRight: 8 }}
                    >
                      Copy JSON
                    </button>
                    <button
                      onClick={() => {
                        const txt = JSON.stringify(selected, null, 2);
                        const blob = new Blob([txt], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${selected.id}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={{ padding: "6px 10px" }}
                    >
                      Download JSON
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "prompt" && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 13, marginRight: 12 }}>
                        <input
                          type="checkbox"
                          checked={redactPolicy}
                          onChange={(e) => setRedactPolicy(e.target.checked)}
                          style={{ marginRight: 8 }}
                        />{" "}
                        Redact policy in view
                      </label>
                    </div>
                    <div>
                      <button
                        onClick={() => navigator.clipboard?.writeText((selected as any)?._prompt ?? "")}
                        style={{ padding: "6px 10px", marginRight: 8 }}
                      >
                        Copy prompt
                      </button>
                      <button
                        onClick={() => {
                          const txt = (selected as any)?._prompt ?? "";
                          const blob = new Blob([txt], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${selected.id}_prompt.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        style={{ padding: "6px 10px" }}
                      >
                        Download prompt
                      </button>
                    </div>
                  </div>

                  <pre style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", background: "#f7f7f7", padding: 12 }}>
                    {(() => {
                      const p = (selected as any)?._prompt ?? "";
                      if (!p) return "No prompt available.";
                      if (!redactPolicy) return p;
                      return p.replace(
                        /Policy \(BEGIN FULL POLICY\)[\s\S]*?Policy \(END FULL POLICY\)/,
                        "Policy (BEGIN FULL POLICY) [policy redacted] Policy (END FULL POLICY)"
                      );
                    })()}
                  </pre>
                </div>
              )}

              {activeTab === "raw" && (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ color: "#666", fontSize: 13 }}>
                      {(selected as any)?._raw_model_output ? "Model raw output (first available)" : "No raw output available."}
                    </div>
                    <div>
                      <button
                        onClick={() => navigator.clipboard?.writeText((selected as any)?._raw_model_output ?? "")}
                        style={{ padding: "6px 10px", marginRight: 8 }}
                      >
                        Copy raw
                      </button>
                      <button
                        onClick={() => {
                          const txt = (selected as any)?._raw_model_output ?? "";
                          const blob = new Blob([txt], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${selected.id}_raw.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        style={{ padding: "6px 10px" }}
                      >
                        Download raw
                      </button>
                    </div>
                  </div>

                  <pre style={{ whiteSpace: "pre-wrap", maxHeight: 420, overflow: "auto", background: "#fff6f6", padding: 12 }}>
                    {(selected as any)?._raw_model_output ?? "No raw output."}
                  </pre>
                </div>
              )}
            </div>

            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
              <h3>Quick metadata & actions</h3>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                {JSON.stringify({ metadata: selected.metadata, labels: selected.labels }, null, 2)}
              </pre>
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(selected, null, 2))}
                  style={{ padding: "6px 10px", marginRight: 8 }}
                >
                  Copy JSON
                </button>
                <button
                  onClick={() => {
                    const txt = JSON.stringify(selected, null, 2);
                    const blob = new Blob([txt], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${selected.id}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  style={{ padding: "6px 10px" }}
                >
                  Download JSON
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: "#666" }}>No conversation selected. Click "Open" on a conversation card to inspect it.</div>
        )}
      </div>

      <section style={{ marginTop: 20, color: "#666" }}>
        <small>
          Note: This UI calls the server-side API which uses the OpenAI API (model gpt-4.1-mini). Set OPENAI_API_KEY in
          server environment (.env.local) before running.
        </small>
      </section>
    </div>
  );
}