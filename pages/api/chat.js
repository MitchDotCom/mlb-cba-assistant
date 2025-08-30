// pages/api/chat.js
const { attachVerification } = require('../../lib/pdfIndex');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ result: 'POST only' });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your MLB Assistant

  const messages = req.body?.messages || [];
  if (!messages.length) {
    return res.status(400).json({ result: "No messages provided." });
  }

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
    return res.status(500).json({ result: "Failed to create assistant thread." });
  }

  // 2) Add the latest user message
  const userText = messages[messages.length - 1].content;
  await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify({
      role: "user",
      content: userText
    }),
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
    return res.status(500).json({ result: "Failed to start assistant run." });
  }

  // 4) Poll until run completes
  let status = run.status;
  let retries = 0;
  const maxRetries = 20;
  while ((status === "queued" || status === "in_progress") && retries < maxRetries) {
    await new Promise((r) => setTimeout(r, 1500));
    const statusRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
    });
    const statusData = await statusRes.json();
    status = statusData?.status;
    retries++;
  }

  if (status !== "completed") {
    return res.status(500).json({ result: "Assistant run failed or timed out." });
  }

  // 5) Read the assistant message
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

  // 6) Attach PDF page links + one Confidence line
  let finalText = raw;
  try {
    const { text } = await attachVerification(raw, '/mlb/MLB_CBA_2022.pdf');
    finalText = text;
  } catch (e) {
    console.error('attachVerification error', e);
  }

  return res.status(200).json({ result: finalText });
}
