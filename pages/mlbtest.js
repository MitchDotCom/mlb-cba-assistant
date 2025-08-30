// pages/mlbtest.js
import { useState } from "react";

export default function MLBTest() {
  const [q, setQ] = useState("How is AAV calculated for CBT purposes?");
  const [out, setOut] = useState("");

  async function ask() {
    setOut("Loading…");
    const r = await fetch("/api/mlb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q })
    });
    const j = await r.json();
    setOut(j.text || JSON.stringify(j, null, 2));
  }

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>MLB CBA Assistant — Verification Test</h1>
      <p>Ask something, then scroll for the Verification block with PDF page links + quotes.</p>
      <textarea
        rows={3}
        style={{ width: "100%", padding: 10, fontSize: 16 }}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div style={{ marginTop: 10 }}>
        <button onClick={ask} style={{ padding: "8px 14px", fontSize: 16 }}>Ask</button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", marginTop: 20 }}>{out}</pre>
    </div>
  );
}
