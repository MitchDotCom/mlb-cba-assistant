// lib/pdfIndex.js
// BM25-based, hint-free linker with strong rare-term gating and multi-page bullets.
// Inputs: assistant answer + user question. Output: one Citation line + 1–4 Source bullets (each with its own [Open page] link).

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
    const text = content.items.map(it => it.str || "").join(" ").replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
  }
  return pages;
}

// ---------------- text utils ----------------
const STOP = new Set([
  "the","and","for","with","that","this","from","into","such","shall","have","has","are","was","were","will","may",
  "can","not","than","then","there","their","they","them","his","her","its","also","within","about","over","between",
  "to","of","in","on","by","as","a","an","or","at","be","is","it","if","but","so","do","does","did","after","before",
  "player","club","season","contract","agreement","time","days","year","years" // too generic in this corpus
]);
const norm = s => (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g," ").trim();
function tokenize(s) {
  return norm(s).replace(/[^a-z0-9'"\- ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w) && w.length >= 3);
}
function bigrams(tokens) { const out=[]; for (let i=0;i<tokens.length-1;i++) out.push(tokens[i]+" "+tokens[i+1]); return out; }
function pickQuoted(s) { const out=[]; const rx=/"([^"]{6,260})"/g; let m; while((m=rx.exec(s))&&out.length<6) out.push(m[1].trim()); return out; }

// ---------------- headings ----------------
function detectArticle(text){ const m = text.match(/ARTICLE\s+[IVXLC]+\b[^\n]{0,120}/i); return m?m[0].trim():null; }
function detectSection(text){ const m = text.match(/\bSection\s+[A-Za-z0-9().-]+\b[^\n]{0,120}/i); return m?m[0].trim():null; }

// ---------------- build page index ----------------
function buildPageIndex(pages){
  // For each page: tokens, bigrams, term freq maps for query-time terms
  const idx = pages.map(p=>{
    const lower = norm(p.text);
    const words = lower.replace(/[^a-z0-9' -]/g," ").split(/\s+/).filter(Boolean);
    // tokens (stopwords kept out via query-side STOP)
    const toks = words;
    // bigrams
    const bigs = []; for (let i=0;i<toks.length-1;i++) bigs.push(toks[i]+" "+toks[i+1]);
    return { num: p.num, text: p.text, lower, toks, bigs, len: toks.length };
  });
  return idx;
}
function dfMap(idx, terms, isBigram=false){
  const df=new Map();
  for (const t of terms){ df.set(t,0); }
  for (const p of idx){
    const set = new Set(isBigram ? p.bigs : p.toks);
    for (const t of terms) if (set.has(t)) df.set(t, df.get(t)+1);
  }
  return df;
}

// ---------------- BM25 scoring ----------------
function bm25Score(idx, queryTokens, queryBigrams){
  const N = idx.length, k1=1.5, b=0.75;
  const uniqT = [...new Set(queryTokens)];
  const uniqB = [...new Set(queryBigrams)];
  const dfT = dfMap(idx, uniqT, false);
  const dfB = dfMap(idx, uniqB, true);
  const avgdl = idx.reduce((s,p)=>s+p.len,0)/Math.max(1,N);

  // choose rarest tokens (highest IDF) for hard gate
  function idf(n){ return Math.log((N - n + 0.5)/(n + 0.5) + 1); }
  const gated = [...uniqT].sort((a,b)=>idf(dfT.get(b)||0) - idf(dfT.get(a)||0)).slice(0,2);

  const scores = idx.map(p=>{
    // HARD GATE: must contain at least one rare token (prevents Article IV drift)
    let hasRare=false; for (const g of gated){ if (g && p.lower.includes(g)) { hasRare=true; break; } }
    if (!hasRare) return { num: p.num, score: -1e9 };

    let s=0;
    // unigrams
    for (const t of uniqT){
      const n = dfT.get(t)||0; if (!n) continue;
      const idf_t = idf(n);
      // tf
      let tf=0;
      // Count quickly by scanning toks
      for (const w of p.toks) if (w===t) tf++;
      if (!tf) continue;
      const denom = tf + k1*(1 - b + b*(p.len/avgdl));
      s += idf_t * ((tf*(k1+1))/denom);
    }
    // bigrams (bonus weight 1.5x)
    for (const bg of uniqB){
      const n = dfB.get(bg)||0; if (!n) continue;
      const idf_bg = idf(n);
      let tf=0;
      for (const w of p.bigs) if (w===bg) tf++;
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
  // keep strong contenders (>= 40% of top) up to 4
  const top = scores[0]?.score ?? -1e9;
  const keep = scores.filter(s=>s.score >= top*0.4).slice(0,4).filter(s=>s.score>-1e8);
  return keep;
}

// ---------------- snippets ----------------
function findBestHitPos(p, phrases, bigs, toks){
  const L = p.lower;
  // phrase first (approx exact)
  for (const ph of phrases){ const q = norm(ph); const i=L.indexOf(q); if (i>=0) return i; }
  // then bigrams
  for (const bg of bigs){ const i=L.indexOf(bg); if (i>=0) return i; }
  // then strongest token
  for (const t of toks){ const i=L.indexOf(t); if (i>=0) return i; }
  return Math.floor(L.length/2);
}
function snippetAround(p, center){
  const text = p.text.replace(/\s+/g," ").trim();
  // map center from lower to original by proportion (ok for plain text)
  const ratio = Math.max(0, Math.min(1, center / Math.max(1, p.lower.length)));
  const mid = Math.floor(text.length * ratio);
  const start = Math.max(0, mid - 260);
  const end = Math.min(text.length, mid + 280);
  // trim to ~25–45 words
  const words = text.slice(start, end).split(/\s+/);
  if (words.length <= 45) return text.slice(start, end).trim();
  const m = Math.floor(words.length/2);
  return words.slice(Math.max(0,m-20), Math.max(0,m-20)+40).join(" ").trim();
}

// ---------------- main ----------------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz"){
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  const idx = buildPageIndex(pages);

  // build query features from *question + answer* only (no hints)
  const qTokens = tokenize(questionText||"");
  const aTokens = tokenize(answerText||"");
  // prefer rare/meaningful content from both
  const tokens = [...new Set([...qTokens, ...aTokens])];
  const bigs = bigrams(tokens); // bigrams over token stream (better alignment than raw text)
  const phrases = [...pickQuoted(answerText), ...pickQuoted(questionText)].slice(0,6);

  // rank pages
  const winners = bm25Score(idx, tokens, bigs);
  const topPages = winners.length ? winners : [{ num: idx[0].num, score: -1e9 }];

  // compose bullets (1–4)
  const bullets = [];
  for (const w of topPages){
    const p = idx.find(x=>x.num===w.num);
    if (!p) continue;
    const pos = findBestHitPos(p, phrases, bigs, tokens);
    const snip = snippetAround(p, pos);
    bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snip}”`);
  }
  if (!bullets.length){
    // absolute fallback: center of page 1
    const p = idx[0];
    bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snippetAround(p, Math.floor(p.lower.length/2))}”`);
  }

  // Citation from first bullet + heading
  const first = idx.find(x=>x.num === Number(bullets[0].match(/Page\s+(\d+)/i)[1])) || idx[0];
  const art = detectArticle(first.text);
  const sec = detectSection(first.text);
  const heading = sec || art || "";
  const citation = `Citation: CBA (2022–2026)${heading?`, ${heading}`:""}; Page ${first.num} — [Open page](${pdfHref}#page=${first.num})`;

  // inject (remove any existing "Citation:" onwards first)
  const base = String(answerText||"").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citation}\n\n—— Source text ——\n${bullets.join("\n")}`.trim();

  return { text, page: first.num };
}

module.exports = { attachVerification };
