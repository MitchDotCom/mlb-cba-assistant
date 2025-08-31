// lib/pdfIndex.js
// Parse LEGAL_EXCERPTS from the model, map each QUOTE to exact PDF pages, and inject:
//   Citation: CBA (2022–2026), <Article Title>; Page N — [Open page](/mlb/MLB_CBA_2022.pdf#page=N)
//   —— Source text ——
//   • Page N — [Open page](...) — “<verbatim 25–45 words>” — <Article Title or Section>
// All bullets are confined to the same Article range as the anchor page.
// No topic hints. No manual maps.

const fs = require("fs");
const path = require("path");

// ---------------- I/O ----------------
async function loadFromPublic(relPath) {
  const diskPath = path.join(process.cwd(), "public", relPath.replace(/^\//, ""));
  try { return new Uint8Array(fs.readFileSync(diskPath)); } catch { return null; }
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
  } catch (_) {}
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
    const dehy  = joined.replace(/\b([A-Za-z]{2,})-\s+([A-Za-z]{2,})\b/g, "$1$2"); // de-hyphenate
    const text  = dehy.replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
  }
  return pages;
}

// ---------------- text utils ----------------
const STOP = new Set([
  "the","and","for","with","that","this","from","into","such","shall","have","has","are","was","were","will","may",
  "can","not","than","then","there","their","they","them","his","her","its","also","within","about","over","between",
  "to","of","in","on","by","as","a","an","or","at","be","is","it","if","but","so","do","does","did","after","before"
]);
const norm  = s => (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g," ").trim();
const strip = s => norm(s).replace(/[^a-z0-9' -]/g,""); // punctuation-light for fuzzy
function tokenize(s) { return strip(s).split(/\s+/).filter(w => w && !STOP.has(w) && w.length >= 3); }
function bigrams(toks){ const out=[]; for (let i=0;i<toks.length-1;i++) out.push(toks[i]+" "+toks[i+1]); return out; }
function trimWords(s, minW, maxW) {
  const words = s.split(/\s+/);
  if (words.length <= maxW) return s.trim();
  const mid = Math.floor(words.length / 2);
  const span = Math.max(minW, Math.min(maxW, 45));
  const start = Math.max(0, mid - Math.floor(span / 2));
  return words.slice(start, start + span).join(" ").trim();
}

// ---------------- LEGAL_EXCERPTS parser ----------------
function parseLegalExcerpts(answer) {
  const rxStart = /(?:^|\n)LEGAL_EXCERPTS:\s*\n/i;
  const m = answer.match(rxStart);
  if (!m) return [];
  const startIdx = m.index + m[0].length;
  const block = answer.slice(startIdx);

  // Items like:
  // 1) ARTICLE: <...>
  //    QUOTE: "<...>"
  const rxItem = /\d+\)\s*ARTICLE:\s*([^\n]+?)\s*\n\s*QUOTE:\s*"([^"]{12,400})"/gi;
  const items = [];
  let mm;
  while ((mm = rxItem.exec(block))) {
    const article = mm[1].trim();
    const quote = mm[2].trim();
    if (article && quote) items.push({ article, quote });
    if (items.length >= 4) break;
  }
  return items;
}

