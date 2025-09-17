import React, { useState, useMemo } from "react";

type GenerateOptions = {
  total: number;
  covered: "true" | "false" | "random";
  difficulty: "easy" | "medium" | "hard";
  turns: number;
  length: "short" | "medium" | "long";
  tone: string;
  noise: boolean;
  batchSize: number;
  seed?: number | null;
  failureModesConfig: {
    fraudProbability: number;
    inconsistentProbability: number;
    missingInfoProbability: number;
    amountAnomalyProbability: number;
  };
  claimAmountOverride?: number | null;
};

type Conversation = any; // kept loose for UI

function Badge({ text, color }: { text: string; color?: string }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "4px 8px",
      borderRadius: 12,
      background: color ?? "#eee",
      color: color ? "#fff" : "#333",
      fontSize: 12,
      marginRight: 6
    }}>{text}</span>
  );
}

export default function HomePage() {
  const [options, setOptions] = useState<GenerateOptions>({
    total: 10,
    covered: "random",
    difficulty: "medium",
    turns: 6,
    length: "short",
    tone: "friendly",
    noise: false,
    batchSize: 1,
    seed: null,
    failureModesConfig: {
      fraudProbability: 0.2,
      inconsistentProbability: 0.1,
      missingInfoProbability: 0.2,
      amountAnomalyProbability: 0.1,
    },
    claimAmountOverride: null,
  });

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ requested: 0, generated: 0, errors: 0 });
  const [results, setResults] = useState<Conversation[]>([]);
  const [errorLog, setErrorLog] = useState<any[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [filters, setFilters] = useState({ coverage: "all", failureMode: "all", difficulty: "all", search: "" });

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

    try {
      const body: any = {
        total: Number(options.total),
        covered: options.covered === "random" ? "random" : options.covered === "true",
        difficulty: options.difficulty,
        turns: Number(options.turns),
        tone: options.tone,
        length: options.length,
        noise: options.noise,
        batchSize: Number(options.batchSize),
        failureModesConfig: options.failureModesConfig,
      };
      if (options.seed) body.seed = Number(options.seed);
      if (typeof options.claimAmountOverride === "number") body.claimAmountOverride = options.claimAmountOverride;

      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Server returned ${resp.status}: ${text}`);
      }

      const data = await resp.json();
      setProgress({ requested: data.requested ?? body.total, generated: data.generated ?? 0, errors: (data.errors ?? []).length });
      setResults(data.results ?? []);
      setErrorLog(data.errors ?? []);
    } catch (err: any) {
      setErrorLog((prev) => [...prev, { fatal: true, message: String(err) }]);
    } finally {
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
    const headers = ["id", "coverage_decision", "reason", "claim_amount_estimate", "failure_modes", "difficulty", "tone"];
    const rows = results.map((r) => [
      r.id,
      r.labels?.coverage_decision ?? "",
      (r.labels?.reason ?? "").replace(/[\n\r]+/g, " "),
      r.labels?.claim_amount_estimate ?? "",
      (r.labels?.failure_modes ?? []).join("|"),
      r.metadata?.difficulty ?? "",
      r.metadata?.tone ?? "",
    ]);
    const csv = [headers.join(",")].concat(rows.map(r => r.map((c:any)=> `"${String(c).replace(/"/g,'""')}"`).join(","))).join("\n");
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
      if (filters.coverage !== "all") {
        if ((r.labels?.coverage_decision ?? "unknown") !== filters.coverage) return false;
      }
      if (filters.failureMode !== "all") {
        if (!Array.isArray(r.labels?.failure_modes) || !r.labels.failure_modes.includes(filters.failureMode)) return false;
      }
      if (filters.difficulty !== "all" && r.metadata?.difficulty !== filters.difficulty) return false;
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
              <input type="number" min={1} max={5000} value={options.total} onChange={(e) => updateOption("total", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
            </label>

            <label>
              Covered (ground truth)
              <select value={options.covered} onChange={(e) => updateOption("covered", e.target.value as any)} disabled={generating} style={{ width: "100%" }}>
                <option value="random">Random</option>
                <option value="true">Covered (prefer)</option>
                <option value="false">Not covered (prefer)</option>
              </select>
            </label>

            <label>
              Difficulty
              <select value={options.difficulty} onChange={(e) => updateOption("difficulty", e.target.value as any)} disabled={generating} style={{ width: "100%" }}>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </label>

            <label>
              Turns per conversation
              <input type="number" min={2} max={50} value={options.turns} onChange={(e) => updateOption("turns", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
            </label>

            <label>
              Tone
              <input type="text" value={options.tone} onChange={(e) => updateOption("tone", e.target.value)} disabled={generating} style={{ width: "100%" }} />
            </label>

            <label>
              Noise (typos)
              <input type="checkbox" checked={options.noise} onChange={(e) => updateOption("noise", e.target.checked)} disabled={generating} style={{ marginLeft: 8 }} />
            </label>

            <fieldset style={{ border: "1px solid #ddd", padding: 8 }}>
              <legend style={{ fontSize: 13 }}>Failure modes (probabilities)</legend>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Fraud attempts: {Math.round(options.failureModesConfig.fraudProbability * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={options.failureModesConfig.fraudProbability} onChange={(e) => updateFailureConfig("fraudProbability", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Inconsistent statements: {Math.round(options.failureModesConfig.inconsistentProbability * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={options.failureModesConfig.inconsistentProbability} onChange={(e) => updateFailureConfig("inconsistentProbability", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
                Missing info: {Math.round(options.failureModesConfig.missingInfoProbability * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={options.failureModesConfig.missingInfoProbability} onChange={(e) => updateFailureConfig("missingInfoProbability", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "block", fontSize: 13 }}>
                Amount anomaly: {Math.round(options.failureModesConfig.amountAnomalyProbability * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={options.failureModesConfig.amountAnomalyProbability} onChange={(e) => updateFailureConfig("amountAnomalyProbability", Number(e.target.value))} disabled={generating} style={{ width: "100%" }} />
              </label>
            </fieldset>

            <label>
              Seed (optional for reproducibility)
              <input type="number" value={options.seed ?? ""} onChange={(e) => updateOption("seed", e.target.value ? Number(e.target.value) : null)} disabled={generating} style={{ width: "100%" }} />
            </label>

            <label>
              Claim amount override (optional)
              <input type="number" value={options.claimAmountOverride ?? ""} onChange={(e) => updateOption("claimAmountOverride", e.target.value ? Number(e.target.value) : null)} disabled={generating} style={{ width: "100%" }} />
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" onClick={() => submit()} disabled={generating} style={{ padding: "8px 12px" }}>
                {generating ? "Generating..." : "Start"}
              </button>
              <button type="button" onClick={() => { setResults([]); setErrorLog([]); setSelected(null); }} disabled={generating} style={{ padding: "8px 12px" }}>
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
            <button onClick={downloadJSONL} disabled={results.length === 0} style={{ marginRight: 8, padding: "6px 10px" }}>Download JSONL</button>
            <button onClick={downloadCSV} disabled={results.length === 0} style={{ padding: "6px 10px" }}>Download CSV</button>
          </div>
        </div>

        <div>
          <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <input placeholder="Search..." value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} style={{ width: "100%", padding: 8 }} />
            </div>

            <select value={filters.coverage} onChange={(e) => setFilters({ ...filters, coverage: e.target.value })}>
              <option value="all">All coverage</option>
              <option value="covered">Covered</option>
              <option value="not_covered">Not covered</option>
              <option value="edgecase">Edgecase</option>
            </select>

            <select value={filters.failureMode} onChange={(e) => setFilters({ ...filters, failureMode: e.target.value })}>
              <option value="all">All failure modes</option>
              <option value="fraud_attempt">fraud_attempt</option>
              <option value="inconsistent_statement">inconsistent_statement</option>
              <option value="missing_info">missing_info</option>
              <option value="amount_anomaly">amount_anomaly</option>
            </select>

            <select value={filters.difficulty} onChange={(e) => setFilters({ ...filters, difficulty: e.target.value })}>
              <option value="all">All difficulties</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, color: "#666" }}>No generated conversations. Run generation to populate results.</div>
            ) : (
              filtered.map((r: any) => {
                const coverage = r.labels?.coverage_decision ?? "unknown";
                const badgeColor = coverage === "covered" ? "#16a34a" : coverage === "edgecase" ? "#f59e0b" : "#ef4444";
                return (
                  <div key={r.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong>{r.id}</strong>
                        <span><Badge text={coverage} color={badgeColor} /></span>
                        <span style={{ color: "#666" }}>{r.metadata?.difficulty ?? ""} • {r.metadata?.tone ?? ""}</span>
                      </div>
                      <div style={{ marginTop: 8, color: "#333" }}>{r.summary}</div>
                      <div style={{ marginTop: 8, color: "#555", fontSize: 13 }}>
                        Failure modes: {(r.labels?.failure_modes ?? []).join(", ") || "none"} • Claim est: {r.labels?.claim_amount_estimate ?? "—"}
                      </div>
                    </div>
                    <div style={{ marginLeft: 12 }}>
                      <button onClick={() => setSelected(r)} style={{ padding: "6px 10px" }}>Open</button>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12 }}>
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {selected.messages?.map((m: any, idx: number) => (
                  <div key={idx} style={{ display: "flex", justifyContent: m.speaker === "customer" ? "flex-start" : "flex-end" }}>
                    <div style={{
                      maxWidth: "70%",
                      padding: 10,
                      borderRadius: 10,
                      background: m.speaker === "customer" ? "#f3f4f6" : "#0ea5e9",
                      color: m.speaker === "customer" ? "#111" : "#fff"
                    }}>
                      <div style={{ fontSize: 13, marginBottom: 6, opacity: 0.85 }}>{m.speaker}</div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
              <h3>Labels & metadata</h3>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{JSON.stringify({ metadata: selected.metadata, labels: selected.labels }, null, 2)}</pre>
              <div style={{ marginTop: 8 }}>
                <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(selected, null, 2) )} style={{ padding: "6px 10px", marginRight: 8 }}>Copy JSON</button>
                <button onClick={() => { const txt = JSON.stringify(selected, null, 2); const blob = new Blob([txt], {type: "application/json"}); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${selected.id}.json`; a.click(); URL.revokeObjectURL(url); }} style={{ padding: "6px 10px" }}>Download JSON</button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: "#666" }}>No conversation selected. Click "Open" on a conversation card to inspect it.</div>
        )}
      </div>

      <section style={{ marginTop: 20, color: "#666" }}>
        <small>Note: This UI calls the server-side API which uses the OpenAI API (model gpt-4.1-mini). Set OPENAI_API_KEY in server environment (.env.local) before running.</small>
      </section>
    </div>
  );
}
