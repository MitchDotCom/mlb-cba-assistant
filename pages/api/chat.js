// /pages/api/chat.js
// No external "ai" package. Pure fetch to Assistants API v2.
// Returns { result } — always. On failure, returns a friendly message.

import { linkifyCitations } from "../../lib/linkifyCitations"; // relative path

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on the server." });
    }

    // Prefer env; fall back to the known ID if you want a hard fallback
    const assistant_id = process.env.OPENAI_ASSISTANT_ID || "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    // Hard-limit body parsing issues
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      body = {};
    }

    const { messages = [] } = body || {};
    // If front-end forgets to send messages, we still proceed with something
    const safeMessages = Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: "Help me understand this rule in the MLB CBA." }];

    // Simple wrapper for fetch to OpenAI
    const callOpenAI = async (url, init) => {
      const r = await fetch(url, init);
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`OpenAI ${r.status} ${r.statusText} — ${t.slice(0, 800)}`);
      }
      return r.json();
    };

    // 1) Create a thread
    const thread = await callOpenAI("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({}),
    });
    const threadId = thread.id;

    // 2) Add all user messages to the thread
    for (const m of safeMessages) {
      const role = m.role === "assistant" ? "assistant" : "user";
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;

      await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ role, content }),
      });
    }

    // 3) Run the Assistant (trust the system prompt you configured on the platform)
    const run = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ assistant_id }),
    });

    // 4) Poll for completion (up to ~90s)
    async function waitForRun(runId) {
      let tries = 0;
      while (tries < 90) {
        await new Promise(r => setTimeout(r, 1000));
        const status = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2",
          },
        });
        if (status.status === "completed") return;
        if (["failed", "cancelled", "expired"].includes(status.status)) {
          throw new Error(`Run ${status.status}: ${status.last_error?.message || "no details"}`);
        }
        tries++;
      }
      throw new Error("Run timed out.");
    }

    await waitForRun(run.id);

    // 5) Read the messages in this thread, newest first; get the first assistant text
    const list = await callOpenAI(`https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=30`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    });

    // Stitch together text parts robustly
    let raw = "";
    for (const msg of list.data || []) {
      if (msg.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;
      const pieces = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text?.value) pieces.push(c.text.value);
        if (c.type === "output_text" && c.output_text?.value) pieces.push(c.output_text.value);
      }
      const joined = pieces.join("\n").trim();
      if (joined) {
        raw = joined;
        break;
      }
    }

    if (!raw) raw = "The assistant returned an empty response.";

    // 6) Augment ONLY with linkified citations + verified PDF page links
    const result = await linkifyCitations(raw);

    return res.status(200).json({ result });
  } catch (e) {
    console.error("[/api/chat] ERROR:", e?.message || e);
    // Never let the embed break
    const fallback =
      "Sorry—something went wrong.\n\n" +
      "Tip: If this keeps happening, check OPENAI_API_KEY / OPENAI_ASSISTANT_ID on the server, " +
      "and confirm your OpenAI Assistant is accessible.";
    return res.status(200).json({ result: fallback });
  }
}
