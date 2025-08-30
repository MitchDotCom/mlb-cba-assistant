// pages/api/chat.js
// Keeps your frontend contract intact:
//   - accepts { messages: [...] } from your /embed
//   - returns { result: "<assistant text>" }
//
// What this does, deterministically:
//   1) Sends your full conversation to your existing Assistant (ID below).
//   2) Does NOT alter your base system instructions on the OpenAI platform.
//   3) After the Assistant answers, it REMOVES any verification it printed.
//   4) It parses the "Citation:" line for Article/Appendix codes.
//   5) It looks up exact pages in public/mlb/page_map.json (authoritative).
//   6) It rebuilds a minimal Verification block with:
//        • One bullet per page: "Page <n> — Open page" (Markdown link)
//        • The link uses “#page=<n>” and adds “&search=<first quote>” (best effort).
//        • Confidence line preserved.
//   7) No giant raw URLs. No "Sources (collapsed)". No parenthetical hints.
//   8) Your ReactMarkdown should use linkTarget="_blank" so links open in new tabs.

function stripExistingVerification(text) {
  // Remove any existing 'Verification' block completely
  const re = /(——\s*Verification\s*——)([\s\S]*?)(?=\n\S|\s*$)/i;
  return text.replace(re, "").trim();
}

function getCitationLine(text) {
  const m = text.match(/(^|\n)Citation:\s*(.+)\n/i);
  return m ? m[2].trim() : "";
}

function getConfidence(text) {
  const m = text.match(/Confidence:\s*(High|Medium|Low)/i);
  return m ? m[1] : null;
}

function extractQuotes(text) {
  // Pull quotes from the "CBA text:" section—prefers smart quotes, falls back to plain quotes
  // 1) try smart quotes
  const smart = Array.from(text.matchAll(/“([^”]{1,200})”/g)).map(m => m[1].trim()).filter(Boolean);
  if (smart.length) return smart;
  // 2) fallback ASCII quotes (keep short)
  const ascii = Array.from(text.matchAll(/"([^"]{1,200})"/g)).map(m => m[1].trim()).filter(Boolean);
  return ascii;
}

function encodeSearch(q) {
  // Use up to ~6 words from the first quote for search param (best-effort highlight in viewers that support it)
  if (!q) return "";
  const words = q.replace(/\s+/g, " ").split(" ").slice(0, 6).join(" ");
  return encodeURIComponent(words);
}

function normalizeCodesFromCitation(citationLine) {
  // Parse things like "Article XIX(A)" -> "XIX.A"
  // and "Article XXIII(E)(2)" -> "XXIII.E.2"
  // Also collect top-level "XIX" and appendices like "Appendix K"
  const out = new Set();

  const artRe = /Article\s+([IVXLCDM]+)((\([^)]*\))*)/gi;
  let m;
  while ((m = artRe.exec(citationLine)) !== null) {
    const roman = m[1].toUpperCase(); // e.g., XXIII
    const parens = m[2] || "";        // e.g., (E)(2)
    const parts = Array.from(parens.matchAll(/\(([A-Za-z0-9]+)\)/g)).map(x => x[1]);
    if (parts.length) {
      out.add(roman + "." + parts.join("."));
    }
    out.add(roman); // top-level fallback
  }

  const appRe = /Appendix\s+([A-Z])/gi;
  let n;
  while ((n = appRe.exec(citationLine)) !== null) {
    out.add(`Appendix ${n[1].toUpperCase()}`);
  }

  return Array.from(out);
}

function mapCodesToPages(codes, pageMap) {
  // pageMap keys like: "XXIII.E.2 (CBT — AAV)" or "XIX (Assignment ...)"
  // Match by head token before first space
  const keys = Object.keys(pageMap || {});
  const pages = [];
  for (const code of codes) {
    for (const k of keys) {
      const head = k.split(" ")[0]; // "XXIII.E.2"
      if (head.toLowerCase() === code.toLowerCase()) {
        const p = pageMap[k];
        if (Number.isInteger(p)) pages.push({ code: head, page: p });
      }
    }
  }
  // Dedup on page
  const seen = new Set();
  return pages.filter(({ page }) => (seen.has(page) ? false : (seen.add(page), true)));
}

function buildVerificationBlock(pages, pdfUrl, confidence, firstQuote) {
  // Build minimal, clean verification. One bullet per page.
  // Always open in new tab on the client via ReactMarkdown linkTarget="_blank".
  const search = encodeSearch(firstQuote);
  const bullets = pages.map(({ page }) => {
    const url = search ? `${pdfUrl}#page=${page}&search=${search}` : `${pdfUrl}#page=${page}`;
    return `• Page ${page} — [Open page](${url})`;
  }).join("\n");

  const confLine = confidence ? `\n• Confidence: ${confidence}` : "";

  return `\n\n—— Verification ——\n${bullets}${confLine}`.trim() + "\n";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ result: "Method not allowed." });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ result: "Missing OPENAI_API_KEY." });
    }

    // === YOUR EXISTING ASSISTANT ID (do not change) ===
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";

    // Known-good asset domain you already deployed
    const DOMAIN = "https://mlb-cba-assistant-git-main-mitchdotcoms-projects.vercel.app";
    const PDF_URL = `${DOMAIN}/mlb/MLB_CBA_2022.pdf`;
    const PAGE_MAP_URL = `${DOMAIN}/mlb/page_map.json`;

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ result: "No messages provided." });
    }

    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> "")}`);
      return r.json();
    }

    // Create thread
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

    // Add full conversation (user + assistant turns)
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

    // Fetch page_map (authoritative for links)
    let pageMap = {};
    try {
      const pm = await fetch(PAGE_MAP_URL, { cache: "no-store" });
      if (pm.ok) pageMap = await pm.json();
    } catch {}

    // Tiny per-run addendum: DO NOT change your base instructions.
    // This only requests the simple sections you already use.
    const RUNTIME_NUDGE = `
Output only these sections, in this order, with no meta text:
Summary:
<one sentence>

How it works:
• <bullets>

Edge cases / exceptions:
• <bullets> (if any)

AI interpretation:
AI interpretation: This reflects how clubs or players may respond to this rule in practice. It is not part of the CBA text.
<one tight sentence>

Citation:
CBA (2022–2026), <Article/Section and Appendix if used>.
`.trim();

    // Start run
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id,
        instructions: RUNTIME_NUDGE
      })
    });

    // Poll
    let status = run.status;
    let tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1400));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
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

    // Read assistant message
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    let text = assistantMsg?.content?.[0]?.text?.value?.trim() || "No response.";

    // Strip any verification the model printed
    text = stripExistingVerification(text);

    // Parse citation + quotes + confidence
    const citationLine = getCitationLine(text);
    const confidence = getConfidence(assistantMsg?.content?.[0]?.text?.value || "");
    const quotes = extractQuotes(text);
    const firstQuote = quotes[0] || "";

    // Map to pages using your page_map.json
    const codes = normalizeCodesFromCitation(citationLine);
    const pageItems = mapCodesToPages(codes, pageMap);

    // Rebuild a clean Verification block with correct links
    if (pageItems.length || confidence) {
      text += buildVerificationBlock(pageItems, PDF_URL, confidence, firstQuote);
    }

    // Return to your frontend
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}

