import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ScenarioSummary = {
  conversationId: string;
  scenarioId?: string;
  scenarioTitle?: string;
  scenarioLabel?: string;
  groundTruth?: string;
  createdAt?: string;
  filePath: string;
};

type RunSummary = {
  runId: string;
  createdAt?: string;
  scenarioCount: number;
  edgeCaseCount: number;
  entries: ScenarioSummary[];
};

type ApiResponse = {
  runs: RunSummary[];
  warnings?: string[];
};

type DifficultyResult = {
  filePath: string;
  conversationId?: string;
  completion?: string;
  decisionToken?: string;
  decision?: "covered" | "not_covered" | "unknown";
  logProbabilities: {
    covered: number | null;
    notCovered: number | null;
  };
  probabilities: {
    covered: number | null;
    notCovered: number | null;
  };
  error?: string;
  prompt?: string;
};

type DifficultyResponse = {
  model?: string;
  results?: DifficultyResult[];
  warnings?: string[];
};

type GroundTruthFilter = "edge_case" | "covered" | "not_covered" | "all";

const filterOptions: { value: GroundTruthFilter; label: string }[] = [
  { value: "edge_case", label: "Edge case only" },
  { value: "covered", label: "Covered only" },
  { value: "not_covered", label: "Not covered only" },
  { value: "all", label: "Show all" },
];

function matchesGroundTruth(entry: ScenarioSummary, filter: GroundTruthFilter): boolean {
  const truth = entry.groundTruth ?? entry.scenarioLabel ?? "";
  if (!truth) return filter === "all";
  if (filter === "all") return true;
  return truth === filter;
}

function readableTimestamp(value?: string): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

