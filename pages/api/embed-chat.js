// pages/api/chat.js
// Contract preserved for your frontend:
//   - accepts { messages: [...] } from /embed
//   - returns { result: "<assistant text>" }
//
// What this does (deterministic):
//   1) Sends your full conversation to your existing Assistant (your system instructions remain AS-IS in OpenAI).
//   2) Adds a tiny "topic hint" derived from the user's last message (e.g., DFA -> Designated for Assignment, Article XIX).
//   3) After the answer returns, extracts quotes from "CBA text".
//   4) Looks up exact PDF pages by searching public/mlb/cba_pages.json for those quotes.
//   5) If quotes don't match the expected topic, FALLS BACK to a keyword search against cba_pages.json
//      using MLB synonyms (e.g., DFA -> "designated for assignment").
//   6) Replaces any model-made verification with a clean one, using real page links and a real snippet.
//   7) Output is minimal: bullets with Page N — [Open page](...#page=N&search=...) — “snippet” + Confidence.
//
// Dependencies: none extra at runtime (cba_pages.json is built by the GitHub Action we added).

/* ------------------ small helpers ------------------ */

function stripExistingVerification(text) {
  const re = /(——\s*Verification\s*——)([\s\S]*?)(?=\n\S|\s*$)/i;
  return text.replace(re, "").trim();
}

function getConfidence(text) {
  const m = text.match(/Confidence:\s*(High|Medium|Low)/i);
  return m ? m[1] : null;
}

function extractQuotesFromAnswer(text) {
  // Prefer smart quotes “...”; fallback to ASCII "..."
  const smart = Array.from(text.matchAll(/“([^”]{4,300})”/g)).map(m => m[1].trim());
  if (smart.length) return smart.slice(0, 3);
  const ascii = Array.from(text.matchAll(/"([^"]{4,300})"/g)).map(m => m[1].trim());
  return ascii.slice(0, 3);
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^a-z0-9\s'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreByTokens(hay, needle, maxTokens = 8) {
  const toks = normalize(needle).split(" ").filter(Boolean).slice(0, maxTokens);
  if (!toks.length) return 0;
  let hit = 0;
  for (const t of toks) {
    if (t.length >= 3 && hay.includes(t)) hit++;
  }
  return hit / Math.max(1, toks.length);
}

function findPagesForQuotes(pages, quotes) {
  // pages: [{page, text}]
  const results = [];
  const normPages = pages.map(p => ({ page: p.page, text: normalize(p.text) }));
  for (const q of quotes) {
    const nq = normalize(q);
    if (!nq) continue;
    let best = null;
    for (const p of normPages) {
      if (p.text.includes(nq)) {
        best = { page: p.page, quote: q, score: nq.length, source: "exact" };
        break;
      }
      const score = scoreByTokens(p.text, q);
      if (!best || score > best.score) best = { page: p.page, quote: q, score, source: "fuzzy" };
    }
    if (best) results.push(best);
  }
  // Dedup by (page, quote)
  const seen = new Set();
  return results.filter(r => {
    const k = `${r.page}::${r.quote}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function snippetAround(pageText, phrase, radius = 18) {
  const txt = pageText.replace(/\s+/g, " ").trim();
  const idx = txt.toLowerCase().indexOf(phrase.toLowerCase());
  if (idx < 0) {
    // Fallback: just return the first ~18 words
    return txt.split(" ").slice(0, radius).join(" ") + "…";
  }
  const words = txt.split(" ");
  // approximate word index
  const before = txt.slice(0, idx).split(" ").length;
  const start = Math.max(0, before - Math.floor(radius / 2));
  const end = Math.min(words.length, start + radius);
  return words.slice(start, end).join(" ") + "…";
}

function buildVerificationBlock(found, pdfUrl, confidence) {
  if (!found.length && !confidence) return "";
  // sort by page
  found.sort((a, b) => a.page - b.page);
  const bullets = found.map(({ page, quote, snippet }) => {
    const anchor = encodeURIComponent((quote || snippet || "").split(/\s+/).slice(0, 6).join(" "));
    const link = `${pdfUrl}#page=${page}${anchor ? `&search=${anchor}` : ""}`;
    const show = quote ? `“${quote}”` : (snippet ? `“${snippet}”` : "");
    return `• Page ${page} — [Open page](${link})${show ? ` — ${show}` : ""}`;
  }).join("\n");
  const conf = confidence ? `\n• Confidence: ${confidence}` : "";
  return `\n\n—— Verification ——\n${bullets}${conf}\n`;
}

/* ------------------ topic hints & fallback ------------------ */

