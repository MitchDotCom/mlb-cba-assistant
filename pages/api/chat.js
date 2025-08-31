// pages/api/chat.js
const { attachVerification } = require("../../lib/pdfIndex");

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ result: "Use POST with a question." });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(200).json({ result: "Missing OPENAI_API_KEY on the server." });
    }

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // keep your Assistant
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(200).json({ result: "No question provided." });

    const lastUser = [...messages].reverse().find(m => m?.role === "user")?.content || "";

    // Small helper
    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> "")}`);
      return r.json();
    }

    // 1) Thread
    const thread = await ofetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({})
    });
    const threadId = thread.id;

    // 2) Post convo
    for (const m of messages) {
      const role = (m?.role === "assistant") ? "assistant" : "user";
      const content = (m?.content || "").toString().trim();
      if (!content) continue;
      await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        },
        body: JSON.stringify({ role, content })
      });
    }

    // 3) Force brief verbatim fragments (generic; no topic hints)
    const override =
      "After your standard output (Summary, How it works, Edge cases / exceptions, AI interpretation, Citation), " +
      "append 1–2 short, distinctive fragments (≤ 35 words) copied verbatim from the MLB CBA that support your answer. " +
      "Do NOT add page numbers or links. Do NOT paraphrase. Use straight quotes only.";

    // 4) Run
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: override })
    });

    // 5) Poll
    let status = run.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1200));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      status = s.status; tries++;
    }
    if (status !== "completed") {
      return res.status(200).json({ result: "Assistant error: timed out preparing the reply." });
    }

    // 6) Read
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    const raw = assistantMsg?.content?.[0]?.text?.value?.trim() || "The assistant returned an empty response.";

    // 7) Origin for HTTP fallback
    const host = req.headers["x-forwarded-host"] || req.headers.host || "mlb.mitchleblanc.xyz";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${host}`;

    // 8) Inject canonical Citation + Source text (question is required here)
    let finalText = raw;
    try {
      const { text } = await attachVerification(raw, lastUser, "/mlb/MLB_CBA_2022.pdf", origin);
      finalText = text;
    } catch (e) {
      console.error("[chat attachVerification] ERROR:", e?.message || e);
    }

    return res.status(200).json({ result: finalText });
  } catch (e) {
    console.error("[chat] FATAL:", e?.message || e);
    return res.status(200).json({ result: "Server error preparing the reply. Please try again." });
  }
}
