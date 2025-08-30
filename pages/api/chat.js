// pages/api/chat.js
function stripExistingVerification(text) {
  const re = /(——\s*Verification\s*——)([\s\S]*?)(?=\n\S|\s*$)/i;
  return text.replace(re, "").trim();
}
function getConfidence(text) {
  const m = text.match(/Confidence:\s*(High|Medium|Low)/i);
  return m ? m[1] : null;
}
function extractQuotesFromAnswer(text) {
  const smart = Array.from(text.matchAll(/“([^”]{4,300})”/g)).map(m => m[1].trim());
  if (smart.length) return smart.slice(0, 3);
  const ascii = Array.from(text.matchAll(/"([^"]{4,300})"/g)).map(m => m[1].trim());
  return ascii.slice(0, 3);
}
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function findPagesForQuotes(pages, quotes) {
  const results = [];
  const normPages = pages.map(p => ({ page: p.page, text: normalize(p.text) }));
  for (const q of quotes) {
    const nq = normalize(q);
    if (!nq) continue;
    let best = null;
    for (const p of normPages) {
      if (p.text.includes(nq)) { best = { page: p.page, quote: q, score: nq.length }; break; }
      const toks = nq.split(" ").filter(Boolean).slice(0, 8);
      let hit = 0;
      for (const t of toks) { if (t.length >= 3 && p.text.includes(t)) hit++; }
      const score = hit / Math.max(1, toks.length);
      if (!best || score > best.score) best = { page: p.page, quote: q, score };
    }
    if (best) results.push(best);
  }
  const seen = new Set();
  return results.filter(r => { const k = `${r.page}::${r.quote}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
function buildVerificationBlock(found, pdfUrl, confidence) {
  if (!found.length && !confidence) return "";
  found.sort((a, b) => a.page - b.page);
  const bullets = found.map(({ page, quote }) => {
    const search = encodeURIComponent(quote.split(/\s+/).slice(0, 6).join(" "));
    return `• Page ${page} — [Open page](${pdfUrl}#page=${page}&search=${search}) — “${quote}”`;
  }).join("\n");
  const conf = confidence ? `\n• Confidence: ${confidence}` : "";
  return `\n\n—— Verification ——\n${bullets}${conf}\n`;
}
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
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ result: "Method not allowed." });
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ result: "Missing OPENAI_API_KEY." });
    const assistant_id = "asst_O7Gb2VAnxmHP2Bd5Gu3Utjf2";
    const PUBLIC_BASE = getPublicBaseFromReq(req);
    const PDF_URL = `${PUBLIC_BASE}/mlb/MLB_CBA_2022.pdf`;
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ result: "No messages provided." });
    async function ofetch(url, opts) {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(()=> "")}`);
      return r.json();
    }
    const thread = await ofetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" },
      body: JSON.stringify({})
    });
    const threadId = thread.id;
    for (const m of messages) {
      const role = (m?.role === "user" || m?.role === "assistant") ? m.role : "user";
      const content = typeof m?.content === "string" ? m.content : "";
      if (!content.trim()) continue;
      await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" },
        body: JSON.stringify({ role, content: content.trim() })
      });
    }
    const NUDGE = `In "CBA text", include 1–2 short verbatim quotes from the governing clause. Do not include meta guidance.`;
    const run = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" },
      body: JSON.stringify({ assistant_id, instructions: NUDGE })
    });
    let status = run.status, tries = 0;
    while ((status === "queued" || status === "in_progress") && tries < 40) {
      await new Promise(r => setTimeout(r, 1400));
      const s = await ofetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      status = s.status; tries++;
    }
    if (status !== "completed") return res.status(500).json({ result: "Assistant run failed or timed out." });
    const msgs = await ofetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    const assistantMsg = Array.isArray(msgs?.data) ? msgs.data.find(m => m.role === "assistant") : null;
    let answer = assistantMsg?.content?.[0]?.text?.value || "";
    answer = stripExistingVerification(answer);
    const quotes = extractQuotesFromAnswer(answer);
    const pagesJSON = await getPagesJSON(PUBLIC_BASE);
    const found = findPagesForQuotes(pagesJSON, quotes);
    const confidence = getConfidence(assistantMsg?.content?.[0]?.text?.value || "");
    const ver = buildVerificationBlock(found, PDF_URL, confidence);
    return res.status(200).json({ result: (answer + ver).trim() });
  } catch (err) {
    return res.status(500).json({ result: `Server error: ${String(err?.message || err)}` });
  }
}
