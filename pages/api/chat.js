// pages/api/chat.js
// Assistants v2 -> get reply text -> rewrite page numbers using linkifyCitations()
// -> return { result } that contains real <a> tags ready to render.

import { linkifyCitations } from "../../lib/linkifyCitations";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const assistant_id = process.env.OPENAI_ASSISTANT_ID;
    if (!OPENAI_API_KEY || !assistant_id) {
      return res
        .status(500)
        .json({ result: "Server misconfigured: missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID." });
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(200).json({ result: "No question provided." });
    }

    const j = async (url, opts) => {
      const r = await fetch(url, {
        ...opts,
        headers: {
          ...(opts?.headers || {}),
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText} — ${t.slice(0, 400)}`);
      }
      return r.json();
    };

    // 1) Thread
    const thread = await j("https://api.openai.com/v1/threads", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const threadId = thread.id;

    // 2) Messages
    for (const m of messages) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").trim();
      if (!content) continue;
      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role, content }),
      });
    }

    // 3) Run assistant
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id }),
    });

    // 4) Poll (30s cap to keep UX snappy)
    const waitForRun = async (runId) => {
      for (let tries = 0; tries < 30; tries++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await j(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
          { method: "GET" }
        );
        if (s.status === "completed") return;
        if (["failed", "cancelled", "expired"].includes(s.status)) {
          throw new Error(`Run ${s.status}`);
        }
      }
      throw new Error("Run timed out");
    };
    await waitForRun(run.id);

    // 5) Read latest assistant message
    const msgList = await j(
      `https://api.openai.com/v1/threads/${threadId}/messages?limit=20&order=desc`,
      { method: "GET" }
    );

    const firstAssistant = (msgList?.data || []).find((m) => m.role === "assistant");
    const raw = (firstAssistant?.content || [])
      .map((c) => (typeof c?.text?.value === "string" ? c.text.value : ""))
      .join("\n")
      .trim();

    if (!raw) {
      return res.status(200).json({ result: "No response from assistant." });
    }

    // 6) REWRITE page numbers/links using page_map.json (Article start page only)
    const fixed = linkifyCitations(raw, "/mlb/MLB_CBA_2022.pdf");

    return res.status(200).json({ result: fixed });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    return res.status(200).json({ result: "Sorry—something went wrong. Please try again." });
  }
}
