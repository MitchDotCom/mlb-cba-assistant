// pages/api/embed-chat.js
// Contract preserved for your /embed UI:
//   POST { messages: [{role:'user'|'assistant', content:string}, ...] } -> { result: string }
//
// What this does:
// 1) Sends the conversation to your existing OpenAI Assistant (system instructions unchanged).
// 2) Nudges the model to include 1–2 short, distinctive verbatim fragments from the CBA.
// 3) Rewrites the reply server-side to add REAL page-linked citations + source text
//    by reading the official PDF (no page_map.json needed).
// 4) Always responds 200 with { result } so your UI never shows a generic error.

const { attachVerification } = require('../../lib/pdfIndex');

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(200).json({ result: 'Use POST with a question.' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(200).json({ result: 'Missing OPENAI_API_KEY on the server.' });
    }

    // IMPORTANT: keep using your existing Assistant id (same as /api/chat.js)
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(200).json({ result: 'No question provided.' });
    }

    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    // Create a very small topic nudge so the model picks distinctive fragments
    const override =
      "After your standard output (Summary, How it works, Edge cases / exceptions, AI interpretation, Citation), " +
      "append 1–2 SHORT, DISTINCTIVE fragments (≤ 35 words) copied verbatim from the CBA that directly support the answer. " +
      "Use MLB-specific terms (e.g., “Designated for Assignment”, “ninety (90) days”, “Competitive Balance Tax”, “average annual value”). " +
      "Do NOT add page numbers or links. Do NOT paraphrase. Use straight quotes.";

    // ---- OpenAI Assistants API (v2) ----
    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> '')}`);
      return r.json();
    }

    // 1) Create thread
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

    // 2) Send the full conversation (preserves your context)
    for (const m of messages) {
      const role = (m?.role === "user" || m?.role === "assistant") ? m.role : "user";
      const content = typeof m?.content === "string" ? m.content : "";
      if (!content.trim()) continue;
      await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        },
        body: JSON.stringify({ role, content: content.trim() })
      });
    }

    // 3) Run with the small override (forces distinctive verbatim fragments)
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: override })
    });

    // 4) Poll until complete
    let status = run.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1400));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      status = s.status; tries++;
    }
    if (status !== "completed") {
      return res.status(200).json({ result: 'Assistant error: timed out preparing the reply.' });
    }

    // 5) Read latest assistant message
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    const raw = assistantMsg?.content?.[0]?.text?.value?.trim() || "The assistant returned an empty response.";

    // 6) Build absolute origin for PDF HTTP fallback (works in preview/prod)
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mlb.mitchleblanc.xyz';
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const origin = `${proto}://${host}`;

    // 7) Rewrite with REAL Citations + Source text (page-linked) — no confidence line.
    //    Uses the official PDF at /mlb/MLB_CBA_2022.pdf (must be in /public/mlb/)
    let finalText = raw;
    try {
      const { text } = await attachVerification(raw, '/mlb/MLB_CBA_2022.pdf', origin);
      finalText = text;
    } catch (e) {
      console.error('[embed-chat attachVerification] ERROR:', e?.message || e);
      // keep raw if rewrite fails
    }

    return res.status(200).json({ result: finalText });
  } catch (e) {
    console.error('[embed-chat] FATAL:', e?.message || e);
    // Always return 200 so the UI shows the text instead of a red error
    return res.status(200).json({ result: 'Server error preparing the reply. Please try again.' });
  }
}
