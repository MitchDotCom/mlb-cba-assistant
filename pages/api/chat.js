// pages/api/chat.js
// Keeps your /embed contract: accepts { messages }, returns { result }.
// Enforces your clean structure and builds correct PDF page links from page_map.json.
// No "raw" URLs, no "collapsed", no parenthetical hints in output.

function extractCitationsBlock(text) {
  // Grabs the "Citation:" line and returns it
  const m = text.match(/(^|\n)Citation:\s*(.+)\n/i);
  return m ? m[2].trim() : "";
}

function parseCodesFromCitation(citationLine) {
  // Tries to pull normalized codes like "XXIII.E.2" from a line such as:
  // "CBA (2022–2026), Article XXIII(E)(2) and Appendix K."
  // Returns an array of candidate codes: ["XXIII.E.2", "XXIII", ...]
  const out = new Set();

  // Article patterns like XXIII(E)(2)(b)...
  const articleMatches = citationLine.match(/Article\s+([IVXLCDM]+)(\([^)]*\))*/gi) || [];
  for (const a of articleMatches) {
    // Pull roman
    const art = (a.match(/Article\s+([IVXLCDM]+)/i) || [])[1];
    if (!art) continue;
    // Pull nested parens e.g. (E)(2)(b)
    const nest = Array.from(a.matchAll(/\(([A-Za-z0-9]+)\)/g)).map(m => m[1]);
    let code = art.toUpperCase();
    for (const n of nest) {
      // Normalize like E or 2 or b -> .E / .2 / .b (keep case)
      code += "." + n;
    }
    out.add(code);
    // Also add plain Article as fallback
    out.add(art.toUpperCase());
  }

  // Appendices like "Appendix K" or "Appendix B"
  const appMatches = citationLine.match(/Appendix\s+([A-Z])/gi) || [];
  for (const ap of appMatches) {
    const letter = (ap.match(/Appendix\s+([A-Z])/i) || [])[1];
    if (letter) out.add(`Appendix ${letter.toUpperCase()}`);
  }

  return Array.from(out);
}

function findPagesFromCodes(codes, pageMap) {
  // pageMap keys look like "XXIII.E.2 (CBT — AAV)" or "Appendix B (CBT Tables)"
  // We match by prefix before the space.
  const pages = [];
  const keys = Object.keys(pageMap || {});
  for (const code of codes) {
    // exact or prefix (before first space or paren)
    for (const k of keys) {
      const head = k.split(" ")[0]; // "XXIII.E.2"
      if (head.toLowerCase() === code.toLowerCase()) {
        const p = pageMap[k];
        if (Number.isInteger(p)) pages.push({ code: head, page: p });
      }
    }
  }
  // Dedup by page
  const seen = new Set();
  return pages.filter(({ page }) => (seen.has(page) ? false : (seen.add(page), true)));
}

function rebuildVerification(text, pages, pdfUrl) {
  // Always render a clean block with only bullets + confidence.
  // If no pages are known, we keep whatever the model wrote (but we scrub "Raw").
  const confMatch = text.match(/Confidence:\s*(High|Medium|Low)/i);
  const confidence = confMatch ? confMatch[1] : null;

  if (!pages.length && !confidence) {
    // nothing we can deterministically improve
    return text.replace(/Raw:\s*https?:\/\/\S+/gi, "").replace(/\n{3,}/g, "\n\n");
  }

  const bullets = pages
    .map(({ page }) => `• Page ${page} — [Open page](${pdfUrl}#page=${page})`)
    .join("\n");

  const confLine = confidence ? `\n• Confidence: ${confidence}` : "";

  // Replace the entire Verification block if present, else append one.
  const verRe = /(——\s*Verification\s*——)([\s\S]*?)(?=\n\S|\s*$)/i;
  const cleanBlock = `—— Verification ——\n${bullets}${confLine}`;
  if (verRe.test(text)) {
    return text
      .replace(verRe, cleanBlock)
      .replace(/Raw:\s*https?:\/\/\S+/gi, "")
      .replace(/\n{3,}/g, "\n\n");
  } else {
    return (
      text
        + `\n\n${cleanBlock}`
    )
      .replace(/Raw:\s*https?:\/\/\S+/gi, "")
      .replace(/\n{3,}/g, "\n\n");
  }
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

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your existing Assistant

    const DOMAIN = "https://mlb-cba-assistant-git-main-mitchdotcoms-projects.vercel.app";
    const PDF_URL = `${DOMAIN}/mlb/MLB_CBA_2022.pdf`;
    const PAGE_MAP_URL = `${DOMAIN}/mlb/page_map.json`;

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      return res.status(400).json({ result: "No messages provided." });
    }

    // Helper that throws on non-2xx
    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => "")}`);
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

    // Add full conversation (user + assistant)
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

    // Minimal, invisible run-time addendum:
    // - keep YOUR system instructions exactly as set in the OpenAI Assistant
    // - just force the simple output shape and ban meta directives from output
    const RUNTIME_RULES = `
OUTPUT SHAPE (exact headers, no meta commentary, no parenthetical hints):
Summary:
<one sentence, plain-English>

CBA text:
“<short quote 1>”
“<short quote 2>”

AI interpretation:
AI interpretation: This reflects how clubs or players may respond to this rule in practice. It is not part of the CBA text.
<one tight sentence on why it matters>

Citation:
CBA (2022–2026), <exact Article/Section and any Appendix>.

—— Verification ——
• Pages: <comma-separated page numbers from PAGE_MAP only; if unknown, leave empty>
• Confidence: High | Medium | Low

RULES:
• Do NOT print instructions, token limits, or parenthetical guidance in the output.
• Do NOT print "Sources (collapsed)". Omit that section entirely.
• Use PAGE_MAP strictly for page numbers. Do not guess pages. If unmapped, leave Pages empty.
• Quotes MUST come from the cited Article/Appendix text.
`.trim();

    // Start run (appending only the runtime rules + page_map; your base instructions stay as-is in the Assistant)
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({
        assistant_id,
        instructions: `PAGE_MAP: ${JSON.stringify(pageMap)}\n\n${RUNTIME_RULES}`
      })
    });

    // Poll
    let status = run.status;
    let tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1500));
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

    // Build links from PAGE_MAP using the Citation line
    const citationLine = extractCitationsBlock(text);
    const codes = parseCodesFromCitation(citationLine);
    const pageItems = findPagesFromCodes(codes, pageMap);

    // Rewrite verification block cleanly with real links from map (no Raw, no fluff)
    text = rebuildVerification(text, pageItems, PDF_URL);

    return res.status(200).json({ result: text });
  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}
