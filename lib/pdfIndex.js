// lib/pdfIndex.js
// Deterministic, no hardcoded topic hints.
// Finds supporting page using: (1) quoted fragments, (2) user-question tokens, (3) bigrams.
// Prefers /public/mlb/cba_pages.json if available; falls back to PDF text via pdfjs-dist.

const fs = require("fs");
const path = require("path");

// -------------------- load helpers --------------------
async function loadFromPublic(relPath) {
  const diskPath = path.join(process.cwd(), "public", relPath.replace(/^\//, ""));
  try {
    const buf = fs.readFileSync(diskPath);
    return new Uint8Array(buf);
  } catch (_) {
    return null;
  }
}

async function fetchAsUint8(origin, relPath) {
  const r = await fetch(`${origin}${relPath}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${relPath}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

async function loadTextIndex(origin) {
  // Try cba_pages.json first (fast, deterministic)
  try {
    const disk = await loadFromPublic("/mlb/cba_pages.json");
    let raw;
    if (disk) raw = Buffer.from(disk).toString("utf8");
    else {
      const u8 = await fetchAsUint8(origin, "/mlb/cba_pages.json");
      raw = Buffer.from(u8).toString("utf8");
    }
    const json = JSON.parse(raw);
    // Accept either {pages:[{page,text}...]} or [{page,text}...]
    const arr = Array.isArray(json) ? json : Array.isArray(json.pages) ? json.pages : [];
    if (arr.length) return arr.map(p => ({ num: p.page || p.num || p.id || 1, text: (p.text || "").toString() }));
  } catch (_) {}
  return null;
}

async function loadPdfText(origin, pdfHref) {
  const getPdfJs = async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
    pdfjs.GlobalWorkerOptions.workerSrc = require("pdfjs-dist/legacy/build/pdf.worker.js");
    return pdfjs;
  };
  const fromDisk = await loadFromPublic(pdfHref);
  const bytes = fromDisk || (await fetchAsUint8(origin, pdfHref));

  const pdfjs = await getPdfJs();
  const loading = pdfjs.getDocument({ data: bytes });
  const pdf = await loading.promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent({ normalizeWhitespace: true });
    const text = content.items.map(it => it.str || "").join(" ").replace(/\s+/g, " ").trim();
    pages.push({ num: i, text });
  }
  return pages;
}

// -------------------- text utils --------------------
const STOP = new Set([
  "the","and","for","with","that","this","from","into","such","shall","have","has","are","was","were","will","may",
  "can","not","than","then","there","their","they","them","his","her","its","also","within","about","over",
  "to","of","in","on","by","as","a","an","or","at","be","is","it","if","but","so","do","does","did"
]);

function norm(s) { return (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g,' ').trim(); }
function tokenize(s) {
  return norm(s).replace(/[^a-z0-9'"\- ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w) && w.length >= 3);
}
function bigrams(tokens) {
  const out = [];
  for (let i=0;i<tokens.length-1;i++) out.push(tokens[i]+" "+tokens[i+1]);
  return out;
}
function pickQuoted(s) {
  const out = [];
  const rx = /"([^"]{6,240})"/g; let m;
  while ((m = rx.exec(s)) && out.length < 4) out.push(m[1].trim());
  return out;
}

// -------------------- scoring --------------------
function scorePage(pageText, phrases, qTokens, qBigrams, ansTokens) {
  const text = norm(pageText);
  let score = 0;

  // exact phrase matches (heavy weight, best signal)
  for (const p of phrases) {
    if (!p) continue;
    const needle = norm(p);
    if (needle && text.includes(needle)) score += 40 + Math.min(needle.length, 120) / 6;
  }

  // bigrams from the question (medium weight)
  for (const bg of qBigrams) {
    if (bg.length < 7) continue;
    if (text.includes(bg)) score += 8;
  }

  // token overlap from question + from assistant answer (light/medium)
  const seen = new Set();
  for (const t of qTokens) {
    if (seen.has(t)) continue; seen.add(t);
    if (text.includes(t)) score += 3;
  }
  for (const t of ansTokens) {
    if (seen.has(t)) continue; seen.add(t);
    if (text.includes(t)) score += 2;
  }

  // reward presence of structural cues
  if (/ARTICLE\s+[IVXLC]+\b/i.test(pageText)) score += 1.5;
  if (/\bSection\s+[A-Za-z0-9().-]+\b/.test(pageText)) score += 1.5;

  return score;
}

function chooseBestPage(pages, question, answer) {
  const qTokens = tokenize(question).slice(0, 40);
  const qBigrams = bigrams(qTokens).slice(0, 20);

  // Use assistant’s own words, no hardcoded topics
  const phrases = [...pickQuoted(answer), ...pickQuoted(question)].slice(0, 4);
  const ansTokens = tokenize(answer).slice(0, 40);

  let best = { num: 1, text: pages[0]?.text || "", score: -1 };

  for (const p of pages) {
    const s = scorePage(p.text, phrases, qTokens, qBigrams, ansTokens);
    if (s > best.score) best = { num: p.num, text: p.text, score: s };
  }

  // If extremely weak, just fall back to the longest exact-token density window
  if (best.score < 6) {
    // pick page with max hits of top 10 qTokens
    const keys = qTokens.slice(0, 10);
    let alt = best;
    for (const p of pages) {
      let hits = 0;
      const T = norm(p.text);
      for (const k of keys) if (T.includes(k)) hits++;
      if (hits > (alt.hits || 0)) alt = { ...p, score: hits * 2, hits };
    }
    if ((alt.hits || 0) > 0) best = alt;
  }

  return best;
}

function detectHeading(text) {
  const art = text.match(/ARTICLE\s+[IVXLC]+\b[^\n]{0,80}/i);
  const sec = text.match(/\bSection\s+[A-Za-z0-9().-]+\b[^\n]{0,80}/i);
  return { article: art ? art[0].trim() : null, section: sec ? sec[0].trim() : null };
}

function buildSnippet(pageText, question, answer, phrases) {
  const tx = pageText.replace(/\s+/g, " ").trim();
  // prefer centering on first phrase hit
  for (const p of phrases) {
    const needle = norm(p);
    if (!needle) continue;
    const i = norm(tx).indexOf(needle);
    if (i >= 0) {
      const start = Math.max(0, i - 250);
      const end = Math.min(tx.length, i + Math.max(250, needle.length + 80));
      return trimWords(tx.slice(start, end), 26, 42);
    }
  }
  // else center near densest region of question tokens
  const tokens = tokenize(question);
  let best = { idx: Math.floor(tx.length / 2), score: 0 };
  for (let i = 0; i < tx.length; i += 220) {
    const slice = tx.slice(i, Math.min(tx.length, i + 440)).toLowerCase();
    let s = 0;
    for (const t of tokens) if (slice.includes(t)) s++;
    if (s > best.score) best = { idx: i + 200, score: s };
  }
  const start = Math.max(0, best.idx - 220);
  const end = Math.min(tx.length, best.idx + 220);
  return trimWords(tx.slice(start, end), 26, 42);
}

function trimWords(s, minW, maxW) {
  const words = s.split(/\s+/);
  if (words.length <= maxW) return s.trim();
  const mid = Math.floor(words.length / 2);
  const span = Math.max(minW, Math.min(maxW, 36));
  const start = Math.max(0, mid - Math.floor(span / 2));
  return words.slice(start, start + span).join(" ").trim();
}

function injectBlocks(answerText, citationLine, sourceBlock) {
  // Drop any existing "Citation:" onwards and replace with our canonical blocks.
  const rx = /(?:^|\n)Citation:[\s\S]*$/i;
  const base = answerText.replace(rx, "").trim();
  return `${base}\n\n${citationLine}\n\n${sourceBlock}`.trim();
}

// -------------------- main export --------------------
async function attachVerification(answerText, questionText, pdfHref = "/mlb/MLB_CBA_2022.pdf", origin = "https://mlb.mitchleblanc.xyz") {
  // 1) Load page texts (JSON index -> PDF fallback)
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // 2) Choose best page with NO topic hints
  const best = chooseBestPage(pages, questionText || "", answerText || "");

  // 3) Build meta + snippet
  const { article, section } = detectHeading(best.text || "");
  const heading = section || article || "";
  const phrases = [...pickQuoted(answerText), ...pickQuoted(questionText)];
  const snippet = buildSnippet(best.text || "", questionText || "", answerText || "", phrases);

  // 4) Compose canonical blocks
  const pageLink = `${pdfHref}#page=${best.num}`;
  const citationLine = `Citation: CBA (2022–2026)${heading ? `, ${heading}` : ""}; Page ${best.num} — [Open page](${pageLink})`;
  const sourceBlock = `—— Source text ——\n• Page ${best.num} — Open page — “${snippet}”${heading ? ` — ${heading}` : ""}`;

  // 5) Inject + return
  const text = injectBlocks(answerText || "", citationLine, sourceBlock);
  return { text, page: best.num };
}

module.exports = { attachVerification };