// ---------------- Articles (ranges) ----------------
function pageStartSlice(text) { return norm((text || "").slice(0, 900)); }
function detectArticleTitle(slice) {
  const m = slice.match(/\barticle\s+[ivxlc]+\b[^\n]{0,120}/i);
  return m ? m[0].trim().replace(/\s+/g, " ") : null;
}
function buildArticleRanges(pages) {
  const starts = [];
  for (const p of pages) {
    const head = detectArticleTitle(pageStartSlice(p.text));
    if (head) starts.push({ page: p.num, title: head.replace(/^article\s+/i, m=>m.toUpperCase()) });
  }
  starts.sort((a,b)=>a.page-b.page);
  const ranges = [];
  for (let i=0;i<starts.length;i++){
    const start = starts[i].page;
    const end   = (i+1<starts.length) ? (starts[i+1].page - 1) : (pages[pages.length-1].num);
    ranges.push({ start, end, title: `Article ${starts[i].title.replace(/^ARTICLE\s+/i,"")}`.trim() });
  }
  return ranges;
}
function rangeForPage(ranges, page){ return ranges.find(r=>page>=r.start && page<=r.end) || null; }
function rangeForArticleLabel(ranges, label){
  const roman = (label||"").match(/article\s+([ivxlc]+)/i)?.[1] || null;
  if (!roman) return null;
  return ranges.find(r => r.title.toLowerCase().startsWith(`article ${roman.toLowerCase()}`)) || null;
}

// ---------------- Quote → page mapping ----------------
function exactIndexOf(haystack, needle){
  const H = norm(haystack); const N = norm(needle);
  return H.indexOf(N);
}
function fuzzyBestIndex(haystack, quote){
  // token-window overlap: choose the window (len ≈ quote tokens) with max overlap
  const H = strip(haystack); const Q = tokenize(quote);
  if (!Q.length) return -1;
  const hTokens = H.split(/\s+/).filter(Boolean);
  const window = Math.max(6, Math.min(Q.length + 6, 40));
  let best = { idx: -1, score: -1 };
  for (let i=0;i<=Math.max(0,hTokens.length-window);i++){
    const w = hTokens.slice(i, i+window);
    const set = new Set(w);
    let s = 0; for (const t of Q) if (set.has(t)) s++;
    if (s > best.score) best = { idx: i, score: s };
  }
  if (best.score < Math.ceil(Q.length * 0.55)) return -1; // require 55% token overlap
  // convert token index back to char index (approx)
  const charPos = hTokens.slice(0, best.idx).join(" ").length;
  return Math.max(0, charPos);
}

function findQuoteOnPages(quote, pages, preferRange) {
  const candidates = preferRange ? pages.filter(p => p.num >= preferRange.start && p.num <= preferRange.end) : pages;

  // Pass 1: exact normalized
  for (const p of candidates) {
    const i = exactIndexOf(p.text, quote);
    if (i >= 0) return { page: p.num, idx: i, text: p.text };
  }
  // Pass 2: fuzzy token-window
  let best = null;
  for (const p of candidates) {
    const i = fuzzyBestIndex(p.text, quote);
    if (i >= 0) { best = { page: p.num, idx: i, text: p.text }; break; }
  }
  // Pass 3: search globally if restricted range failed
  if (!best && preferRange) {
    for (const p of pages) {
      const i = exactIndexOf(p.text, quote);
      if (i >= 0) return { page: p.num, idx: i, text: p.text };
    }
    for (const p of pages) {
      const i = fuzzyBestIndex(p.text, quote);
      if (i >= 0) return { page: p.num, idx: i, text: p.text };
    }
  }
  return best; // may be null
}

function snippetAround(text, idx) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - 260);
  const end   = Math.min(normalized.length, idx + 280);
  return trimWords(normalized.slice(start, end), 25, 45);
}

