// pages/embed.js
import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// very small autolink for raw URLs in plain text
function linkify(text) {
  const urlRE = /(https?:\/\/[^\s)]+)(?![^[]*\])/g; // don't touch existing markdown links
  return text.replace(urlRE, (m) => `[${m}](${m})`);
}

export default function Embed() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function ask(e) {
    e?.preventDefault();
    setLoading(true);
    setErr("");
    setAnswer("");
    try {
      const r = await fetch("/api/mlb", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: q || "How is AAV calculated for CBT purposes?" })
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      setAnswer(j.text || "");
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  const md = useMemo(() => linkify(answer || ""), [answer]);

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui", padding: 16, maxWidth: 1000, margin: "0 auto" }}>
      <form onSubmit={ask} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask an MLB CBA question…"
          style={{ flex: 1, padding: 10, fontSize: 16 }}
        />
        <button disabled={loading} style={{ padding: "10px 14px", fontSize: 16 }}>
          {loading ? "Loading…" : "Ask"}
        </button>
      </form>

      {err && <div style={{ color: "#b00020", marginBottom: 8 }}>Error: {err}</div>}

      <div style={{ lineHeight: 1.5, fontSize: 16 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} linkTarget="_blank">
          {md}
        </ReactMarkdown>
      </div>
    </div>
  );
}
