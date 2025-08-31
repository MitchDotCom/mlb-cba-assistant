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

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your Assistant
    const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!msgs.length) return res.status(200).json({ result: "No question provided." });

    const lastUser = [...msgs].reverse().find(m => m?.role === "user")?.content || "";

    // 1) Create thread
    const tRes = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({})
    });
    const thread = await tRes.json();

    // 2) Post convo (user + assistant turns, if any)
    for (const m of msgs) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = (m?.content || "").toString().trim();
      if (!content) continue;
      await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
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
    const rRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: override })
    });
    const run = await rRes.json();

    // 5) Poll
    let status = run?.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1200));
      const sRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      const s = await sRes.json();
      status = s?.status; tries++;
    }
    if (status !== "completed") {
      return res.status(200).json({ result: "Assistant error: timed out preparing the reply." });
    }

    // 6) Read assistant message
    const mRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const mJson = await mRes.json();
    const assistantMsg = Array.isArray(mJson?.data) ? mJson.data.find(m => m.role === "assistant") : null;
    const raw = assistantMsg?.content?.[0]?.text?.value?.trim() || "The assistant returned an empty response.";

    // 7) Build origin (for HTTP asset fallback)
    const host = req.headers["x-forwarded-host"] || req.headers.host || "mlb.mitchleblanc.xyz";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${host}`;

    // 8) Inject canonical Citation + Source text using official PDF (or cba_pages.json)
    let finalText = raw;
    try {
      const { text } = await attachVerification(raw, lastUser, "/mlb/MLB_CBA_2022.pdf", origin);
      finalText = text;
    } catch (e) {
      console.error("[attachVerification] ERROR:", e?.message || e);
    }

    return res.status(200).json({ result: finalText });
  } catch (e) {
    console.error("[chat] FATAL:", e?.message || e);
    return res.status(200).json({ result: "Server error preparing the reply. Please try again." });
  }
}