// ---------------- main ----------------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz") {
  // Load pages
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  const articleRanges = buildArticleRanges(pages);

  // Parse LEGAL_EXCERPTS from the model
  const items = parseLegalExcerpts(answerText);
  const quotes = items.length ? items : []; // if empty we'll fallback

  const bullets = [];
  const foundHits = [];

  // Map each quote → best page (prefer its declared Article range, if parseable)
  for (const it of quotes.slice(0,4)) {
    const prefer = rangeForArticleLabel(articleRanges, it.article);
    const hit = findQuoteOnPages(it.quote, pages, prefer);
    if (!hit) continue;

    const rng = rangeForPage(articleRanges, hit.page);
    const heading = rng?.title || it.article || "";
    const snip = snippetAround(hit.text, hit.idx);
    bullets.push(`• Page ${hit.page} — [Open page](${pdfHref}#page=${hit.page}) — “${snip}”${heading ? ` — ${heading}` : ""}`);
    foundHits.push({ page: hit.page, heading });
  }

  // Fallback: if nothing found, fall back to a light BM25 over the whole doc using the question+answer text
  if (!bullets.length) {
    // lightweight BM25 (only for absolute fallback)
    const idx = pages.map(p=>{
      const lower = norm(p.text); const toks = lower.replace(/[^a-z0-9' -]/g," ").split(/\s+/).filter(Boolean);
      return { num:p.num, text:p.text, toks, len:toks.length, lower };
    });
    const qTokens = tokenize(`${questionText || ""} ${answerText || ""}`);
    const bigs = bigrams(qTokens);
    const N=idx.length, k1=1.5, b=0.75;
    const dfT = new Map(); const dfB = new Map();
    const uniqT=[...new Set(qTokens)], uniqB=[...new Set(bigs)];
    for (const t of uniqT) dfT.set(t,0);
    for (const bg of uniqB) dfB.set(bg,0);
    for (const p of idx){
      const setT = new Set(p.toks), setB = new Set(); for (let i=0;i<p.toks.length-1;i++) setB.add(p.toks[i]+" "+p.toks[i+1]);
      for (const t of uniqT) if (setT.has(t)) dfT.set(t, (dfT.get(t)||0)+1);
      for (const bg of uniqB) if (setB.has(bg)) dfB.set(bg, (dfB.get(bg)||0)+1);
    }
    const avgdl = idx.reduce((s,p)=>s+p.len,0)/Math.max(1,N);
    const idf=n=>Math.log((N-n+0.5)/(n+0.5)+1);
    const scores = idx.map(p=>{
      let s=0;
      for (const t of uniqT){ const n=dfT.get(t)||0; if (!n) continue; let tf=0; for (const w of p.toks) if (w===t) tf++;
        if (!tf) continue; const denom=tf + k1*(1-b + b*(p.len/avgdl)); s += idf(n) * ((tf*(k1+1))/denom); }
      for (const bg of uniqB){ const n=dfB.get(bg)||0; if (!n) continue; let tf=0; for (let i=0;i<p.toks.length-1;i++) if ((p.toks[i]+" "+p.toks[i+1])===bg) tf++;
        if (!tf) continue; const denom=tf + k1*(1-b + b*(p.len/avgdl)); s += 1.5*idf(n) * ((tf*(k1+1))/denom); }
      return { num:p.num, s };
    }).sort((a,b)=>b.s-a.s).slice(0,1);

    if (scores.length){
      const pg = pages.find(x=>x.num===scores[0].num);
      const rng = rangeForPage(articleRanges, pg.num);
      const heading = rng?.title || "";
      const snip = snippetAround(pg.text, Math.floor(norm(pg.text).length/2));
      bullets.push(`• Page ${pg.num} — [Open page](${pdfHref}#page=${pg.num}) — “${snip}”${heading ? ` — ${heading}` : ""}`);
      foundHits.push({ page: pg.num, heading });
    }
  }

  // Build final Citation using the first bullet's page and its Article range title
  const firstPage = bullets.length ? Number(bullets[0].match(/Page\s+(\d+)/i)[1]) : 1;
  const firstHeading = (rangeForPage(articleRanges, firstPage)?.title) || (foundHits[0]?.heading) || "";
  const citation = `Citation: CBA (2022–2026)${firstHeading ? `, ${firstHeading}` : ""}; Page ${firstPage} — [Open page](${pdfHref}#page=${firstPage})`;

  // Inject (strip any preexisting "Citation:" block from the model)
  const base = String(answerText || "").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citation}\n\n—— Source text ——\n${bullets.join("\n")}`.trim();

  return { text, page: firstPage };
}

module.exports = { attachVerification };
