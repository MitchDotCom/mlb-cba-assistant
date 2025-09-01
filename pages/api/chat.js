// pages/api/chat.js
// Calls Assistants v2, grabs the text, runs linkifyCitations() to inject correct
// start pages + <a> links from public/mlb/page_map.json, then returns the result.

import { linkifyCitations } from "../../lib/linkifyCitations";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ result: "Method not allowed" });
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
        const body = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText} — ${body.slice(0, 400)}`);
      }
      return r.json();
    };

    // create thread
    const thread = await j("https://api.openai.com/v1/threads", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const threadId = thread.id;

    // add messages
    for (const m of messages) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").trim();
      if (!content) continue;
      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role, content }),
      });
    }

    // run assistant
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id }),
    });

    // poll up to ~30s
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await j(
        `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
        { method: "GET" }
      );
      if (s.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(s.status)) {
        throw new Error(`Run ${s.status}`);
      }
      if (i === 29) throw new Error("Run timed out");
    }

    // read last assistant message
    const msgs = await j(
      `https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=20`,
      { method: "GET" }
    );
    const firstAssistant = (msgs?.data || []).find((m) => m.role === "assistant");
    const raw =
      (firstAssistant?.content || [])
        .map((c) => (typeof c?.text?.value === "string" ? c.text.value : ""))
        .join("\n")
        .trim() || "";

    if (!raw) {
      return res.status(200).json({ result: "No response from assistant." });
    }

    // IMPORTANT: rewrite PAGE fields using ONLY your map (article start) + add <a> links
    const fixed = linkifyCitations(raw, "/mlb/MLB_CBA_2022.pdf");

    return res.status(200).json({ result: fixed });
  } catch (err) {
    console.error("/api/chat error:", err);
    return res.status(200).json({ result: "Sorry—something went wrong. Please try again." });
  }
}
