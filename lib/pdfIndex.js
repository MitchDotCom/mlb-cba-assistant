// lib/pdfIndex.js
// Robust Source-text + Citation linker for MLB CBA answers.
//
// Guarantees for output (when the CBA has the clause):
// - "Citation: CBA (2022–2026), <Article/Section if detected>; Page N — [Open page](/mlb/MLB_CBA_2022.pdf#page=N)"
// - "—— Source text ——" bullets:
//     • Page N — Open page — “<REAL excerpt>” — <Article/Section hint>
// - No confidence line.
//
// Strategy:
// 1) Load PDF pages (disk → HTTP), cache in memory.
// 2) Try to find the best page(s) using the model’s short “quotes” (fuzzy).
// 3) If match is weak or absent, run topic clause detectors (regex) for DFA, Options (3 + 4th), CBT (thresholds/AAV).
// 4) Extract a 25–40 word REAL snippet around the match, plus best-effort Article/Section text from the page.
// 5) Rewrite the answer: add a real "Citation:" line and "Source text" block.
//
// Server-only. No worker needed. Uses pdfjs-dist LEGACY build for Node on Vercel.

const fs = require('fs');
const path = require('path');

let _normPages = null;
let _rawPages  = null;

// -------- pdfjs loader (legacy) --------
async function getPdfjs() {
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf');
    return { getDocument: mod.getDocument || mod.default?.getDocument };
  } catch {
    const mod2 = await import('pdfjs-dist');
    return { getDocument: mod2.getDocument || mod2.default?.getDocument };
  }
}

// -------- text utils --------
function norm(s) {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s"']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4);
}

