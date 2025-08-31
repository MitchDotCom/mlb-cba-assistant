// lib/pdfIndex.js
// FINAL: Article-locked quote verifier.
// - Parses LEGAL_EXCERPTS from the model.
// - Maps each QUOTE to exact page(s) in /public/mlb/MLB_CBA_2022.pdf.
// - Computes Article ranges ONLY from true page titles near the top of pages:
//     "ARTICLE XXIII—Competitive Balance Tax" (dash required).
// - Citation + bullets ALWAYS use the Article title from the range of the first hit.
// - No headings are taken from inline cross-references like "Article XIX(E)".

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
  for (let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent({ normalizeWhitespace:true });
    const joined = content.items.map(it=>it.str||"").join(" ");
    // de-hyphenate split words like "Sec- tion"
    const dehy   = joined.replace(/\b([A-Za-z]{2,})-\s+([A-Za-z]{2,})\b/g, "$1$2");
    const text   = dehy.replace(/\s+/g," ").trim();
    pages.push({ num:i, text });
  }
  return pages;
}

// ---------- utils ----------
const norm  = s => (s||"").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g," ").trim();
function trimWords(s, minW, maxW){
  const words = s.split(/\s+/); if (words.length<=maxW) return s.trim();
  const mid=Math.floor(words.length/2), span=Math.max(minW,Math.min(maxW,45));
  return words.slice(Math.max(0,mid-Math.floor(span/2)), Math.max(0,mid-Math.floor(span/2))+span).join(" ").trim();
}

// ---------- LEGAL_EXCERPTS parser ----------
function parseLegalExcerpts(answer){
  const m = answer.match(/(?:^|\n)LEGAL_EXCERPTS:\s*\n/i);
  if (!m) return [];
  const block = answer.slice(m.index + m[0].length);
  const rx = /\d+\)\s*ARTICLE:\s*([^\n]+?)\s*\n\s*QUOTE:\s*"([^"]{12,400})"/gi;
  const items = []; let mm;
  while ((mm = rx.exec(block))) {
    const article = mm[1].trim(); const quote = mm[2].trim();
    if (article && quote) items.push({ article, quote });
    if (items.length >= 4) break;
  }
  return items;
}

