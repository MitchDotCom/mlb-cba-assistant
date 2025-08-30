// pages/api/chat.js
const { attachVerification } = require('../../lib/pdfIndex');

export default async function handler(req, res) {
  // Always answer 200 with a string so the UI never shows "Something went wrong"
  try {
    if (req.method !== 'POST') {
      return res.status(200).json({ result: 'Use POST with a question.' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(200).json({ result: 'Missing OPENAI_API_KEY on the server.' });
    }

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your MLB Assistant

    const messages = req.body?.messages || [];
    if (!messages.length) {
      return res.status(200).json({ result: 'No question provided.' });
    }

    const userText = messages[messages.length - 1].content;

    // 1) Create thread
    const threadRes = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    const thread = await threadRes.json();
    if (!thread?.id) {
      console.error('[chat] Failed to create thread:', thread);
      return res.status(200).json({ result: 'Assistant error: could not start a session.' });
    }

    // 2) Add the latest user message
    await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ role: "user", content: userText }),
    });

    // 3) Run the Assistant with a tiny instruction to force short quotes at the end
    const override =
      "After your normal output (Summary, How it works, Edge cases, AI interpretation, Citation), " +
      "append a final section titled '—— Verification ——' with 1–3 verbatim quotes (≤ 40 words each) " +
      "from the exact CBA text you used. Do NOT include page numbers or links—the app will add them. " +
      "Use MLB meanings for acronyms by default (e.g., DFA = Designated for Assignment).";

    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: override }),
    });
    const run = await runRes.json();
    if (!run?.id) {
      console.error('[chat] Failed to start run:', run);
      return res.status(200).json({ result: 'Assistant error: could not generate a reply.' });
    }

    // 4) Poll until run completes (with cap)
    let status = run.status;
    let tries = 0;
    const maxTries = 24; // ~36s
    while ((status === "queued" || status === "in_progress") && tries < maxTries) {
      await new Promise((r) => setTimeout(r, 1500));
      const statusRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        },
      });
      const statusData = await statusRes.json();
      status = statusData?.status;
      tries++;
    }

    if (status !== "completed") {
      console.error('[chat] Run status:', status);
      return res.status(200).json({ result: 'Assistant error: timed out preparing the reply.' });
    }

    // 5) Read the latest assistant message
    const messagesRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
    });
    const messageData = await messagesRes.json();
    const assistantReply = (messageData?.data || []).find((m) => m.role === "assistant");
    const raw =
      assistantReply?.content?.[0]?.text?.value?.trim() ||
      "The assistant returned an empty response.";

    // 6) Build origin for PDF HTTP fallback (works in preview/prod)
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'mlb.mitchleblanc.xyz';
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const origin = `${proto}://${host}`;
    console.log('[attachVerification] origin=', origin);

    // 7) Attach PDF page links + one Confidence line (never throw)
    let finalText = raw;
    try {
      const result = await attachVerification(raw, '/mlb/MLB_CBA_2022.pdf', origin);
      console.log('[attachVerification] changed=', result.changed);
      finalText = result.text;
    } catch (e) {
      console.error('[attachVerification] ERROR:', e?.message || e);
      // keep finalText = raw
    }

    return res.status(200).json({ result: finalText });
  } catch (e) {
    console.error('[chat] FATAL:', e?.message || e);
    return res.status(200).json({
      result: 'Server error preparing the reply. Please try again.'
    });
  }
}