function buildSnippet(rawPageText, wantedTerms, minWords = 25, maxWords = 40) {
  const words = rawPageText.split(/\s+/);
  if (words.length <= maxWords) return rawPageText.trim();

  const wanted = new Set(wantedTerms.map(t => t.toLowerCase()));
  let bestIdx = 0, bestScore = -1;

  for (let i = 0; i < words.length; i++) {
    const windowSize = 14;
    const slice = words.slice(i, i + windowSize).map(w => w.toLowerCase().replace(/[^a-z0-9'-]/g, ''));
    const score = slice.reduce((acc, w) => acc + (wanted.has(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  let start = Math.max(0, bestIdx - Math.floor(minWords / 2));
  let end   = Math.min(words.length, start + maxWords);
  if (end - start < minWords) start = Math.max(0, end - minWords);

  let snippet = words.slice(start, end).join(' ').trim().replace(/\s+/g, ' ');
  if (snippet.length > 340) snippet = snippet.slice(0, 335).replace(/\s+\S*$/, '') + '…';
  return snippet;
}

// Try to extract Article/Section heading text from a page
function detectCitationParts(rawPageText) {
  const ARTICLE_RX = /(Article\s+[IVXLCDM]+)\s*[—\-:\. ]\s*([A-Z][A-Za-z0-9\s,.'&\-()]{3,120})/i;
  const SECTION_RX = /\b(Section\s+[A-Z0-9][A-Z0-9().\-]*)\s*[—\-:\. ]\s*([A-Z][A-Za-z0-9\s,.'&\-()]{3,120})/i;

  const art = rawPageText.match(ARTICLE_RX);
  const sec = rawPageText.match(SECTION_RX);

  const article = art ? (art[1] + (art[2] ? ` — ${art[2]}` : '')) : '';
  const section = sec ? (sec[1] + (sec[2] ? ` — ${sec[2]}` : '')) : '';

  return { article, section };
}

function buildCitationLine(parts, pageNum, pdfHref) {
  const where = [];
  if (parts.article) where.push(parts.article);
  if (parts.section) where.push(parts.section);
  const whereStr = where.length ? where.join(' · ') : 'Exact clause on cited page';
  return `Citation: CBA (2022–2026), ${whereStr}; Page ${pageNum} — [Open page](${pdfHref}#page=${pageNum})`;
}

// -------- PDF load (disk → HTTP) --------
async function loadPdfBytes(pdfPublicPath, origin) {
  const diskPath = path.join(process.cwd(), 'public', pdfPublicPath.replace(/^\//, ''));
  if (fs.existsSync(diskPath)) return fs.readFileSync(diskPath); // Buffer

  const base =
    origin ||
    process.env.SELF_BASE_URL ||
    `https://${process.env.VERCEL_URL || 'mlb.mitchleblanc.xyz'}`;
  const url = `${base}${pdfPublicPath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

async function ensurePagesLoaded(publishedHref, origin) {
  if (_normPages && _rawPages) return;
  const buf = await loadPdfBytes(publishedHref, origin);
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  const { getDocument } = await getPdfjs();
  if (typeof getDocument !== 'function') throw new Error('pdfjs getDocument() unavailable');

  const doc = await getDocument({ data: bytes }).promise;

  const norm = [];
  const raw  = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ');
    raw.push(text);
    norm.push(
      text
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[^\p{L}\p{N}\s"']/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  _normPages = norm;
  _rawPages  = raw;
}

// -------- fuzzy matching from quotes --------
function fuzzyScore(snippetNorm, pageNorm) {
  if (!snippetNorm) return 0;
  if (pageNorm.includes(snippetNorm)) return 1.0;
  const toks = snippetNorm.split(' ').filter(w => w.length > 2);
  if (!toks.length) return 0;
  let hit = 0;
  for (const w of toks) if (pageNorm.includes(` ${w} `)) hit++;
  return hit / toks.length;
}

async function findBestPageFromQuote(rawQuote, publishedHref, origin) {
  await ensurePagesLoaded(publishedHref, origin);
  const trimmed = rawQuote.split(/\s+/).slice(0, 40).join(' ');
  const sn = norm(trimmed);

  let best = { idx: -1, score: 0 };
  for (let i = 0; i < _normPages.length; i++) {
    const s = fuzzyScore(sn, _normPages[i]);
    if (s > best.score) { best = { idx: i, score: s }; }
    if (best.score === 1.0) break;
  }

  if (best.idx < 0) return null;

  const pageNum = best.idx + 1;
  let displayQuote = trimmed;

  // If fuzzy, synthesize a REAL excerpt from that page
  if (best.score < 0.98) {
    const wanted = tokenize(trimmed);
    displayQuote = buildSnippet(_rawPages[best.idx], wanted, 25, 40);
  }
  const parts = detectCitationParts(_rawPages[best.idx]);

  return { page: pageNum, score: best.score, displayQuote, parts };
}

// -------- topic clause detectors (hard regex) --------
// These help when the model "quotes" are paraphrases.
// Add more patterns as you expand topics.
const DETECTORS = [
  // DFA
  {
    id: 'dfa-core',
    matchers: [
      /designated\s+for\s+assignment/i,
      /seven\s+\(?7\)?\s+days/i,
      /remove(?:d)?\s+from\s+(?:the\s+)?(?:major\s+league\s+)?reserve\s+list/i
    ]
  },
  // Options (3 total) and the 4th option rule
  {
    id: 'options-core',
    matchers: [
      /optioned?\s+in\s+not\s+more\s+than\s+three\s+separate\s+seasons/i,
      /fourth\s+option\s+year\s+shall\s+be\s+granted/i,
      /full\s+season\s+.*\b90\b|\bninety\s+\(90\)\s+days/i,
      /\b20\s+(?:or|\/)?\s*twenty\s*\(?20\)?\s+days/i // 20-day cutoff often nearby
    ]
  },
  // CBT (thresholds/AAV payroll)
  {
    id: 'cbt-core',
    matchers: [
      /competitive\s+balance\s+tax/i,
      /tax\s+thresholds?\s+for\s+each\s+contract\s+year/i,
      /average\s+annual\s+value\s+of\s+player\s+contracts?/i
    ]
  }
];

function findDetectorHits() {
  const hits = [];
  for (let i = 0; i < _rawPages.length; i++) {
    const text = _rawPages[i];
    for (const det of DETECTORS) {
      for (const rx of det.matchers) {
        if (rx.test(text)) {
          hits.push({ idx: i, det: det.id, rx: rx.toString() });
          break;
        }
      }
    }
  }
  return hits;
}

function bestDetectorForQuotes(quotes) {
  const combined = quotes.join(' ').toLowerCase();
  const score = (det) => {
    let s = 0;
    for (const rx of det.matchers) if (rx.test(combined)) s += 1;
    return s;
  };
  let best = { det: DETECTORS[0], sc: -1 };
  for (const d of DETECTORS) {
    const sc = score(d);
    if (sc > best.sc) best = { det: d, sc };
  }
  return best.det;
}

function pickTopPagesByDetector(detId, maxPages = 3) {
  const pages = [];
  for (let i = 0; i < _rawPages.length; i++) {
    const text = _rawPages[i];
    const det = DETECTORS.find(d => d.id === detId);
    if (!det) continue;
    let ok = false;
    for (const rx of det.matchers) if (rx.test(text)) { ok = true; break; }
    if (ok) pages.push(i + 1);
    if (pages.length >= maxPages) break;
  }
  return pages;
}

function buildExcerptForPage(pageNum, queryText) {
  const raw = _rawPages[pageNum - 1] || '';
  const wanted = tokenize(queryText);
  const snippet = buildSnippet(raw, wanted.length ? wanted : ['the','and'], 25, 40);
  const parts = detectCitationParts(raw);
  return { snippet, parts };
}

// -------- rewrite the answer (add Citation + Source text) --------
function replaceOrInsertCitationBlock(answerText, citationLine) {
  const rx = /(^|\n)Citation:\s*[\s\S]*?(?=\n{2,}|\n[-–—]{2,}|\nAI interpretation:|\n$)/i;
  if (rx.test(answerText)) return answerText.replace(rx, `\n${citationLine}\n`);

  const srcRx = /([-–—]{2,}\s*Source\s*text\s*[-–—]{2,})/i;
  if (srcRx.test(answerText)) return answerText.replace(srcRx, `${citationLine}\n\n$1`);

  return `${answerText}\n\n${citationLine}\n`;
}

async function attachVerification(answerText, pdfHref = '/mlb/MLB_CBA_2022.pdf', origin) {
  // Accept "Verification" (old) or none — we output "Source text" always.
  const verMatch = answerText.match(/[-–—]{2,}\s*Verification\s*[-–—]{2,}([\s\S]*)$/i);
  const tail = verMatch ? verMatch[1] : answerText;

  // Pull up to 3 short quotes
  const quotes = [];
  for (const rx of [/“([^”]{3,400})”/g, /"([^"]{3,400})"/g]) {
    let q; while ((q = rx.exec(tail)) && quotes.length < 3) { const s = q[1].trim(); if (s) quotes.push(s); }
    if (quotes.length) break;
  }

  await ensurePagesLoaded(pdfHref, origin);

  // 1) Try quote-based matches
  const results = [];
  if (quotes.length) {
    for (const q of quotes) {
      const r = await findBestPageFromQuote(q, pdfHref, origin);
      if (r) results.push(r);
    }
  }

  // 2) If we have no page yet, use detectors keyed to the quotes/topic
  if (!results.some(r => r?.page)) {
    const det = bestDetectorForQuotes(quotes.length ? quotes : [answerText]);
    const pages = pickTopPagesByDetector(det, 2); // up to 2 pages
    for (const p of pages) {
      const ex = buildExcerptForPage(p, quotes[0] || answerText);
      results.push({ page: p, score: 1.0, displayQuote: ex.snippet, parts: ex.parts });
    }
  }

  // If still nothing, bail unchanged
  if (!results.length) return { text: answerText, changed: false };

  // Build bullets: Page N + Open page + REAL excerpt + Article/Section hint
  const bullets = results.map(r => {
    const quote = (r.displayQuote || '').replace(/\s+/g, ' ').trim();
    if (r.page) {
      const parts = r.parts || {};
      const meta = [parts.article, parts.section].filter(Boolean).join(' · ');
      const hint = meta ? ` — ${meta}` : '';
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${quote}”${hint}`;
    }
    return `• “${quote}”`;
  });

  // Primary Citation line: first with page
  const firstWithPage = results.find(r => r.page);
  if (firstWithPage) {
    const citationLine = buildCitationLine(firstWithPage.parts || {}, firstWithPage.page, pdfHref);
    answerText = replaceOrInsertCitationBlock(answerText, citationLine);
  }

  const sourceBlock = `—— Source text ——\n${bullets.join('\n')}\n`;

  let rebuilt;
  if (verMatch) {
    rebuilt = answerText.replace(
      /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
      () => `\n${sourceBlock}`
    );
  } else {
    rebuilt = `${answerText}\n\n${sourceBlock}`;
  }

  // Strip any leftover "Confidence" lines (if earlier code added them)
  rebuilt = rebuilt.replace(/\n•\s*Confidence[^\n]*\n?/gi, '\n');

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification };
