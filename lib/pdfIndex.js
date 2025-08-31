// lib/pdfIndex.js
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

// ---------- Article detection ----------
function detectArticleTitleAnywhere(text){
  // capture full title line if present anywhere on page
  const m = text.match(/\bARTICLE\s+[IVXLC]+\b[^\n]{0,140}/i);
  return m ? m[0].replace(/\s+/g," ").trim() : null;
}
function buildArticleStarts(pages){
  const starts=[];
  for (const p of pages){
    // look at top and whole page
    const headTop = (p.text || "").slice(0,1000);
    const title = detectArticleTitleAnywhere(headTop);
    if (title) starts.push({ page:p.num, title });
  }
  // If nothing captured at page tops (index JSON sometimes misses headings),
  // scan whole doc and keep first occurrence per article roman.
  const seen = new Set();
  for (const p of pages){
    const any = detectArticleTitleAnywhere(p.text || "");
    if (any){
      const roman = any.match(/\bARTICLE\s+([IVXLC]+)/i)?.[1]?.toUpperCase();
      if (roman && !seen.has(roman)){
        if (!starts.find(s=>s.title.toUpperCase().includes(`ARTICLE ${roman}`))) {
          starts.push({ page:p.num, title:any });
          seen.add(roman);
        }
      }
    }
  }
  starts.sort((a,b)=>a.page-b.page);
  const ranges=[];
  for (let i=0;i<starts.length;i++){
    const start=starts[i].page;
    const end=(i+1<starts.length)?(starts[i+1].page-1):pages[pages.length-1].num;
    ranges.push({ start, end, title: starts[i].title.replace(/^ARTICLE\s+/i, m=>m.toUpperCase()) });
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
  return ranges.find(r => r.title.toUpperCase().includes(`ARTICLE ${roman}`)) || null;
}

// ---------- quote mapping ----------
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
function snippetAround(text, idx){
  const t = (text||"").replace(/\s+/g," ").trim();
  const start = Math.max(0, idx - 260), end = Math.min(t.length, idx + 280);
  return trimWords(t.slice(start,end), 25, 45);
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

// ---------- main ----------
async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf", origin="https://mlb.mitchleblanc.xyz"){
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  const ranges = buildArticleStarts(pages);

  // 1) Parse LEGAL_EXCERPTS
  const items = parseLegalExcerpts(answerText);
  const quotes = items.slice(0,4);

  const bulletsRaw = [];
  const usedPages = new Set();

  // 2) Map each quote to a page (prefer the model’s Article range ONLY for narrowing)
  for (const it of quotes){
    const prefer = rangeForArticleGuess(ranges, it.article);
    const hit = findQuote(it.quote, pages, prefer);
    if (!hit) continue;

    // Extract REAL article title from the hit page or nearest prior page
    let title = detectArticleTitleAnywhere(hit.p.text);
    if (!title){
      // walk back up to 3 pages to find the most recent ARTICLE heading
      for (let back=1; back<=3; back++){
        const prev = pages.find(pp => pp.num === hit.p.num - back);
        if (prev){
          title = detectArticleTitleAnywhere(prev.text);
          if (title) break;
        }
      }
      // else, fall back to range title if available
      if (!title){
        const r = rangeForPage(ranges, hit.p.num);
        title = r?.title || "";
      }
    }

    const snip = snippetAround(hit.p.text, hit.idx);
    if (!usedPages.has(hit.p.num)){
      bulletsRaw.push({ page: hit.p.num, title, snip });
      usedPages.add(hit.p.num);
    }
    if (bulletsRaw.length >= 4) break;
  }

  // 3) Fallback: if no quotes mapped, pick the first page that clearly shows an ARTICLE title and quote around it
  if (!bulletsRaw.length){
    for (const p of pages){
      const title = detectArticleTitleAnywhere(p.text);
      if (title){
        const snip = snippetAround(p.text, Math.floor(norm(p.text).length/2));
        bulletsRaw.push({ page:p.num, title, snip });
        break;
      }
    }
    if (!bulletsRaw.length){
      const p = pages[0];
      bulletsRaw.push({ page:p.num, title:"", snip:snippetAround(p.text, Math.floor(norm(p.text).length/2)) });
    }
  }

  // 4) Build bullets (unique pages only)
  const bullets = bulletsRaw.slice(0,4).map(b =>
    `• Page ${b.page} — [Open page](${pdfHref}#page=${b.page}) — “${b.snip}”${b.title ? ` — ${b.title}` : ""}`
  );

  // 5) Citation uses the FIRST bullet’s page and its REAL article title
  const first = bulletsRaw[0];
  const citation = `Citation: CBA (2022–2026)${first.title ? `, ${first.title}` : ""}; Page ${first.page} — [Open page](${pdfHref}#page=${first.page})`;

  // 6) Inject (strip any model-provided "Citation:" tail first)
  const base = String(answerText||"").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citation}\n\n—— Source text ——\n${bullets.join("\n")}`.trim();

  return { text, page: first.page };
}

module.exports = { attachVerification };