function deriveTopicHints(lastUserText) {
  const q = (lastUserText || "").toLowerCase();

  // Very small MLB lexicon to steer the model
  if (/\bdfa\b|\bdesignated for assignment\b/.test(q)) {
    return {
      hint: "Topic: DFA = Designated for Assignment. Cite MLB CBA Article XIX (Assignment of Player Contracts), specifically the 'Designated Player' / DFA procedures.",
      keywords: ["designated for assignment", "designated player", "outright waivers", "seven days", "assignment", "waivers", "release"]
    };
  }
  if (/\bsuper\s*two\b/.test(q)) {
    return {
      hint: "Topic: Super Two arbitration eligibility. Cite Article VI(E)(1)(b) (or equivalent) for Super Two criteria.",
      keywords: ["super two", "22%", "top 22 percent", "arbitration eligibility", "2 years", "86 days"]
    };
  }
  if (/\bservice time\b|\b172\b/.test(q)) {
    return {
      hint: "Topic: Credited Major League Service. Cite Article XXI(A) for service time definitions (172 days = year).",
      keywords: ["credited major league service", "172", "service days", "20-day option rule"]
    };
  }
  if (/\bcbt\b|\bluxury tax\b|\baverage annual value\b|\baav\b/.test(q)) {
    return {
      hint: "Topic: Competitive Balance Tax (CBT) and AAV. Cite Article XXIII(E)(2) for AAV and Appendix (PV/discount).",
      keywords: ["competitive balance tax", "average annual value", "aav", "present value", "deferred compensation"]
    };
  }
  if (/\boption(s)?\b|\boutright\b|\bwaiver/.test(q)) {
    return {
      hint: "Topic: Optional assignments, outrights, and waivers. Cite Article XIX (Options and Outright Assignments).",
      keywords: ["optional assignment", "outright", "waivers", "20-day", "option year"]
    };
  }
  // Generic fallback: no hint/keywords
  return { hint: "", keywords: [] };
}

function pickPagesByKeywords(pages, keywords, maxHits = 2) {
  // returns top pages containing the most keyword hits, with short snippets
  if (!keywords.length) return [];
  const scored = [];
  for (const p of pages) {
    const text = normalize(p.text);
    let hit = 0;
    for (const kw of keywords) {
      const k = normalize(kw);
      if (k && text.includes(k)) hit++;
    }
    if (hit > 0) scored.push({ page: p.page, score: hit, t: p.text });
  }
  scored.sort((a, b) => b.score - a.score || a.page - b.page);
  const top = scored.slice(0, maxHits).map(s => {
    // choose the first keyword present to build a snippet
    const kw = keywords.find(k => normalize(s.t).includes(normalize(k))) || keywords[0];
    return { page: s.page, quote: "", snippet: snippetAround(s.t, kw) };
  });
  return top;
}

/* ------------------ caching ------------------ */

let PAGES_CACHE = null;

async function getPagesJSON(base) {
  if (PAGES_CACHE) return PAGES_CACHE;
  const url = `${base}/mlb/cba_pages.json`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  PAGES_CACHE = await r.json();
  return PAGES_CACHE;
}

function getPublicBaseFromReq(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
}

/* ------------------ main handler ------------------ */

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ result: "Method not allowed." });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ result: "Missing OPENAI_API_KEY." });

    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2"; // your existing Assistant id

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ result: "No messages provided." });

    const PUBLIC_BASE = getPublicBaseFromReq(req);
    const PDF_URL = `${PUBLIC_BASE}/mlb/MLB_CBA_2022.pdf`;

    // Derive topic hint & keywords from the LAST user turn
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
    const { hint: TOPIC_HINT, keywords: KW } = deriveTopicHints(lastUser);

    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> "")}`);
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

    // 2) Add full conversation
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

    // 3) A tiny nudge: topic hint + require 1–2 short quotes in "CBA text"
    const NUDGE =
      (TOPIC_HINT ? `${TOPIC_HINT}\n` : "") +
      `In "CBA text", include 1–2 short verbatim quotes from the governing clause. Do not include meta guidance or parenthetical notes.`;

    // 4) Start run
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      },
      body: JSON.stringify({ assistant_id, instructions: NUDGE })
    });

    // 5) Poll
    let status = run.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1400));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      status = s.status; tries++;
    }
    if (status !== "completed") return res.status(500).json({ result: "Assistant run failed or timed out." });

    // 6) Read answer
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    let answer = assistantMsg?.content?.[0]?.text?.value || "";

    // 7) Remove any model-made verification
    answer = stripExistingVerification(answer);

    // 8) Extract quotes & find pages
    const quotes = extractQuotesFromAnswer(answer);
    const pagesJSON = await getPagesJSON(PUBLIC_BASE);

    let found = findPagesForQuotes(pagesJSON, quotes);

    // 9) If the model's quotes don't match topic keywords (e.g., DFA), run keyword fallback
    const topicWord = KW.find(k => /[a-z]/i.test(k)) || "";
    const topicNorm = normalize(topicWord);
    const quotesContainTopic = quotes.some(q => normalize(q).includes(topicNorm));
    if ((!found.length || !quotesContainTopic) && KW.length) {
      const keywordPages = pickPagesByKeywords(pagesJSON, KW, 2);
      // Attach a short snippet from the true page text
      found = keywordPages;
    }

    // 10) Confidence (if present)
    const confidence = getConfidence(assistantMsg?.content?.[0]?.text?.value || "");

    // 11) Build clean verification
    const ver = buildVerificationBlock(found, PDF_URL, confidence);

    // 12) Return to client
    return res.status(200).json({ result: (answer + ver).trim() });
  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}
