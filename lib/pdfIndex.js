// lib/pdfIndex.js
// Trust-the-Assistant linker:
// - Keeps model prose intact
// - Enforces ONE AI interpretation (keeps first, drops extras)
// - Parses LEGAL_EXCERPTS (flexible formats), validates quotes against PDF
// - Only corrects/overwrites PAGE numbers when match is confident
// - Rewrites Citation with verified pages + Open page links
// - Appends "—— Source text ——" with 25–45 word snippets from the verified pages
//
// Notes:
// - Accepts both numbered and unnumbered LEGAL_EXCERPTS
// - Accepts items WITH or WITHOUT declared PAGE; will fill from PDF if found
// - Ignores ellipses "..." inside quotes for matching; fuzzy token overlap ≥55%
// - Article title taken ONLY from top-of-page headers like "ARTICLE XXIII—Competitive Balance Tax"

const fs = require("fs");
const path = require("path");

// ---------- I/O ----------
async function loadFromPublic(relPath) {
  const p = path.join(process.cwd(), "public", relPath.replace(/^\//, ""));
  try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; }
}
async function fetchAsUint8(origin, relPath) {
  const r = await fetch(`${origin}${relPath}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${relPath}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function loadTextIndex(origin) {
  try {
    const disk = await loadFromPublic("/mlb/cba_pages.json");
    const raw = disk ? Buffer.from(disk).toString("utf8")
                     : Buffer.from(await fetchAsUint8(origin, "/mlb/cba_pages.json")).toString("utf8");
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json : Array.isArray(json.pages) ? json.pages : [];
    if (arr.length) return arr.map(p => ({ num: p.page || p.num || p.id || 1, text: String(p.text || "") }));
  } catch {}
  return null;
}
async function loadPdfText(origin, pdfHref) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
  pdfjs.GlobalWorkerOptions.workerSrc = require("pdfjs-dist/legacy/build/pdf.worker.js");
  const bytes = (await loadFromPublic(pdfHref)) || (await fetchAsUint8(origin, pdfHref));
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent({ normalizeWhitespace: true });
    const joined = content.items.map(it => it.str || "").join(" ");
    // de-hyphenate splits like "Sec- tion"
    const dehy = joined.replace(/\b([A-Za-z]{2,})-\s+([A-Za-z]{2,})\b/g, "$1$2");
    const text = dehy.replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
  }
  return pages;
}

// ---------- text utils ----------
const norm = s => (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g, " ").trim();
function trimWords(s, minW, maxW) {
  const words = s.split(/\s+/); if (words.length <= maxW) return s.trim();
  const mid = Math.floor(words.length / 2), span = Math.max(minW, Math.min(maxW, 45));
  const start = Math.max(0, mid - Math.floor(span / 2));
  return words.slice(start, start + span).join(" ").trim();
}
function snippetAround(text, idx) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - 260), end = Math.min(t.length, idx + 280);
  return trimWords(t.slice(start, end), 25, 45);
}

// ---------- Article ranges (true headers only) ----------
function detectMainTitleTop(text) {
  const top = (text || "").slice(0, 900);
  const m = top.match(/\bARTICLE\s+([IVXLC]+)\s*[—-]\s*([A-Z][A-Za-z0-9 ,&/()'’\-]{3,})/);
  if (!m) return null;
  return `ARTICLE ${m[1].toUpperCase()}—${m[2].trim().replace(/\s+/g, " ")}`;
}
function buildArticleRanges(pages) {
  const starts = [];
  for (const p of pages) {
    const title = detectMainTitleTop(p.text);
    if (title) starts.push({ page: p.num, title });
  }
  starts.sort((a,b)=>a.page-b.page);
  const ranges = [];
  for (let i=0;i<starts.length;i++){
    const start=starts[i].page;
    const end=(i+1<starts.length)?(starts[i+1].page-1):pages[pages.length-1].num;
    ranges.push({ start, end, title: starts[i].title });
  }
  return ranges;
}
function rangeForPage(ranges, page){
  for (const r of ranges) if (page>=r.start && page<=r.end) return r;
  return null;
}
function rangeForArticleGuess(ranges, label){
  const roman = (label||"").match(/article\s+([ivxlc]+)/i)?.[1]?.toUpperCase();
  if (!roman) return null;
  return ranges.find(r => r.title.toUpperCase().startsWith(`ARTICLE ${roman}`)) || null;
}

// ---------- LEGAL_EXCERPTS parser (robust) ----------
function parseLegalExcerpts(answer) {
  const out = [];
  const blockMatch = answer.match(/(?:^|\n)LEGAL_EXCERPTS:\s*\n([\s\S]*?)$/i);
  if (!blockMatch) return out;
  const block = blockMatch[1];

  // Accept numbered and unnumbered; accept "| PAGE:" or "PAGE:" on same line
  const rxNum = /^\s*\d+\)\s*ARTICLE:\s*(.*?)\s*(?:\|\s*PAGE:\s*(\d+))?\s*\n\s*QUOTE:\s*"([\s\S]*?)"\s*$/gmi;
  const rxPlain = /^\s*ARTICLE:\s*(.*?)\s*(?:\|\s*PAGE:\s*(\d+))?\s*\n\s*QUOTE:\s*"([\s\S]*?)"\s*$/gmi;

  let m;
  while ((m = rxNum.exec(block))) {
    out.push({ article: m[1].trim(), page: m[2] ? Number(m[2]) : null, quote: m[3].replace(/\u2026/g,'...').trim() });
  }
  if (!out.length) {
    while ((m = rxPlain.exec(block))) {
      out.push({ article: m[1].trim(), page: m[2] ? Number(m[2]) : null, quote: m[3].replace(/\u2026/g,'...').trim() });
    }
  }
  // normalize ellipses spacing
  for (const it of out) it.quote = it.quote.replace(/\s*\.\.\.\s*/g, " ... ");
  return out.slice(0, 4);
}

// ---------- quote matching ----------
function exactIndexOf(hay, needle) {
  // ignore ellipses in the quote for matching
  const H = norm(hay);
  const N = norm(needle.replace(/\.\.\./g, " "));
  return H.indexOf(N);
}
function fuzzyIndex(hay, quote) {
  const H = norm(hay).replace(/[^a-z0-9' -]/g," ");
  const Q = norm(quote.replace(/\.\.\./g, " ")).replace(/[^a-z0-9' -]/g," ");
  const qToks = Q.split(/\s+/).filter(Boolean);
  if (!qToks.length) return -1;
  const hToks = H.split(/\s+/).filter(Boolean);
  const win = Math.max(6, Math.min(qToks.length + 6, 46));
  let best = { i:-1, s:-1 };
  for (let i=0;i<=Math.max(0,hToks.length-win);i++){
    const w = hToks.slice(i,i+win);
    const set = new Set(w);
    let s=0; for (const t of qToks) if (set.has(t)) s++;
    if (s>best.s) best={ i, s };
  }
  if (best.s < Math.ceil(qToks.length * 0.55)) return -1;
  const pos = hToks.slice(0,best.i).join(" ").length;
  return Math.max(0,pos);
}
function findQuoteOnPages(quote, pages, preferRange) {
  const pool = preferRange ? pages.filter(p=>p.num>=preferRange.start && p.num<=preferRange.end) : pages;
  for (const p of pool){ const i = exactIndexOf(p.text, quote); if (i>=0) return { p, idx:i }; }
  for (const p of pool){ const i = fuzzyIndex(p.text, quote); if (i>=0) return { p, idx:i }; }
  if (preferRange) {
    for (const p of pages){ const i = exactIndexOf(p.text, quote); if (i>=0) return { p, idx:i }; }
    for (const p of pages){ const i = fuzzyIndex(p.text, quote); if (i>=0) return { p, idx:i }; }
  }
  return null;
}

// ---------- helpers ----------
function ensureOneAI(body) {
  const lines = body.split("\n");
  let seen = false, out = [];
  for (let i=0;i<lines.length;i++){
    const line = lines[i];
    if (/^\s*AI interpretation:/i.test(line)) {
      if (seen) continue; // drop duplicates
      seen = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

function rebuildCitation(assistantText, verifiedLines) {
  // Replace existing "Citation:" block with verified lines
  const rx = /(?:^|\n)Citation:\s*([\s\S]*?)(?:\n{2,}|$)/i;
  const repl = `\nCitation:\n${verifiedLines.join("\n")}\n\n`;
  if (rx.test(assistantText)) return assistantText.replace(rx, repl);
  // else append near the end, before LEGAL_EXCERPTS
  const idx = assistantText.search(/(?:^|\n)LEGAL_EXCERPTS:/i);
  if (idx >= 0) return assistantText.slice(0, idx) + repl + assistantText.slice(idx);
  return assistantText.trim() + repl;
}

// ---------- main ----------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz") {
  // Keep the body intact & enforce single AI interpretation
  let body = ensureOneAI(String(answerText || ""));

  // Load pages
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // Build article ranges from true top-of-page titles
  let ranges = buildArticleRanges(pages);

  // Parse LEGAL_EXCERPTS
  const items = parseLegalExcerpts(body);

  const hits = [];
  for (const it of items) {
    const prefer = rangeForArticleGuess(ranges, it.article);
    const hit = findQuoteOnPages(it.quote, pages, prefer);
    if (!hit) {
      // no match; keep original page hint if any, but no snippet
      hits.push({ article: it.article, page: it.page || null, verifiedPage: null, snippet: null, title: null });
      continue;
    }
    const r = rangeForPage(ranges, hit.p.num);
    const title = r?.title || detectMainTitleTop(hit.p.text) || "";
    const snippet = snippetAround(hit.p.text, hit.idx);
    hits.push({ article: it.article, page: it.page || null, verifiedPage: hit.p.num, snippet, title });
  }

  // Build VERIFIED Citation lines (unique by article+page)
  const seen = new Set();
  const citeLines = [];
  for (const h of hits) {
    const page = h.verifiedPage || h.page;
    if (!page) continue;
    const key = `${h.article}|${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citeLines.push(`CBA (2022–2026), ${h.article}; Page ${page} — [Open page](${pdfHref}#page=${page})`);
  }

  // Rebuild Citation (leave body otherwise unchanged)
  if (citeLines.length) {
    body = rebuildCitation(body, citeLines);
  }

  // Build Source bullets from VERIFIED hits only
  const bullets = [];
  const usedPages = new Set();
  for (const h of hits) {
    if (!h.verifiedPage || !h.snippet) continue;
    if (usedPages.has(h.verifiedPage)) continue;
    usedPages.add(h.verifiedPage);
    bullets.push(`• Page ${h.verifiedPage} — [Open page](${pdfHref}#page=${h.verifiedPage}) — “${h.snippet}”${h.title ? ` — ${h.title}` : ""}`);
    if (bullets.length >= 4) break;
  }

  // Append/replace Source text block if we have bullets
  if (bullets.length) {
    const rxSrc = /(?:^|\n)—{2,}\s*Source text\s*—{2,}[\s\S]*$/i;
    const block = `\n—— Source text ——\n${bullets.join("\n")}`;
    if (rxSrc.test(body)) {
      body = body.replace(rxSrc, block);
    } else {
      body = body.trim() + "\n" + block;
    }
  }

  return { text: body, page: bullets[0] ? Number(bullets[0].match(/Page\s+(\d+)/i)[1]) : (citeLines[0] ? Number(citeLines[0].match(/Page\s+(\d+)/i)[1]) : 1) };
}

module.exports = { attachVerification };
