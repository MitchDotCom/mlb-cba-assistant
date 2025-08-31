// pages/api/chat.js
const { attachVerification } = require("../../lib/pdfIndex");

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).json({ result: "Use POST with a question." });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(200).json({ result: "Missing OPENAI_API_KEY on the server." });

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(200).json({ result: "No question provided." });

    const lastUser = [...messages].reverse().find(m => m?.role === "user")?.content || "";

    async function j(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> "")}`);
      return r.json();
    }

    // Create thread
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

    // Seed messages
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

    // Pass 1: normal answer + REQUIRED LEGAL_EXCERPTS
    const override1 = `
You MUST end your reply with a block named LEGAL_EXCERPTS in EXACTLY this structure:

LEGAL_EXCERPTS:
1) ARTICLE: <best-effort article/section label from the CBA (e.g., "Article XXIII(C)(2) — Determination of Salary")>
   QUOTE: "<exact 12–40 word passage copied verbatim from the CBA, straight quotes only>"
2) ARTICLE: <...>
   QUOTE: "<...>"

Rules:
- Provide 1–4 items. Prefer the most on-point clauses that support your answer.
- QUOTE must be copied verbatim from the MLB CBA text you used. No paraphrasing. No ellipses. Straight ASCII quotes only.
- Do NOT include page numbers or links. Do NOT include anything else after the LEGAL_EXCERPTS block.
- Above this block, keep your normal structure (Summary, How it works, Edge cases / exceptions, AI interpretation, Citation). Do NOT add links there; the server will inject final page-linked citations.
`.trim();

    const run1 = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ assistant_id, instructions: override1 })
    });

    async function wait(runId) {
      let tries = 0;
      while (tries < 40) {
        await new Promise(r => setTimeout(r, 1000));
        const s = await j(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
          headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
        });
        if (s.status === "completed") return;
        if (s.status === "failed" || s.status === "cancelled" || s.status === "expired") throw new Error(`Run ${s.status}`);
        tries++;
      }
      throw new Error("Run timed out");
    }

    await wait(run1.id);

    const msgs1 = await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const a1 = msgs1?.data?.find(m => m.role === "assistant");
    let raw = a1?.content?.[0]?.text?.value?.trim() || "";

    // If no LEGAL_EXCERPTS, force a second pass that returns ONLY that block
    if (!/\nLEGAL_EXCERPTS:\s*\n/i.test(raw)) {
      await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({
          role: "user",
          content: `Return ONLY the LEGAL_EXCERPTS block (no other text). Use the same rules as before.`
        })
      });
      const run2 = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ assistant_id })
      });
      await wait(run2.id);

      const msgs2 = await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      const a2 = msgs2?.data?.find(m => m.role === "assistant");
      const block = a2?.content?.[0]?.text?.value?.trim() || "";
      // append to the original prose so the injector can verify
      raw = `${raw}\n\n${block}`.trim();
    }

    // Build origin for HTTP fallback
    const host = req.headers["x-forwarded-host"] || req.headers.host || "mlb.mitchleblanc.xyz";
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${host}`;

    // Verify + inject links
    let finalText = raw || "The assistant returned an empty response.";
    try {
      const { text } = await attachVerification(finalText, lastUser, "/mlb/MLB_CBA_2022.pdf", origin);
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
