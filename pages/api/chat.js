// pages/api/chat.js
// Used by /embed (your front-end posts here).
// Returns { result: "<final text>" } with real page-linked citations & source excerpts.

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

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your MLB Assistant id
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(200).json({ result: 'No question provided.' });
    }

    // 1) Create a thread
    const threadRes = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({})
    });
    const thread = await threadRes.json();
    if (!thread?.id) {
      console.error('[chat] Failed to create thread:', thread);
      return res.status(200).json({ result: 'Assistant error: could not start a session.' });
    }

    // 2) Send the full conversation so context is preserved
    for (const m of messages) {
      const role = (m?.role === "user" || m?.role === "assistant") ? m.role : "user";
      const content = typeof m?.content === "string" ? m.content : "";
      if (!content.trim()) continue;
      await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        },
        body: JSON.stringify({ role, content: content.trim() })
      });
    }

    // 3) Small nudge so the model includes short, distinctive fragments we can align
    const override =
      "After your standard output (Summary, How it works, Edge cases / exceptions, AI interpretation, Citation), " +
      "append 1–2 SHORT, DISTINCTIVE fragments (≤ 35 words) copied verbatim from the CBA that directly support the answer. " +
      "Use MLB-specific terms (e.g., “Designated for Assignment”, “ninety (90) days”, “Competitive Balance Tax”, “average annual value”). " +
      "Do NOT add page numbers or links. Do NOT paraphrase. Use straight quotes only.";

    // 4) Run the Assistant
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: override })
    });
    const run = await runRes.json();
    if (!run?.id) {
      console.error('[chat] Failed to start run:', run);
      return res.status(200).json({ result: 'Assistant error: could not generate a reply.' });
    }

    // 5) Poll until complete
    let status = run.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1400));
      const sRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      const s = await sRes.json();
      status = s?.status; tries++;
    }
    if (status !== "completed") {
      console.error('[chat] Run status:', status);
      return res.status(200).json({ result: 'Assistant error: timed out preparing the reply.' });
    }

    // 6) Read latest assistant message
    const msgsRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const msgs = await msgsRes.json();
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    const raw = assistantMsg?.content?.[0]?.text?.value?.trim() || "The assistant returned an empty response.";

    // 7) Build origin (used if we need to fetch the PDF over HTTP)
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mlb.mitchleblanc.xyz';
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const origin = `${proto}://${host}`;

    // 8) Server-side rewrite: add real Citation + Source text with page-linked, exact PDF excerpts
    //    (reads /public/mlb/MLB_CBA_2022.pdf; falls back to HTTP fetch if needed)
    let finalText = raw;
    try {
      const { text } = await attachVerification(raw, '/mlb/MLB_CBA_2022.pdf', origin);
      finalText = text;
    } catch (e) {
      console.error('[chat attachVerification] ERROR:', e?.message || e);
      // keep raw if something goes wrong
    }

    return res.status(200).json({ result: finalText });
  } catch (e) {
    console.error('[chat] FATAL:', e?.message || e);
    return res.status(200).json({ result: 'Server error preparing the reply. Please try again.' });
  }
}
