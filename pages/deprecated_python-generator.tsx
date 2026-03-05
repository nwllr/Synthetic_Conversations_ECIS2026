import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type FormState = {
  count: string;
  scenarioId: string;
  personaIndex: string;
  model: string;
  temperature: string;
  maxTokens: string;
  maxTurns: string;
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
};

type GeneratorEvent =
  | { type: "start"; data: { runId: string; outputDir: string; total: number } }
  | { type: "progress"; data: ProgressState }
  | { type: "item"; data: { index: number; conversation: ConversationRecord } }
  | { type: "log"; data: { stream?: "stdout" | "stderr"; message?: string } }
  | { type: "error"; data: WarningEntry }
  | { type: "done"; data: { runId: string; outputDir: string; total: number; generated: number; errors: number; stdout?: string; stderr?: string; conversations?: ConversationRecord[] } }
  | { type: "fatal"; data: FatalPayload };

const initialForm: FormState = {
  count: "1",
  scenarioId: "",
  personaIndex: "",
  model: "gpt-4.1-mini",
  temperature: "0.7",
  maxTokens: "400",
  maxTurns: "20",
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

export default function PythonGeneratorPage() {
  const [form, setForm] = useState<FormState>({ ...initialForm });
  const [loading, setLoading] = useState(false);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [progress, setProgress] = useState<ProgressState>({ total: 0, generated: 0, errors: 0 });
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
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

    const countValue = Math.max(1, Math.floor(parseNumber(form.count) ?? 1));

    setLoading(true);
    setRunInfo(null);
    setProgress({ total: countValue, generated: 0, errors: 0 });
    setConversations([]);
    setSelectedIndex(null);
    setLogs([]);
    setWarnings([]);
    setDonePayload(null);
    setError(null);
    setFatalDetail(null);

    const payload = {
      count: countValue,
      scenarioId: form.scenarioId.trim() || undefined,
      personaIndex: parseNumber(form.personaIndex),
      model: form.model.trim() || undefined,
      temperature: parseNumber(form.temperature),
      maxTokens: parseNumber(form.maxTokens),
      maxTurns: parseNumber(form.maxTurns),
      seed: parseNumber(form.seed),
    };

    try {
      const resp = await fetch("/api/deprecated_python-generator", {
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

          if (!["start", "progress", "item", "log", "error", "done", "fatal"].includes(eventName)) {
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
              setProgress({ total: eventData.total, generated: 0, errors: 0 });
              break;
            case "progress":
              setProgress((prev) => ({
                total: typeof (eventData as ProgressState)?.total === "number" ? (eventData as ProgressState).total : prev.total,
                generated: typeof (eventData as ProgressState)?.generated === "number" ? (eventData as ProgressState).generated : prev.generated,
                errors: typeof (eventData as ProgressState)?.errors === "number" ? (eventData as ProgressState).errors : prev.errors,
              }));
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
              setProgress({
                total: (eventData as any).total,
                generated: (eventData as any).generated,
                errors: (eventData as any).errors,
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
              setProgress((prev) => ({
                total: typeof (eventData as any)?.total === "number" ? (eventData as any).total : prev.total,
                generated: typeof (eventData as any)?.generated === "number" ? (eventData as any).generated : prev.generated,
                errors: typeof (eventData as any)?.errors === "number" ? (eventData as any).errors : prev.errors,
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

  const conversationCount = conversations.length;
  const progressPercent = progress.total > 0 ? Math.min(100, Math.round((progress.generated / progress.total) * 100)) : 0;

  return (
    <div style={{ maxWidth: 1100, margin: "32px auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Python Conversation Generator</h1>
        <p style={{ margin: "8px 0 0", color: "#475569" }}>
          Trigger the existing Python script from a dedicated page. The original UI remains at <Link href="/">/</Link>.
        </p>
        <p style={{ margin: "8px 0 0", color: "#475569" }}>
          Legacy/experimental page. Use <Link href="/generation_pipeline">/generation_pipeline</Link> as the canonical interface.
        </p>
      </header>

      <section style={{ padding: 24, border: "1px solid #e2e8f0", borderRadius: 12, marginBottom: 24 }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Count</span>
              <input
                type="number"
                min={1}
                value={form.count}
                onChange={(e) => updateField("count", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Scenario ID (optional)</span>
              <input
                type="text"
                value={form.scenarioId}
                onChange={(e) => updateField("scenarioId", e.target.value)}
                placeholder="e.g. COV-01"
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Persona Index (optional)</span>
              <input
                type="number"
                value={form.personaIndex}
                onChange={(e) => updateField("personaIndex", e.target.value)}
                placeholder="0-based index"
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Model</span>
              <input
                type="text"
                value={form.model}
                onChange={(e) => updateField("model", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Temperature</span>
              <input
                type="number"
                step="0.1"
                value={form.temperature}
                onChange={(e) => updateField("temperature", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Max Tokens</span>
              <input
                type="number"
                value={form.maxTokens}
                onChange={(e) => updateField("maxTokens", e.target.value)}
                style={{ marginTop: 6, padding: 8 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: 14 }}>
              <span>Max Turns</span>
              <input
                type="number"
                value={form.maxTurns}
                onChange={(e) => updateField("maxTurns", e.target.value)}
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
              {loading ? "Running…" : "Run Python Script"}
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
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
              <div style={{ flex: 1, height: 10, background: "#e2e8f0", borderRadius: 999 }}>
                <div
                  style={{
                    width: `${progressPercent}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: "#0ea5e9",
                    transition: "width 0.2s ease",
                  }}
                />
              </div>
              <div style={{ fontSize: 12, color: "#475569" }}>
                {progress.generated} / {progress.total}
              </div>
              <div style={{ fontSize: 12, color: "#dc2626" }}>Errors: {progress.errors}</div>
            </div>
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
    </div>
  );
}
