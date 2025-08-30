// pages/api/chat.js
// Keeps your UI contract exactly the same:
//  - accepts { messages: [...] } from the client
//  - returns { result: "<assistant text>" }
//
// What this adds:
//  - A strict output template enforced at run-time (no fluff).
//  - "Summary → CBA text (quotes) → AI interpretation → Citation → Verification".
//  - Hard caps on length; ban filler phrases.
//  - PAGE_MAP JSON passed in so links are precise.
//  - Server fix to ensure the PDF link is always clickable.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ result: "Method not allowed." });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ result: "Missing OPENAI_API_KEY." });
    }

    // Your existing Assistant (do not change)
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    // Known-good public assets
    const DOMAIN = "https://mlb-cba-assistant-git-main-mitchdotcoms-projects.vercel.app";
    const PDF_URL = `${DOMAIN}/mlb/MLB_CBA_2022.pdf`;
    const PAGE_MAP_URL = `${DOMAIN}/mlb/page_map.json`;

    // Frontend messages as-is
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ result: "No messages provided." });
    }

    // --- helpers ---
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
    if (!threadId) return res.status(500).json({ result: "Failed to create assistant thread." });

    // 2) Add the ENTIRE conversation (user + assistant turns)
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
    } catch (_) {}

    // 4) STRICT template (no fluff)
    // Keeps your original Assistant rules; we append this per-run.
    const STRICT_TEMPLATE =
`OUTPUT FORMAT (exact order, no extra sections):
Summary:
<Max 25 words. Plain-English one-liner. No preamble, no throat-clearing.>

CBA text (verbatim, ≤ 2 quotes, each ≤ 40 words):
“<quote 1>”
“<quote 2>”

AI interpretation (≤ 35 words, start with this exact disclaimer):
AI interpretation: This reflects how clubs or players may respond to this rule in practice. It is not part of the CBA text.
<one tight sentence — why it matters, no speculation>

Citation:
CBA (2022–2026), <exact Article/Section and Appendix if used, e.g., Article XXIII(E)(2)>.

—— Verification ——
• Open PDF: [Open page](${PDF_URL}#page=<n>)
  Raw: ${PDF_URL}#page=<n>
• Confidence: High | Medium | Low
• Dual-confirm (required if topic ∈ {AAV/CBT, deferrals PV, buyouts, service time 172/20-day, Super Two, DFA/options/outrights}):
  Confirmed in <Article/Section> and <Appendix/Article>.

Sources (collapsed):
• <file or section>, page <n>: <≤200 chars snippet>
• <file or section>, page <n>: <≤200 chars snippet>

CONSTRAINTS:
• No preambles (e.g., “Certainly”, “Here’s”).
• No restating the user question.
• Keep total answer ≤ 180 words (excluding URLs).
• Quotes MUST come from the cited page(s).
• Use PAGE_MAP when present; if unknown, pick best page and allow ±1 page range in your reasoning (but do not print ranges).
• Be concrete and legalistic; ban generic filler.`;

    // 5) Verification & PAGE_MAP added to run instructions
    const RUN_INSTRUCTIONS = `PAGE_MAP (JSON): ${JSON.stringify(pageMap)}\n\n${STRICT_TEMPLATE}`;

    // 6) Start a run with appended instructions
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
    if (!runId) return res.status(500).json({ result: "Failed to start assistant run." });

    // 7) Poll until complete
    let status = run.status;
    let tries = 0;
    const MAX_TRIES = 40;
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

    // 8) Get the latest assistant message
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

    // 9) Force a clickable PDF link and remove any leftover placeholders
    (function forceClickableLink() {
      // Prefer an explicit pdf#page=### URL
      let url = null;
      const m1 = text.match(/https?:\/\/[^\s)]+\/mlb\/MLB_CBA_2022\.pdf#page=\d+/i);
      if (m1) url = m1[0];

      // Fallback: Raw: URL
      if (!url) {
        const m2 = text.match(/Raw:\s*(https?:\/\/[^\s)]+)/i);
        if (m2) url = m2[1];
      }

      if (url) {
        const openLine = `• Open PDF: [Open page](${url})\n  Raw: <${url}>`;
        if (/Open PDF:[^\n]*/i.test(text)) {
          text = text.replace(/Open PDF:[^\n]*/i, openLine);
          text = text.replace(/Raw:\s*(https?:\/\/[^\s)]+)/i, `Raw: <${url}>`);
        } else {
          text = text.replace(/—— Verification ——/i, `—— Verification ——\n${openLine}`);
        }
      }

      // Wrap any remaining Raw URLs so ReactMarkdown links them
      text = text.replace(/Raw:\s*(https?:\/\/[^\s)]+)/g, (m, u) => `Raw: <${u}>`);

      // Replace any '#page=<n>' placeholders with a real page if present elsewhere; else default to 1
      if (text.includes("#page=<n>")) {
        const m3 = text.match(/#page=(\d+)/);
        text = text.replace(/#page=<n>/g, `#page=${m3 ? m3[1] : "1"}`);
      }
    })();

    // 10) Return in your original shape
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}

