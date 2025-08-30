// pages/api/chat.js
// Contract preserved for your frontend:
//  - accepts { messages: [...] }
//  - returns { result: "<assistant text>" }
// Adds: PAGE_MAP + verification template via run.instructions
// Also: server-side post-processing to FORCE a clickable PDF link every time.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ result: "Method not allowed." });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ result: "Missing OPENAI_API_KEY." });
    }

    // === CONFIG YOU ALREADY USE ===
    // Keep using your existing Assistant ID:
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    // Use the known-good git-main asset domain
    const DOMAIN = "https://mlb-cba-assistant-git-main-mitchdotcoms-projects.vercel.app";
    const PDF_URL = `${DOMAIN}/mlb/MLB_CBA_2022.pdf`;
    const PAGE_MAP_URL = `${DOMAIN}/mlb/page_map.json`;

    // Incoming messages from your embed UI
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ result: "No messages provided." });
    }

    // Helper: simple fetch wrapper
    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=>"")}`);
      return r.json();
    }

    // 1) Create a thread
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
    if (!threadId) {
      return res.status(500).json({ result: "Failed to create assistant thread." });
    }

    // 2) Add the ENTIRE conversation in order (user + assistant)
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

    // 3) Fetch page_map (best-effort)
    let pageMap = {};
    try {
      const pm = await fetch(PAGE_MAP_URL, { cache: "no-store" });
      if (pm.ok) pageMap = await pm.json();
    } catch (_) { /* ignore */ }

    // 4) Strict verification template (model instruction)
    const VERIFY_TEMPLATE =
      `Append the following block exactly after your normal answer:\n\n` +
      `—— Verification ——\n` +
      `• Open PDF: [Open page](${PDF_URL}#page=<n>)\n` + // we will fix <n> server-side if needed
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

    const RUN_INSTRUCTIONS = `PAGE_MAP (JSON): ${JSON.stringify(pageMap)}\n\n${VERIFY_TEMPLATE}`;

    // 5) Start a run with additional instructions (does not replace your base assistant rules)
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id,
        instructions: RUN_INSTRUCTIONS
      })
    });

    const runId = run.id;
    if (!runId) {
      return res.status(500).json({ result: "Failed to start assistant run." });
    }

    // 6) Poll until complete
    let status = run.status;
    let tries = 0;
    const MAX_TRIES = 40; // ~60s at 1.5s
    while ((status === "queued" || status === "in_progress") && tries < MAX_TRIES) {
      await new Promise(r => setTimeout(r, 1500));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      });
      status = s.status;
      tries++;
    }
    if (status !== "completed") {
      return res.status(500).json({ result: "Assistant run failed or timed out." });
    }

    // 7) Get the latest assistant message
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });

    const assistantMsg = Array.isArray(msgs?.data)
      ? msgs.data.find((m) => m.role === "assistant")
      : null;

    let text =
      assistantMsg?.content?.[0]?.text?.value?.trim() ||
      "The assistant returned an empty response.";

    // 8) SERVER-SIDE FIX: force a clickable PDF link
    // - Find the first URL with '#page=<digits>'
    // - Replace any 'Open PDF: ...' line with a guaranteed Markdown link
    // - Wrap the Raw URL in <...> so ReactMarkdown auto-links
    (function forceClickableLink() {
      // Prefer an explicit pdf#page=### URL
      let url = null;
      const m1 = text.match(/https?:\/\/[^\s)]+\/mlb\/MLB_CBA_2022\.pdf#page=\d+/i);
      if (m1) url = m1[0];

      // Fallback: any Raw: URL
      if (!url) {
        const m2 = text.match(/Raw:\s*(https?:\/\/[^\s)]+)/i);
        if (m2) url = m2[1];
      }

      if (url) {
        // Always output a clean "Open PDF" line with a valid link + a Raw line with <>.
        const openLine = `• Open PDF: [Open page](${url})\n  Raw: <${url}>`;

        if (/Open PDF:[^\n]*/i.test(text)) {
          // Replace the whole "Open PDF:" line (+ possible Raw on same line) with our canonical version
          text = text.replace(/Open PDF:[^\n]*/i, openLine);
          // If there was an existing Raw line right below, normalize it
          text = text.replace(/Raw:\s*(https?:\/\/[^\s)]+)/i, `Raw: <${url}>`);
        } else {
          // If "Open PDF:" wasn't present (edge case), inject it just under "—— Verification ——"
          text = text.replace(/—— Verification ——/i, `—— Verification ——\n${openLine}`);
        }
      }

      // If we still have a 'Raw: http...' without <...>, wrap it so links are clickable in ReactMarkdown
      text = text.replace(/Raw:\s*(https?:\/\/[^\s)]+)/g, (m, u) => `Raw: <${u}>`);

      // If the model left a placeholder '#page=<n>', try to replace <n> with any digit we can find later in the text
      if (text.includes("#page=<n>")) {
        const m3 = text.match(/#page=(\d+)/);
        if (m3) {
          const pg = m3[1];
          text = text.replace(/#page=<n>/g, `#page=${pg}`);
        } else {
          // As a last resort, drop the placeholder so the markdown link doesn't get broken
          text = text.replace(/#page=<n>/g, "#page=1");
        }
      }
    })();

    // 9) Return in your original shape
    return res.status(200).json({ result: text });
  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}
