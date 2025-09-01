// /pages/api/chat.js
import { linkifyCitations } from "../../lib/linkifyCitations"; // <-- RELATIVE import (no @ alias)

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on the server." });
    }

    // ✅ Your Assistant ID from the OpenAI platform
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ error: "No question provided." });
    }

    // helper to call OpenAI REST endpoints
    async function j(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=>"")}`);
      return r.json();
    }

    // 1) Create a thread
    const thread = await j("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({})
    });
    const threadId = thread.id;

    // 2) Add user messages
    for (const m of messages) {
      const role = (m?.role === "assistant") ? "assistant" : "user";
      const content = (m?.content || "").toString().trim();
      if (!content) continue;

      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ role, content })
      });
    }

    // 3) Run the Assistant (trust the platform system prompt)
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ assistant_id })
    });

    // 4) Poll until completed
    async function wait(runId) {
      let tries = 0;
      while (tries < 60) {
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
        tries++;
      }
      throw new Error("Run timed out");
    }
    await wait(run.id);

    // 5) Get the latest assistant message text
    const msgs = await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });

    const assistantMsg = msgs?.data?.find(m => m.role === "assistant");
    let raw = "";

    if (assistantMsg?.content?.length) {
      raw = assistantMsg.content
        .filter(part => part.type === "text" && part.text?.value)
        .map(part => part.text.value)
        .join("\n\n")
        .trim();
    }

    if (!raw) raw = "The assistant returned an empty response.";

    // 6) DO NOT rewrite. Only linkify “Page N — Open page”.
    const result = linkifyCitations(raw);

    return res.status(200).json({ result });
  } catch (e) {
    console.error("[/api/chat] ERROR:", e?.message || e);
    return res.status(500).json({ error: "Internal error" });
  }
}
