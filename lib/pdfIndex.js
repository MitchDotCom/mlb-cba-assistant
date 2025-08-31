// lib/pdfIndex.js
// Article-locked, BM25-based linker (NO hardcoded topics).
// Output: one Citation line + 1–4 Source bullets, each with its own [Open page] link.
// All bullets are constrained to the same Article range as the top-scoring page.

const fs = require("fs");
const path = require("path");

// ---------------- I/O helpers ----------------
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
    // join, normalize, and de-hyphenate split words like "whatso- ever"
    const joined = content.items.map(it => it.str || "").join(" ");
    const dehy = joined.replace(/\b([A-Za-z]{2,})-\s+([A-Za-z]{2,})\b/g, "$1$2");
    const text = dehy.replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
  }
  return pages;
}

// ---------------- text utils ----------------
const STOP = new Set([
  "the","and","for","with","that","this","from","into","such","shall","have","has","are","was","were","will","may",
  "can","not","than","then","there","their","they","them","his","her","its","also","within","about","over","between",
  "to","of","in","on","by","as","a","an","or","at","be","is","it","if","but","so","do","does","did","after","before",
  "player","club","season","contract","agreement","time","days","year","years","list","roster","major","minor" // too common
]);
const norm = s => (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g," ").trim();
function tokenize(s) {
  return norm(s).replace(/[^a-z0-9'"\- ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w) && w.length >= 3);
}
function bigrams(tokens) { const out=[]; for (let i=0;i<tokens.length-1;i++) out.push(tokens[i]+" "+tokens[i+1]); return out; }
function pickQuoted(s) { const out=[]; const rx=/"([^"]{6,260})"/g; let m; while((m=rx.exec(s))&&out.length<6) out.push(m[1].trim()); return out; }

// ---------------- headings / Article ranges ----------------
function pageStartSlice(text) { return norm((text || "").slice(0, 900)); }
function detectArticleTitle(slice) {
  // e.g., "article xxiii—competitive balance tax", "article xix (something)"
  const m = slice.match(/\barticle\s+[ivxlc]+\b[^\n]{0,120}/i);
  return m ? m[0].trim().replace(/\s+/g," ") : null;
}
function buildArticleRanges(pages) {
  // Find pages that begin a new ARTICLE; set ranges [start, end]
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
function articleForPage(ranges, pageNum) {
  for (const r of ranges) if (pageNum >= r.start && pageNum <= r.end) return r;
  return null;
}

// ---------------- build searchable page index ----------------
function buildPageIndex(pages){
  const idx = pages.map(p=>{
    const lower = norm(p.text);
    const words = lower.replace(/[^a-z0-9' -]/g," ").split(/\s+/).filter(Boolean);
    const toks = words;
    const bigs = []; for (let i=0;i<toks.length-1;i++) bigs.push(toks[i]+" "+toks[i+1]);
    return { num: p.num, text: p.text, lower, toks, bigs, len: toks.length };
  });
  return idx;
}
function dfMap(idx, terms, isBigram=false){
  const df=new Map(); for (const t of terms){ df.set(t,0); }
  for (const p of idx){
    const set = new Set(isBigram ? p.bigs : p.toks);
    for (const t of terms) if (set.has(t)) df.set(t, df.get(t)+1);
  }
  return df;
}

// ---------------- BM25 scoring with rare-term HARD GATE ----------------
function bm25Score(idx, queryTokens, queryBigrams){
  const N = idx.length, k1=1.5, b=0.75;
  const uniqT = [...new Set(queryTokens)];
  const uniqB = [...new Set(queryBigrams)];
  const dfT = dfMap(idx, uniqT, false);
  const dfB = dfMap(idx, uniqB, true);
  const avgdl = idx.reduce((s,p)=>s+p.len,0)/Math.max(1,N);
  const idf = n => Math.log((N - n + 0.5)/(n + 0.5) + 1);

  // pick 2 rarest tokens (highest IDF) for the HARD gate
  const gated = [...uniqT].sort((a,b)=>(idf(dfT.get(b)||0)) - (idf(dfT.get(a)||0))).slice(0,2);

  const scores = idx.map(p=>{
    // must contain at least one rare gated token
    let hasRare=false; for (const g of gated){ if (g && p.lower.includes(g)) { hasRare=true; break; } }
    if (!hasRare) return { num: p.num, score: -1e9 };

    let s=0;
    for (const t of uniqT){
      const n = dfT.get(t)||0; if (!n) continue;
      const idf_t = idf(n);
      let tf=0; for (const w of p.toks) if (w===t) tf++;
      if (!tf) continue;
      const denom = tf + k1*(1 - b + b*(p.len/avgdl));
      s += idf_t * ((tf*(k1+1))/denom);
    }
    for (const bg of uniqB){
      const n = dfB.get(bg)||0; if (!n) continue;
      const idf_bg = idf(n);
      let tf=0; for (const w of p.bigs) if (w===bg) tf++;
      if (!tf) continue;
      const denom = tf + k1*(1 - b + b*(p.len/avgdl));
      s += 1.5 * idf_bg * ((tf*(k1+1))/denom);
    }
    // small structure bonus
    if (/article\s+[ivxlc]+\b/.test(p.lower)) s += 0.8;
    if (/\bsection\s+[a-z0-9().-]+\b/.test(p.lower)) s += 0.6;
    return { num: p.num, score: s };
  });

  scores.sort((a,b)=>b.score - a.score);
  const top = scores[0]?.score ?? -1e9;
  // keep strong contenders (>= 45% of top) up to 6
  const keep = scores.filter(s=>s.score >= top*0.45).slice(0,6).filter(s=>s.score>-1e8);
  return keep;
}

// ---------------- snippet helpers ----------------
function findBestHitPos(p, phrases, bigs, toks){
  const L = p.lower;
  for (const ph of phrases){ const q = norm(ph); const i=L.indexOf(q); if (i>=0) return i; }
  for (const bg of bigs){ const i=L.indexOf(bg); if (i>=0) return i; }
  for (const t of toks){ const i=L.indexOf(t); if (i>=0) return i; }
  return Math.floor(L.length/2);
}
function snippetAround(p, center){
  const text = p.text.replace(/\s+/g," ").trim();
  // approximate center mapping
  const ratio = Math.max(0, Math.min(1, center / Math.max(1, p.lower.length)));
  const mid = Math.floor(text.length * ratio);
  const start = Math.max(0, mid - 260);
  const end = Math.min(text.length, mid + 280);
  const words = text.slice(start, end).split(/\s+/);
  if (words.length <= 45) return text.slice(start, end).trim();
  const m = Math.floor(words.length/2);
  return words.slice(Math.max(0,m-20), Math.max(0,m-20)+40).join(" ").trim();
}

// ---------------- main ----------------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz"){
  // load pages
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // build index + article ranges
  const idx = buildPageIndex(pages);
  const articleRanges = buildArticleRanges(pages);

  // build query features (NO hints)
  const qTokens = tokenize(questionText||"");
  const aTokens = tokenize(answerText||"");
  const tokens = [...new Set([...qTokens, ...aTokens])];
  const bigs = bigrams(tokens);
  const phrases = [...pickQuoted(answerText), ...pickQuoted(questionText)].slice(0,6);

  // rank pages
  const winners = bm25Score(idx, tokens, bigs);
  const anchor = winners[0] || { num: idx[0].num, score: -1e9 };
  const anchorRange = articleForPage(articleRanges, anchor.num) || { start: anchor.num, end: anchor.num, title: "" };

  // restrict all bullets to the anchor Article range
  const inRange = winners.filter(w => w.num >= anchorRange.start && w.num <= anchorRange.end);
  const topPages = (inRange.length ? inRange : [anchor]).slice(0,4);

  // compose bullets (1–4)
  const bullets = [];
  for (const w of topPages){
    const p = idx.find(x=>x.num===w.num);
    if (!p) continue;
    const pos = findBestHitPos(p, phrases, bigs, tokens);
    const snip = snippetAround(p, pos);
    bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snip}”`);
  }
  if (!bullets.length) {
    const p = idx[0];
    bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snippetAround(p, Math.floor(p.lower.length/2))}”`);
  }

  // citation uses anchor article title + first bullet page
  const firstPage = Number(bullets[0].match(/Page\s+(\d+)/i)[1]);
  const title = anchorRange.title ? `, ${anchorRange.title}` : "";
  const citation = `Citation: CBA (2022–2026)${title}; Page ${firstPage} — [Open page](${pdfHref}#page=${firstPage})`;

  // inject
  const base = String(answerText||"").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citation}\n\n—— Source text ——\n${bullets.join("\n")}`.trim();
  return { text, page: firstPage };
}

module.exports = { attachVerification };
