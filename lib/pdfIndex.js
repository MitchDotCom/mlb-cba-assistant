// lib/pdfIndex.js
// Server-side linker (deterministic, NO topic hints).
// - Uses user question + assistant's own quoted fragments only.
// - Prefers /public/mlb/cba_pages.json; falls back to parsing the PDF.
// - Injects ONE Citation line and 1–4 Source bullets, each with its own [Open page](...) link.

const fs = require("fs");
const path = require("path");

// ---------------- load helpers ----------------
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
  const r = await fetch(`${origin}${relPath}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${relPath}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

async function loadTextIndex(origin) {
  try {
    const disk = await loadFromPublic("/mlb/cba_pages.json");
    let raw;
    if (disk) raw = Buffer.from(disk).toString("utf8");
    else {
      const u8 = await fetchAsUint8(origin, "/mlb/cba_pages.json");
      raw = Buffer.from(u8).toString("utf8");
    }
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json : Array.isArray(json.pages) ? json.pages : [];
    if (arr.length) {
      return arr.map(p => ({
        num: p.page || p.num || p.id || 1,
        text: (p.text || "").toString()
      }));
    }
  } catch (_) {}
  return null;
}

async function loadPdfText(origin, pdfHref) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
  pdfjs.GlobalWorkerOptions.workerSrc = require("pdfjs-dist/legacy/build/pdf.worker.js");

  const disk = await loadFromPublic(pdfHref);
  const bytes = disk || (await fetchAsUint8(origin, pdfHref));

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

// ---------------- text utils ----------------
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
  const rx = /"([^"]{6,260})"/g; let m;
  while ((m = rx.exec(s)) && out.length < 6) out.push(m[1].trim());
  return out;
}

function detectHeading(text) {
  const art = text.match(/ARTICLE\s+[IVXLC]+\b[^\n]{0,80}/i);
  const sec = text.match(/\bSection\s+[A-Za-z0-9().-]+\b[^\n]{0,80}/i);
  return { article: art ? art[0].trim() : null, section: sec ? sec[0].trim() : null };
}

function trimWords(s, minW, maxW) {
  const words = s.split(/\s+/);
  if (words.length <= maxW) return s.trim();
  const mid = Math.floor(words.length / 2);
  const span = Math.max(minW, Math.min(maxW, 42));
  const start = Math.max(0, mid - Math.floor(span / 2));
  return words.slice(start, start + span).join(" ").trim();
}

function centeredSnippet(fullText, matchIndex) {
  const tx = fullText.replace(/\s+/g, " ").trim();
  const start = Math.max(0, matchIndex - 260);
  const end = Math.min(tx.length, matchIndex + 280);
  return trimWords(tx.slice(start, end), 25, 45);
}

// ---------------- page selection ----------------
// 1) Try to map each quoted phrase to the page(s) containing it.
// 2) If none found, fall back to token/bigram scoring from the question+answer.

function phraseMatches(pages, phrase, maxHits = 1) {
  const needle = norm(phrase);
  if (!needle) return [];
  const hits = [];
  for (const p of pages) {
    const T = norm(p.text);
    const idx = T.indexOf(needle);
    if (idx >= 0) hits.push({ num: p.num, text: p.text, idx });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

function chooseBestFallback(pages, question, answer) {
  const qTokens = tokenize(question).slice(0, 40);
  const qBigrams = bigrams(qTokens).slice(0, 20);
  const ansTokens = tokenize(answer).slice(0, 40);

  function scorePage(pageText) {
    const text = norm(pageText);
    let score = 0;
    for (const bg of qBigrams) if (bg.length >= 7 && text.includes(bg)) score += 8;
    const seen = new Set();
    for (const t of qTokens) { if (!seen.has(t) && text.includes(t)) { score += 3; seen.add(t);} }
    for (const t of ansTokens) { if (!seen.has(t) && text.includes(t)) { score += 2; seen.add(t);} }
    if (/ARTICLE\s+[IVXLC]+\b/i.test(pageText)) score += 1.5;
    if (/\bSection\s+[A-Za-z0-9().-]+\b/.test(pageText)) score += 1.5;
    return score;
  }

  let best = { num: pages[0]?.num || 1, text: pages[0]?.text || "", score: -1 };
  for (const p of pages) {
    const s = scorePage(p.text);
    if (s > best.score) best = { num: p.num, text: p.text, score: s };
  }
  return best;
}

// ---------------- injector ----------------
function injectBlocks(answerText, citationLine, bulletsBlock) {
  const rx = /(?:^|\n)Citation:[\s\S]*$/i;
  const base = (answerText || "").replace(rx, "").trim();
  return `${base}\n\n${citationLine}\n\n${bulletsBlock}`.trim();
}

// ---------------- main ----------------
async function attachVerification(answerText, questionText, pdfHref = "/mlb/MLB_CBA_2022.pdf", origin = "https://mlb.mitchleblanc.xyz") {
  // Load page texts
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // Collect phrases (assistant quotes first, then any quoted in question)
  const phrases = [...pickQuoted(answerText), ...pickQuoted(questionText)].slice(0, 4);

  // Build bullets by exact phrase → page mapping
  const bullets = [];
  const usedKeys = new Set(); // de-dupe by (page# + phraseStartIdx bucket)

  for (const phrase of phrases) {
    const matches = phraseMatches(pages, phrase, 1);
    for (const m of matches) {
      const key = `${m.num}:${Math.floor(m.idx/50)}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);

      const { article, section } = detectHeading(m.text || "");
      const heading = section || article || "";

      // center the excerpt around the exact phrase match
      const plain = m.text.replace(/\s+/g, " ").trim();
      const snippet = centeredSnippet(plain, m.idx);

      const pageLink = `${pdfHref}#page=${m.num}`;
      bullets.push(`• Page ${m.num} — [Open page](${pageLink}) — “${snippet}”${heading ? ` — ${heading}` : ""}`);
      if (bullets.length >= 4) break;
    }
    if (bullets.length >= 4) break;
  }

  // If nothing matched exactly, use fallback best page with a single snippet
  let citationPage = bullets.length ? Number(bullets[0].match(/Page\s+(\d+)/i)[1]) : null;
  if (!bullets.length) {
    const best = chooseBestFallback(pages, questionText || "", answerText || "");
    const { article, section } = detectHeading(best.text || "");
    const heading = section || article || "";
    const tx = (best.text || "").replace(/\s+/g, " ").trim();

    // center near densest region of the question tokens
    const tokens = tokenize(questionText || "");
    let center = Math.floor(tx.length / 2), bestScore = -1;
    for (let i = 0; i < tx.length; i += 220) {
      const slice = tx.slice(i, Math.min(tx.length, i + 440)).toLowerCase();
      let s = 0; for (const t of tokens) if (slice.includes(t)) s++;
      if (s > bestScore) { bestScore = s; center = i + 200; }
    }
    const start = Math.max(0, center - 240);
    const end = Math.min(tx.length, center + 260);
    const snippet = trimWords(tx.slice(start, end), 25, 45);
    const pageLink = `${pdfHref}#page=${best.num}`;
    bullets.push(`• Page ${best.num} — [Open page](${pageLink}) — “${snippet}”${heading ? ` — ${heading}` : ""}`);
    citationPage = best.num;
  }

  // Citation line (use the first bullet's page)
  const firstPage = citationPage || 1;
  // also try to pull heading from that page for the Citation line
  const firstPageObj = pages.find(p => p.num === firstPage) || { text: "" };
  const h = detectHeading(firstPageObj.text || "");
  const headingForCitation = (h.section || h.article || "");

  const citationLine =
    `Citation: CBA (2022–2026)${headingForCitation ? `, ${headingForCitation}` : ""}; ` +
    `Page ${firstPage} — [Open page](${pdfHref}#page=${firstPage})`;

  const bulletsBlock = `—— Source text ——\n${bullets.join("\n")}`;

  const text = injectBlocks(answerText, citationLine, bulletsBlock);
  return { text, page: firstPage };
}

module.exports = { attachVerification };
