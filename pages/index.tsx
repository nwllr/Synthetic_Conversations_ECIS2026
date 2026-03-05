import Link from "next/link";

export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 920,
        margin: "48px auto",
        padding: "0 20px",
        fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
      }}
    >
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ margin: 0, fontSize: 34 }}>Synthetic Conversation Testing Artifact</h1>
        <p style={{ marginTop: 10, color: "#475569", lineHeight: 1.5 }}>
          Choose the workflow you want to run. The canonical interfaces for this paper artifact are scenario generation and scenario improvement.
        </p>
      </header>

      <section style={{ display: "grid", gap: 14 }}>
        <Link
          href="/generation_pipeline"
          style={{
            display: "block",
            border: "1px solid #cbd5e1",
            borderRadius: 12,
            padding: 18,
            textDecoration: "none",
            color: "#0f172a",
            background: "#f8fafc",
          }}
        >
          <h2 style={{ margin: "0 0 8px 0", fontSize: 22 }}>Scenario Generation</h2>
          <p style={{ margin: 0, color: "#334155" }}>
            Generate scenarios and conversations, inspect outputs, and review semantic coverage.
          </p>
        </Link>

        <Link
          href="/improve-scenarios"
          style={{
            display: "block",
            border: "1px solid #cbd5e1",
            borderRadius: 12,
            padding: 18,
            textDecoration: "none",
            color: "#0f172a",
            background: "#f8fafc",
          }}
        >
          <h2 style={{ margin: "0 0 8px 0", fontSize: 22 }}>Scenario Improvement</h2>
          <p style={{ margin: 0, color: "#334155" }}>
            Score edge-case difficulty, iteratively rewrite scenarios, and simulate improved conversations.
          </p>
        </Link>
      </section>

      <section style={{ marginTop: 22, color: "#64748b", fontSize: 14 }}>
        Legacy endpoints and pages are preserved with a <code>deprecated_</code> prefix for compatibility.
      </section>
    </main>
  );
}
