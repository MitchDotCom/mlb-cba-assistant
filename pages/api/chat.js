// /pages/api/chat.js
// Assistants v2 -> get reply -> rewrite ONLY Citation lines using page_map.json -> return { result }

import fs from "fs";
import path from "path";
import { linkifyCitationsWithMap } from "../../lib/linkifyCitations";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on the server." });
    }

    const assistant_id = process.env.OPENAI_ASSISTANT_ID || "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ error: "No question provided." });
    }

    // --- Load page_map.json from the repo (DON'T import from /public; read the file) ---
    let pageMap = {};
    try {
      const pageMapPath = path.join(process.cwd(), "public", "mlb", "page_map.json");
      pageMap = JSON.parse(fs.readFileSync(pageMapPath, "utf8"));
    } catch (e) {
      console.warn("[chat] Could not read public/mlb/page_map.json:", e.message);
      pageMap = {};
    }

    const j = async (url, opts) => {
      const r = await fetch(url, opts);
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText} — ${t.slice(0, 600)}`);
      }
      return r.json();
    };

    // 1) Create thread
    const thread = await j("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({})
    });
    const threadId = thread.id;

    // 2) Seed messages (preserve prior convo)
    for (const m of messages) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").trim();
      if (!content) continue;

      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        },
        body: JSON.stringify({ role, content })
      });
    }

    // 3) Run the assistant (trust your Platform system prompt)
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id })
    });

    // 4) Poll until completed (up to 60s)
    async function wait(runId) {
      for (let tries = 0; tries < 60; tries++) {
        await new Promise(r => setTimeout(r, 1000));
        const s = await j(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        });
        if (s.status === "completed") return;
        if (["failed", "cancelled", "expired"].includes(s.status)) {
          throw new Error(`Run ${s.status}`);
        }
      }
      throw new Error("Run timed out");
    }
    await wait(run.id);

    // 5) Read the latest assistant message
    const msgList = await j(`https://api.openai.com/v1/threads/${threadId}/messages?limit=50&order=desc`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });

    const firstAssistant = (msgList?.data || []).find(m => m.role === "assistant");
    const raw = (firstAssistant?.content || [])
      .map(c => (typeof c?.text?.value === "string" ? c.text.value : ""))
      .join("\n")
      .trim();

    if (!raw) {
      return res.status(200).json({ result: "No response from assistant." });
    }

    // 6) Rewrite only Citation lines with the correct PDF pages + markdown links
    const fixed = linkifyCitationsWithMap(raw, pageMap, "/mlb/MLB_CBA_2022.pdf");

    return res.status(200).json({ result: fixed });
  } catch (err) {
    console.error("[chat] error:", err);
    return res.status(200).json({ result: "Sorry—something went wrong. Please try again." });
  }
}
