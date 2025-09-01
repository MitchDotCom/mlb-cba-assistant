// /pages/api/chat.js
// Minimal, robust Assistants v2 call -> returns { result }.
// We DO NOT trust page numbers from OpenAI. We post-process with linkifyCitations().

import { linkifyCitations } from "../../lib/linkifyCitations";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const assistant_id = process.env.OPENAI_ASSISTANT_ID || "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // Safe body parse
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const { messages = [] } = body || {};
    const safeMessages = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: "Help me understand a rule in the MLB CBA." }];

    // Helper for OpenAI fetch
    const callOpenAI = async (url, init) => {
      const r = await fetch(url, {
        ...init,
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
          ...(init && init.headers),
        },
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`OpenAI ${r.status} ${r.statusText} — ${t.slice(0, 1000)}`);
      }
      return r.json();
    };

    // 1) Thread
    const thread = await callOpenAI("https://api.openai.com/v1/threads", { method: "POST", body: JSON.stringify({}) });
    const threadId = thread.id;

    // 2) Add user messages
    for (const m of safeMessages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role, content }),
      });
    }

    // 3) Run assistant
    const run = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id }),
    });

    // 4) Poll
    async function waitForRun(runId) {
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const st = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { method: "GET" });
        if (st.status === "completed") return;
        if (["failed", "cancelled", "expired"].includes(st.status)) {
          throw new Error(`Run ${st.status}: ${st.last_error?.message || "no details"}`);
        }
      }
      throw new Error("Run timed out.");
    }
    await waitForRun(run.id);

    // 5) Read newest assistant message
    const list = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=30`, {
      method: "GET",
    });

    let raw = "";
    for (const msg of list.data || []) {
      if (msg.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;
      const parts = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text?.value) parts.push(c.text.value);
        if (c.type === "output_text" && c.output_text?.value) parts.push(c.output_text.value);
      }
      const joined = parts.join("\n").trim();
      if (joined) { raw = joined; break; }
    }
    if (!raw) raw = "No response from assistant.";

    // 6) Re-wire Citation lines to your real PDF pages using page_map.json
    const result = await linkifyCitations(raw);

    return res.status(200).json({ result });
  } catch (err) {
    console.error("[/api/chat] ERROR:", err?.message || err);
    return res.status(200).json({
      result:
        "Sorry—something went wrong. Please try again.\n\n" +
        "If this keeps happening, verify OPENAI_API_KEY/OPENAI_ASSISTANT_ID and that /public/mlb/page_map.json exists.",
    });
  }
}