// ---------- Article ranges (strict top-of-page titles only) ----------
// We ONLY accept titles that look like "ARTICLE XXIII—Competitive Balance Tax" (dash required).
function detectMainTitleTop(text){
  const top = (text || "").slice(0, 800);               // only look near top of page
  // Require a dash after the Roman numeral to avoid cross-references like "Article XIX(E)"
  const m = top.match(/\bARTICLE\s+([IVXLC]+)\s*[—-]\s*([A-Z][A-Za-z0-9 ,&/()'’\-]{3,})/);
  if (!m) return null;
  const roman = m[1].toUpperCase();
  const title = m[2].trim().replace(/\s+/g," ");
  return `ARTICLE ${roman}—${title}`;
}
function buildArticleRanges(pages){
  const starts=[];
  for (const p of pages){
    const title = detectMainTitleTop(p.text);
    if (title) starts.push({ page:p.num, title });
  }
  // If no titles found (rare), we won't article-lock; ranges stays empty.
  starts.sort((a,b)=>a.page-b.page);
  const ranges=[];
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

// ---------- quote → page mapping ----------
function exactIndexOf(hay, needle){ return norm(hay).indexOf(norm(needle)); }
function fuzzyIndex(hay, quote){
  const H = norm(hay); const Q = norm(quote);
  const qToks = Q.replace(/[^a-z0-9' -]/g,"").split(/\s+/).filter(Boolean);
  if (!qToks.length) return -1;
  const hToks = H.replace(/[^a-z0-9' -]/g,"").split(/\s+/).filter(Boolean);
  const win = Math.max(6, Math.min(qToks.length + 6, 42));
  let best = { i:-1, s:-1 };
  for (let i=0;i<=Math.max(0,hToks.length-win);i++){
    const w = hToks.slice(i,i+win); const set=new Set(w);
    let s=0; for (const t of qToks) if (set.has(t)) s++;
    if (s>best.s) best={ i, s };
  }
  if (best.s < Math.ceil(qToks.length * 0.55)) return -1;
  const pos = hToks.slice(0,best.i).join(" ").length;
  return Math.max(0,pos);
}
function findQuote(quote, pages, preferRange){
  const pool = preferRange ? pages.filter(p=>p.num>=preferRange.start && p.num<=preferRange.end) : pages;
  for (const p of pool){ const i = exactIndexOf(p.text, quote); if (i>=0) return { p, idx:i }; }
  for (const p of pool){ const i = fuzzyIndex(p.text, quote); if (i>=0) return { p, idx:i }; }
  if (preferRange){
    for (const p of pages){ const i = exactIndexOf(p.text, quote); if (i>=0) return { p, idx:i }; }
    for (const p of pages){ const i = fuzzyIndex(p.text, quote); if (i>=0) return { p, idx:i }; }
  }
  return null;
}
function snippetAround(text, idx){
  const t = (text||"").replace(/\s+/g," ").trim();
  const start = Math.max(0, idx - 260), end = Math.min(t.length, idx + 280);
  return trimWords(t.slice(start,end), 25, 45);
}

// ---------- main ----------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz"){
  // Load pages
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // Build Article ranges from TRUE titles at the top of pages (dash required)
  let ranges = buildArticleRanges(pages);

  // If ranges are empty (some JSONs miss headers), compute from the PDF text directly
  if (!ranges.length) {
    const pdfPages = await loadPdfText(origin, pdfHref);
    ranges = buildArticleRanges(pdfPages);
    if (pdfPages.length && (!pages || !pages.length)) pages = pdfPages;
  }

  // Parse LEGAL_EXCERPTS
  const items = parseLegalExcerpts(answerText).slice(0,4);

  const bullets = [];
  const usedPages = new Set();
  const foundHits = [];

  for (const it of items){
    const prefer = rangeForArticleGuess(ranges, it.article);
    const hit = findQuote(it.quote, pages, prefer);
    if (!hit) continue;

    const snip = snippetAround(hit.p.text, hit.idx);
    if (!usedPages.has(hit.p.num)){
      const r = rangeForPage(ranges, hit.p.num);
      const title = r?.title || "";
      bullets.push(`• Page ${hit.p.num} — [Open page](${pdfHref}#page=${hit.p.num}) — “${snip}”${title ? ` — ${title}` : ""}`);
      usedPages.add(hit.p.num);
      foundHits.push({ page: hit.p.num, title });
    }
    if (bullets.length >= 4) break;
  }

  // Absolute fallback: if no quotes mapped, pick first page that has a true Article title and center a snippet
  if (!bullets.length){
    const pWithTitle = pages.find(p => detectMainTitleTop(p.text));
    if (pWithTitle){
      const snip = snippetAround(pWithTitle.text, Math.floor(norm(pWithTitle.text).length/2));
      const r = rangeForPage(ranges, pWithTitle.num);
      const title = r?.title || detectMainTitleTop(pWithTitle.text) || "";
      bullets.push(`• Page ${pWithTitle.num} — [Open page](${pdfHref}#page=${pWithTitle.num}) — “${snip}”${title ? ` — ${title}` : ""}`);
      foundHits.push({ page: pWithTitle.num, title });
    } else if (pages.length){
      const p = pages[0];
      const snip = snippetAround(p.text, Math.floor(norm(p.text).length/2));
      bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snip}”`);
      foundHits.push({ page: p.num, title: "" });
    }
  }

  // Citation uses the FIRST bullet's page and its Article RANGE title (never inline cross-refs)
  const firstPage = bullets.length ? Number(bullets[0].match(/Page\s+(\d+)/i)[1]) : 1;
  const firstRange = rangeForPage(ranges, firstPage);
  const citationTitle = firstRange?.title || "";
  const citation = `Citation: CBA (2022–2026)${citationTitle ? `, ${citationTitle}` : ""}; Page ${firstPage} — [Open page](${pdfHref}#page=${firstPage})`;

  // Inject (strip any model-provided "Citation:" tail first)
  const base = String(answerText||"").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citation}\n\n—— Source text ——\n${bullets.join("\n")}`.trim();

  return { text, page: firstPage };
}

module.exports = { attachVerification };
