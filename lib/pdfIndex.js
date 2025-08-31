// lib/pdfIndex.js
// Deterministic, section-aware linker with NO hardcoded topics.
// Inputs: assistant answer text + user question text.
// Prefers /public/mlb/cba_pages.json; falls back to parsing the PDF.
// Output: canonical Citation line + 1–4 Source bullets (each with its own [Open page] link).

const fs = require("fs");
const path = require("path");

// ---------------- I/O helpers ----------------
async function loadFromPublic(relPath) {
  const diskPath = path.join(process.cwd(), "public", relPath.replace(/^\//, ""));
  try {
    const buf = fs.readFileSync(diskPath);
    return new Uint8Array(buf);
  } catch (_) { return null; }
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
    else { const u8 = await fetchAsUint8(origin, "/mlb/cba_pages.json"); raw = Buffer.from(u8).toString("utf8"); }
    const json = JSON.parse(raw);
    const arr = Array.isArray(json) ? json : Array.isArray(json.pages) ? json.pages : [];
    if (arr.length) return arr.map(p => ({ num: p.page || p.num || p.id || 1, text: (p.text || "").toString() }));
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
  "to","of","in","on","by","as","a","an","or","at","be","is","it","if","but","so","do","does","did","after","before"
]);
const norm = s => (s || "").toLowerCase().replace(/[“”]/g,'"').replace(/[’]/g,"'").replace(/\s+/g," ").trim();
function tokenize(s) {
  return norm(s).replace(/[^a-z0-9'"\- ]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w) && w.length >= 3);
}
function bigrams(tokens) {
  const out = [];
  for (let i=0;i<tokens.length-1;i++) out.push(tokens[i]+" "+tokens[i+1]);
  return out;
}
function pickQuoted(s) {
  const out = []; const rx = /"([^"]{6,260})"/g; let m;
  while ((m = rx.exec(s)) && out.length < 6) out.push(m[1].trim());
  return out;
}
function trimWords(s, minW, maxW) {
  const words = s.split(/\s+/);
  if (words.length <= maxW) return s.trim();
  const mid = Math.floor(words.length / 2);
  const span = Math.max(minW, Math.min(maxW, 45));
  const start = Math.max(0, mid - Math.floor(span / 2));
  return words.slice(start, start + span).join(" ").trim();
}

// ---------------- headings / sections ----------------
function detectArticle(line) {
  const m = line.match(/ARTICLE\s+[IVXLC]+\b[^\n]{0,120}/i);
  return m ? m[0].trim() : null;
}
function detectSection(line) {
  const m = line.match(/\bSection\s+[A-Za-z0-9().-]+\b[^\n]{0,120}/i);
  return m ? m[0].trim() : null;
}
function buildSections(pages) {
  // Build contiguous article blocks: {start,end,heading}
  const sections = [];
  let current = null;
  for (const p of pages) {
    const art = detectArticle(p.text || "");
    if (art) {
      if (current) { current.end = p.num - 1; sections.push(current); }
      current = { start: p.num, end: p.num, heading: art };
    } else if (current) {
      current.end = p.num;
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ---------------- scoring ----------------
function scoreWithinSection(sectionHeading, questionTokens) {
  // simple overlap between question tokens and article heading tokens
  const H = tokenize(sectionHeading || "");
  const S = new Set(H);
  let s = 0;
  for (const t of questionTokens) if (S.has(t)) s += 1.5;
  return s;
}
function scorePage(pageText, phrases, qTokens, qBigrams, ansTokens, mustTokens) {
  const text = norm(pageText);
  let score = 0;

  // MUST contain: at least one of top question tokens (prevents random pages)
  let hasMust = false;
  for (const t of mustTokens) { if (t && text.includes(t)) { hasMust = true; break; } }
  if (!hasMust) return -1e6; // hard reject

  // phrase matches (heavy)
  for (const p of phrases) {
    const needle = norm(p);
    if (needle && text.includes(needle)) score += 40 + Math.min(needle.length, 120)/6;
  }
  // bigrams (medium)
  for (const bg of qBigrams) { if (bg.length>=7 && text.includes(bg)) score += 8; }
  // token overlaps (light/medium)
  const seen = new Set();
  for (const t of qTokens) { if (!seen.has(t) && text.includes(t)) { score += 3; seen.add(t);} }
  for (const t of ansTokens){ if (!seen.has(t) && text.includes(t)) { score += 2; seen.add(t);} }
  // structural cues
  if (/ARTICLE\s+[IVXLC]+\b/i.test(pageText)) score += 1.2;
  if (/\bSection\s+[A-Za-z0-9().-]+\b/.test(pageText)) score += 1.2;

  return score;
}

// ---------------- selection + snippets ----------------
function centeredSnippet(fullText, centerIdx) {
  const tx = fullText.replace(/\s+/g," ").trim();
  const start = Math.max(0, centerIdx - 260);
  const end   = Math.min(tx.length, centerIdx + 280);
  return trimWords(tx.slice(start, end), 25, 45);
}
function findFirstIndex(text, needles) {
  const T = norm(text);
  let best = -1;
  for (const n of needles) {
    const i = T.indexOf(n);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  return best;
}

// ---------------- main export ----------------
async function attachVerification(answerText, questionText, pdfHref = "/mlb/MLB_CBA_2022.pdf", origin = "https://mlb.mitchleblanc.xyz") {
  // 1) Load pages (JSON -> PDF)
  let pages = await loadTextIndex(origin);
  if (!pages || !pages.length) pages = await loadPdfText(origin, pdfHref);

  // 2) Precompute sections
  const sections = buildSections(pages);

  // 3) Build query features
  const qTokensAll = tokenize(questionText || "");
  const qTokens = qTokensAll.slice(0, 40);
  const qBigrams = bigrams(qTokens).slice(0, 20);
  const phrases = [...pickQuoted(answerText), ...pickQuoted(questionText)].slice(0, 6);
  const ansTokens = tokenize(answerText || "").slice(0, 40);

  // choose top MUST tokens by length (most discriminative)
  const mustTokens = qTokens.sort((a,b)=>b.length-a.length).slice(0,3);

  // 4) Pick best-matching sections first (by heading overlap)
  let bestSection = null, bestSectionScore = -1;
  for (const s of sections) {
    const sc = scoreWithinSection(s.heading, qTokens);
    if (sc > bestSectionScore) { bestSectionScore = sc; bestSection = s; }
  }
  // candidate pages = within best section if it scored >0; otherwise all pages
  const candidates = bestSection && bestSectionScore > 0
    ? pages.filter(p => p.num >= bestSection.start && p.num <= bestSection.end)
    : pages;

  // 5) Score candidate pages with hard MUST constraint
  let best = { num: candidates[0]?.num || 1, text: candidates[0]?.text || "", score: -1e9 };
  for (const p of candidates) {
    const s = scorePage(p.text, phrases, qTokens, qBigrams, ansTokens, mustTokens);
    if (s > best.score) best = { num: p.num, text: p.text, score: s };
  }

  // 6) Build bullets:
  //    a) Try phrase→page exact matches (up to 4).
  //    b) If no phrases, use top 1–2 strong-token matches across candidates.
  const bullets = [];
  const used = new Set();

  // a) phrase-anchored bullets
  for (const phrase of phrases) {
    const needle = norm(phrase);
    if (!needle) continue;
    for (const p of candidates) {
      const idx = norm(p.text).indexOf(needle);
      if (idx >= 0) {
        const key = `${p.num}:${Math.floor(idx/40)}`;
        if (used.has(key)) continue; used.add(key);
        const snip = centeredSnippet(p.text, idx);
        bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snip}”`);
        if (bullets.length >= 4) break;
      }
    }
    if (bullets.length >= 4) break;
  }

  // b) token-anchored bullets if phrases didn’t yield
  if (!bullets.length) {
    const strongNeedles = mustTokens.filter(Boolean);
    // find up to 2 best pages containing a strong needle
    const scored = [];
    for (const p of candidates) {
      const i = findFirstIndex(p.text, strongNeedles);
      if (i >= 0) scored.push({ p, i });
    }
    scored.sort((a,b)=>a.i - b.i);
    const top = scored.slice(0, Math.min(2, scored.length));
    for (const { p, i } of top) {
      const snip = centeredSnippet(p.text, i);
      bullets.push(`• Page ${p.num} — [Open page](${pdfHref}#page=${p.num}) — “${snip}”`);
    }
    // ensure at least one bullet exists (fallback to best page center)
    if (!bullets.length && best && best.text) {
      const i = Math.max(0, Math.floor(norm(best.text).length/2));
      const snip = centeredSnippet(best.text, i);
      bullets.push(`• Page ${best.num} — [Open page](${pdfHref}#page=${best.num}) — “${snip}”`);
    }
  }

  // 7) Citation uses first bullet page; include heading if available
  const firstPage = bullets.length ? Number(bullets[0].match(/Page\s+(\d+)/i)[1]) : (best?.num || 1);
  const firstPageObj = pages.find(p => p.num === firstPage) || { text: "" };
  const art = detectArticle(firstPageObj.text);
  const sec = detectSection(firstPageObj.text);
  const heading = sec || art || "";

  const citationLine =
    `Citation: CBA (2022–2026)${heading ? `, ${heading}` : ""}; Page ${firstPage} — ` +
    `[Open page](${pdfHref}#page=${firstPage})`;

  const bulletsBlock = `—— Source text ——\n${bullets.join("\n")}`;
  const base = (answerText || "").replace(/(?:^|\n)Citation:[\s\S]*$/i, "").trim();
  const text = `${base}\n\n${citationLine}\n\n${bulletsBlock}`.trim();

  return { text, page: firstPage };
}

module.exports = { attachVerification };
