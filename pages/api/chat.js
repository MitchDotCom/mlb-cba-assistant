// pages/api/chat.js
// Assistants v2 -> get reply -> rewrite ONLY page numbers using page_map.json -> return { result }

import fs from "fs";
import path from "path";
import { linkifyCitationsWithMap } from "../../lib/linkifyCitations";

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
        .json({ error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID on the server." });
    }

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ error: "No question provided." });
    }

    // Load page_map.json from the repo (server-side, no bundler import of JSON)
    let pageMap = {};
    try {
      const pageMapPath = path.join(process.cwd(), "public", "mlb", "page_map.json");
      pageMap = JSON.parse(fs.readFileSync(pageMapPath, "utf8"));
    } catch (e) {
      console.warn("[chat] Could not read public/mlb/page_map.json:", e.message);
      pageMap = {};
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
        throw new Error(`HTTP ${r.status} ${r.statusText} — ${t.slice(0, 800)}`);
      }
      return r.json();
    };

    // 1) Create thread
    const thread = await j("https://api.openai.com/v1/threads", { method: "POST", body: JSON.stringify({}) });
    const threadId = thread.id;

    // 2) Seed messages (preserve prior convo)
    for (const m of messages) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").trim();
      if (!content) continue;

      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role, content }),
      });
    }

    // 3) Run the assistant
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id }),
    });

    // 4) Poll until completed (hard cap ~60s)
    const waitForRun = async (runId) => {
      for (let tries = 0; tries < 60; tries++) {
        await new Promise((r) => setTimeout(r, 1000));
        const s = await j(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { method: "GET" });
        if (s.status === "completed") return;
        if (["failed", "cancelled", "expired"].includes(s.status)) {
          throw new Error(`Run ${s.status}`);
        }
      }
      throw new Error("Run timed out");
    };
    await waitForRun(run.id);

    // 5) Read the latest assistant message
    const msgList = await j(
      `https://api.openai.com/v1/threads/${threadId}/messages?limit=50&order=desc`,
      { method: "GET" }
    );

    const firstAssistant = (msgList?.data || []).find((m) => m.role === "assistant");
    const raw = (firstAssistant?.content || [])
      .map((c) => (typeof c?.text?.value === "string" ? c.text.value : ""))
      .join("\n")
      .trim();

    if (!raw) {
      // Return something the client can show (don’t 500—just say no content)
      return res.status(200).json({ result: "No response from assistant." });
    }

    // 6) Rewrite page numbers/links from mapping (single source of truth)
    const fixed = linkifyCitationsWithMap(raw, pageMap, "/mlb/MLB_CBA_2022.pdf");

    return res.status(200).json({ result: fixed });
  } catch (err) {
    console.error("[/api/chat] error:", err);
    // 200 with a message so the embed UI can show it inline (keeps UX consistent)
    return res.status(200).json({ result: "Sorry—something went wrong. Please try again." });
  }
}