const ImproveScenariosPage: React.FC = () => {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [groundTruthFilter, setGroundTruthFilter] = useState<GroundTruthFilter>("edge_case");
  const [selectedByRun, setSelectedByRun] = useState<Record<string, string[]>>({});
  const [apiKey, setApiKey] = useState<string>("");
  const [scoringModel, setScoringModel] = useState<string>("gpt-4.1-mini");
  const [checking, setChecking] = useState<boolean>(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<DifficultyResult[]>([]);
  const [checkWarnings, setCheckWarnings] = useState<string[]>([]);
  const [lastCheckedModel, setLastCheckedModel] = useState<string | null>(null);

  const matchEdgeCase = useCallback((entry: ScenarioSummary) => {
    const label = entry.groundTruth ?? entry.scenarioLabel;
    return label === "edge_case";
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadRuns = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/improve-scenarios");
        if (!response.ok) {
          throw new Error(`Failed to load scenarios (${response.status})`);
        }
        const data: ApiResponse = await response.json();
        if (cancelled) return;
        const availableRuns = data.runs ?? [];
        setRuns(availableRuns);
        setWarnings(data.warnings ?? []);
        if (availableRuns.length > 0) {
          const mostRecent = availableRuns[0];
          setSelectedRunId((prev) => prev ?? mostRecent.runId);
          setSelectedByRun((prev) => {
            if (prev[mostRecent.runId]) return prev;
            const defaultSelections = mostRecent.entries
              .filter((entry) => matchEdgeCase(entry))
              .map((entry) => entry.filePath);
            return {
              ...prev,
              [mostRecent.runId]: defaultSelections,
            };
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadRuns();

    return () => {
      cancelled = true;
    };
  }, [matchEdgeCase]);

  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  useEffect(() => {
    setCheckResults([]);
    setCheckWarnings([]);
    setLastCheckedModel(null);
    setCheckError(null);
  }, [selectedRunId]);

  const currentRun = useMemo(() => runs.find((run) => run.runId === selectedRunId) ?? null, [runs, selectedRunId]);

  const currentSelections = useMemo(() => {
    if (!selectedRunId) return [];
    return selectedByRun[selectedRunId] ?? [];
  }, [selectedByRun, selectedRunId]);

  const visibleEntries = useMemo(() => {
    if (!currentRun) return [];
    return currentRun.entries.filter((entry) => matchesGroundTruth(entry, groundTruthFilter));
  }, [currentRun, groundTruthFilter]);

  const allVisibleSelected = useMemo(() => {
    if (visibleEntries.length === 0) return false;
    return visibleEntries.every((entry) => currentSelections.includes(entry.filePath));
  }, [visibleEntries, currentSelections]);

  const toggleSelection = useCallback(
    (filePath: string) => {
      if (!selectedRunId) return;
      setSelectedByRun((prev) => {
        const existing = new Set(prev[selectedRunId] ?? []);
        if (existing.has(filePath)) {
          existing.delete(filePath);
        } else {
          existing.add(filePath);
        }
        return {
          ...prev,
          [selectedRunId]: Array.from(existing),
        };
      });
    },
    [selectedRunId]
  );

  const toggleAllVisible = useCallback(() => {
    if (!selectedRunId || !currentRun) return;
    const visiblePaths = visibleEntries.map((entry) => entry.filePath);
    setSelectedByRun((prev) => {
      const existing = new Set(prev[selectedRunId] ?? []);
      const allSelected = visiblePaths.every((path) => existing.has(path));
      if (allSelected) {
        visiblePaths.forEach((path) => existing.delete(path));
      } else {
        visiblePaths.forEach((path) => existing.add(path));
      }
      return {
        ...prev,
        [selectedRunId]: Array.from(existing),
      };
    });
  }, [currentRun, selectedRunId, visibleEntries]);

  const handleRunChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const nextRunId = event.target.value;
      setSelectedRunId(nextRunId);
      setSelectedByRun((prev) => {
        if (prev[nextRunId]) return prev;
        const run = runs.find((item) => item.runId === nextRunId);
        if (!run) return prev;
        const defaults = run.entries.filter(matchEdgeCase).map((entry) => entry.filePath);
        return {
          ...prev,
          [nextRunId]: defaults,
        };
      });
    },
    [runs, matchEdgeCase]
  );

  const handleCheckDifficulty = useCallback(async () => {
    if (currentSelections.length === 0) {
      setCheckError("Select at least one scenario to evaluate.");
      return;
    }
    if (!apiKey.trim()) {
      setCheckError("Provide an OpenAI API key.");
      return;
    }
    if (!scoringModel.trim()) {
      setCheckError("Provide a scoring model.");
      return;
    }

    setChecking(true);
    setCheckError(null);
    try {
      const response = await fetch("/api/improve-scenarios/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePaths: currentSelections, apiKey: apiKey.trim(), model: scoringModel.trim() }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Request failed (${response.status})`);
      }
      const data: DifficultyResponse = await response.json();
      setCheckResults(data.results ?? []);
      setCheckWarnings(data.warnings ?? []);
      setLastCheckedModel(data.model ?? scoringModel.trim() ?? null);
    } catch (err: any) {
      setCheckError(err?.message ?? "Unknown error");
    } finally {
      setChecking(false);
    }
  }, [apiKey, currentSelections, scoringModel]);

  const formatLogProbability = useCallback((value: number | null) => {
    if (value === null || Number.isNaN(value)) return "—";
    return value.toFixed(4);
  }, []);

  const formatProbability = useCallback((value: number | null) => {
    if (value === null || Number.isNaN(value)) return "—";
    return (value * 100).toFixed(2) + "%";
  }, []);

  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "2rem 1.5rem" }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 600, marginBottom: "0.5rem" }}>Improve Scenario Difficulty</h1>
        <p style={{ margin: 0 }}>
          Select edge case scenarios to refine. The default selection includes edge cases from the most recent UI run.
        </p>
        <p style={{ marginTop: "0.5rem" }}>
          <Link href="/generation_pipeline">Return to generation pipeline</Link>
        </p>
      </header>

      {loading && <p>Loading scenario history…</p>}
      {error && <p style={{ color: "#c00" }}>{error}</p>}

      {!loading && runs.length === 0 && !error && <p>No generated scenarios were found yet.</p>}

      {!loading && currentRun && (
        <section>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
            <label style={{ display: "flex", flexDirection: "column", minWidth: "220px" }}>
              <span style={{ fontWeight: 500, marginBottom: "0.25rem" }}>UI run</span>
              <select value={selectedRunId ?? ""} onChange={handleRunChange} style={{ padding: "0.5rem" }}>
                {runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId} ({run.scenarioCount} scenarios)
                  </option>
                ))}
              </select>
              <small style={{ color: "#555", marginTop: "0.25rem" }}>
                Created {readableTimestamp(currentRun.createdAt)} · Edge cases: {currentRun.edgeCaseCount}
              </small>
            </label>

            <label style={{ display: "flex", flexDirection: "column", minWidth: "200px" }}>
              <span style={{ fontWeight: 500, marginBottom: "0.25rem" }}>Ground truth filter</span>
              <select value={groundTruthFilter} onChange={(event) => setGroundTruthFilter(event.target.value as GroundTruthFilter)} style={{ padding: "0.5rem" }}>
                {filterOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", minWidth: "260px", flex: "1 1 260px" }}>
              <span style={{ fontWeight: 500, marginBottom: "0.25rem" }}>OpenAI API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                style={{ padding: "0.5rem" }}
                autoComplete="off"
              />
              <small style={{ color: "#555", marginTop: "0.25rem" }}>Required to evaluate difficulty.</small>
            </label>

            <label style={{ display: "flex", flexDirection: "column", minWidth: "220px", flex: "1 1 220px" }}>
              <span style={{ fontWeight: 500, marginBottom: "0.25rem" }}>Scoring model</span>
              <input
                type="text"
                value={scoringModel}
                onChange={(event) => setScoringModel(event.target.value)}
                list="scoring-model-options"
                style={{ padding: "0.5rem" }}
              />
              <datalist id="scoring-model-options">
                <option value="gpt-4.1-mini" />
                <option value="gpt-4.1" />
                <option value="gpt-4.1-turbo" />
                <option value="o4-mini" />
              </datalist>
              <small style={{ color: "#555", marginTop: "0.25rem" }}>Defaults to gpt-4.1-mini; override as needed.</small>
            </label>
          </div>

          <div style={{ marginBottom: "0.75rem" }}>
            <strong>Visible:</strong> {visibleEntries.length} · <strong>Selected:</strong> {currentSelections.length}
            <button type="button" onClick={toggleAllVisible} style={{ marginLeft: "1rem", padding: "0.35rem 0.75rem" }}>
              {allVisibleSelected ? "Unselect visible" : "Select visible"}
            </button>
            <button
              type="button"
              onClick={handleCheckDifficulty}
              disabled={checking || currentSelections.length === 0}
              style={{ marginLeft: "0.75rem", padding: "0.35rem 0.75rem" }}
            >
              {checking ? "Checking…" : "Check edge case difficulty"}
            </button>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: "6px", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ background: "#f7f7f7" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.5rem", width: "48px" }}>
                    <input
                      type="checkbox"
                      aria-label="Toggle all visible"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                    />
                  </th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Scenario</th>
                  <th style={{ textAlign: "left", padding: "0.5rem", width: "140px" }}>Ground truth</th>
                  <th style={{ textAlign: "left", padding: "0.5rem", width: "160px" }}>Conversation ID</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((entry) => {
                  const selected = currentSelections.includes(entry.filePath);
                  return (
                    <tr key={entry.filePath} style={{ borderTop: "1px solid #eee" }}>
                      <td style={{ padding: "0.5rem" }}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelection(entry.filePath)}
                          aria-label={`Select scenario ${entry.scenarioTitle ?? entry.conversationId}`}
                        />
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        <div style={{ fontWeight: 500 }}>{entry.scenarioTitle ?? "Untitled scenario"}</div>
                        <div style={{ fontSize: "0.85rem", color: "#555" }}>{entry.filePath}</div>
                      </td>
                      <td style={{ padding: "0.5rem" }}>{entry.groundTruth ?? entry.scenarioLabel ?? "unknown"}</td>
                      <td style={{ padding: "0.5rem" }}>{entry.conversationId}</td>
                    </tr>
                  );
                })}
                {visibleEntries.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ padding: "1rem", textAlign: "center", color: "#666" }}>
                      No scenarios match the current filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <aside style={{ marginTop: "1rem", color: "#555" }}>
            <p style={{ marginBottom: "0.5rem" }}>
              Selected file references will be sent to the backend in a follow-up step to increase difficulty.
            </p>
            {currentSelections.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer" }}>Selected file paths ({currentSelections.length})</summary>
                <ul style={{ marginTop: "0.5rem" }}>
                  {currentSelections.map((path) => (
                    <li key={path} style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                      {path}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </aside>

          {checkError && <p style={{ color: "#c00", marginTop: "1rem" }}>{checkError}</p>}

          {checkResults.length > 0 && (
            <section style={{ marginTop: "2rem" }}>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
                Edge case difficulty results {lastCheckedModel ? `(model: ${lastCheckedModel})` : ""}
              </h2>
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
                <thead style={{ background: "#f7f7f7" }}>
                  <tr>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "160px" }}>Conversation ID</th>
                    <th style={{ textAlign: "left", padding: "0.5rem" }}>File</th>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "120px" }}>Decision</th>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "160px" }}>Log P (covered)</th>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "160px" }}>Log P (not covered)</th>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "140px" }}>P (covered)</th>
                    <th style={{ textAlign: "left", padding: "0.5rem", width: "160px" }}>P (not covered)</th>
                  </tr>
                </thead>
                <tbody>
                  {checkResults.map((result) => (
                    <tr key={result.filePath} style={{ borderTop: "1px solid #eee" }}>
                      <td style={{ padding: "0.5rem" }}>{result.conversationId ?? "—"}</td>
                      <td style={{ padding: "0.5rem", fontSize: "0.9rem" }}>{result.filePath}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {result.error ? (
                          <span style={{ color: "#c00" }}>Error</span>
                        ) : (
                          <span>
                            {result.decision === "covered"
                              ? "Covered"
                              : result.decision === "not_covered"
                              ? "Not covered"
                              : "Unknown"}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "0.5rem" }}>{formatLogProbability(result.logProbabilities.covered)}</td>
                      <td style={{ padding: "0.5rem" }}>{formatLogProbability(result.logProbabilities.notCovered)}</td>
                      <td style={{ padding: "0.5rem" }}>{formatProbability(result.probabilities.covered)}</td>
                      <td style={{ padding: "0.5rem" }}>{formatProbability(result.probabilities.notCovered)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {checkResults.some((result) => result.completion) && (
                <details style={{ marginTop: "1rem" }}>
                  <summary style={{ cursor: "pointer" }}>Show raw model outputs</summary>
                  <ul style={{ marginTop: "0.5rem" }}>
                    {checkResults.map((result) => (
                      <li key={`${result.filePath}-raw`} style={{ marginBottom: "0.75rem" }}>
                        <div style={{ fontWeight: 500 }}>{result.conversationId ?? result.filePath}</div>
                        {result.error ? (
                          <div style={{ color: "#c00" }}>{result.error}</div>
                        ) : (
                          <pre style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", padding: "0.5rem", borderRadius: "4px" }}>
                            {result.completion}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {checkResults.some((result) => result.prompt) && (
                <details style={{ marginTop: "1rem" }}>
                  <summary style={{ cursor: "pointer" }}>Show model prompts</summary>
                  <ul style={{ marginTop: "0.5rem" }}>
                    {checkResults.map((result) => (
                      <li key={`${result.filePath}-prompt`} style={{ marginBottom: "0.75rem" }}>
                        <div style={{ fontWeight: 500 }}>{result.conversationId ?? result.filePath}</div>
                        <pre style={{ whiteSpace: "pre-wrap", background: "#f0f0f0", padding: "0.5rem", borderRadius: "4px" }}>
                          {result.prompt ?? "Prompt unavailable"}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {checkWarnings.length > 0 && (
                <div style={{ marginTop: "1rem" }}>
                  <strong>Warnings:</strong>
                  <ul>
                    {checkWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </section>
      )}

      {!loading && warnings.length > 0 && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Warnings</h2>
          <ul>
            {warnings.map((warning) => (
              <li key={warning} style={{ color: "#a15c00" }}>
                {warning}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
};

export default ImproveScenariosPage;
