// pages/api/chat.js
// Keeps your frontend contract exactly the same:
//  - accepts { messages: [...] }
//  - returns { result: "<assistant text>" }
// Adds: page_map + verification template via Run "instructions" so every answer
//       appends page-linked verification with quotes, no UI changes needed.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ result: "Method not allowed." });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ result: "Missing OPENAI_API_KEY." });
    }

    // Your existing Assistant ID (unchanged)
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ result: "No messages provided." });
    }

    // Use the deployed git-main domain for public assets (stable + already working)
    const DOMAIN = "https://mlb-cba-assistant-git-main-mitchdotcoms-projects.vercel.app";
    const PDF_URL = `${DOMAIN}/mlb/MLB_CBA_2022.pdf`;
    const PAGE_MAP_URL = `${DOMAIN}/mlb/page_map.json`;

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

    // 2) Add the *last* user message to the thread (keep your existing behavior)
    const lastUserMsg = messages[messages.length - 1]?.content ?? "";
    await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        role: "user",
        content: String(lastUserMsg || "").trim()
      })
    });

    // 3) Fetch page_map.json (best-effort; fallback to empty if not reachable)
    let pageMap = {};
    try {
      const pm = await fetch(PAGE_MAP_URL, { cache: "no-store" });
      if (pm.ok) pageMap = await pm.json();
    } catch (_) { /* ignore; pageMap stays {} */ }

    // 4) Build a strict verification template appended to your Assistant’s rules
    const VERIFY_TEMPLATE =
      `Append the following block exactly after your normal answer:\n\n` +
      `—— Verification ——\n` +
      `• Open PDF: [Open page](${PDF_URL}#page=<n>)\n` +
      `  Raw: ${PDF_URL}#page=<n>\n` +
      `• Exact language (≤ 40 words each):\n` +
      `  “...”\n` +
      `  “...”\n` +
      `• Confidence: High | Medium | Low\n` +
      `• Dual-confirm hot topics (AAV/CBT, deferrals PV, buyouts, service time 172/20-day, Super Two, DFA/options/outrights): say “Confirmed in <Article> and <Appendix/Article>.”\n\n` +
      `Sources (collapsed):\n` +
      `• <file or section>, page <n>: <≤200 chars snippet>\n` +
      `• <file or section>, page <n>: <≤200 chars snippet>\n\n` +
      `Rules for page links:\n` +
      `• Prefer PAGE_MAP when present.\n` +
      `• If missing, infer the likely page and include a ±1 page range if uncertain.\n` +
      `• Quotes must come from the cited page(s).`;

    // We append PAGE_MAP as an extra instruction for this run so links resolve fast.
    const RUN_INSTRUCTIONS = `PAGE_MAP (JSON): ${JSON.stringify(pageMap)}\n\n${VERIFY_TEMPLATE}`;

    // 5) Run the Assistant with *additional* instructions (does not replace your base rules)
    const runRes = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id,
        instructions: RUN_INSTRUCTIONS, // appended just for this run
      })
    });

    const run = await runRes.json();
    if (!run?.id) {
      return res.status(500).json({ result: "Failed to start assistant run." });
    }

    // 6) Poll until run completes (more headroom)
    let status = run.status;
    let tries = 0;
    const MAX_TRIES = 40; // ~60s at 1.5s interval
    while ((status === "queued" || status === "in_progress") && tries < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, 1500));
      const statusRes = await fetch(
        `https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`,
        {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        }
      );
      const statusData = await statusRes.json();
      status = statusData?.status;
      tries++;
    }

    if (status !== "completed") {
      return res.status(500).json({ result: "Assistant run failed or timed out." });
    }

    // 7) Fetch the assistant response
    const messagesRes = await fetch(
      `https://api.openai.com/v1/threads/${thread.id}/messages`,
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );
    const messageData = await messagesRes.json();
    const assistantReply = Array.isArray(messageData?.data)
      ? messageData.data.find((m) => m.role === "assistant")
      : null;

    const resultMessage =
      assistantReply?.content?.[0]?.text?.value?.trim() ||
      "The assistant returned an empty response.";

    // 8) Keep your original response shape
    return res.status(200).json({ result: resultMessage });
  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}
