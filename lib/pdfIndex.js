// lib/pdfIndex.js
// Source-text & Citation linker for MLB CBA answers.
//
// What it does:
// - Server-only (Next.js API route). No worker needed.
// - Loads PDF from /public first; falls back to HTTP fetch from your domain.
// - For each model "quote" (in the old Verification section):
//     * picks the best-matching page
//     * if the quote was paraphrased, replaces it with a REAL 25–40 word excerpt from that page
// - Rewrites the answer so it includes:
//     * A true "Citation:" line -> CBA (2022–2026), Article/Section (best-effort) ; Page N — [Open page](...#page=N)
//     * A "—— Source text ——" block with bullets:
//         • Page N — Open page — “<exact excerpt>” — Article/Section hint
//     * A final line:  • Confidence (AI interpretation): High/Medium/Low
//
// Notes:
// - Article/Section detection is best-effort (regex scan of headings on that page).
// - If no page is found (rare), we keep the quote and omit the page link.

const fs = require('fs');
const path = require('path');

let _normPages = null;
let _rawPages  = null;

// ---------- pdfjs loader (LEGACY build for Node on Vercel) ----------
async function getPdfjs() {
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf');
    return { getDocument: mod.getDocument || mod.default?.getDocument };
  } catch {
    const mod2 = await import('pdfjs-dist');
    return { getDocument: mod2.getDocument || mod2.default?.getDocument };
  }
}

// ---------- text utils ----------
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

// 25–40 word excerpt around the best overlap with desired terms
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

// Try to extract an "Article ..." and/or "Section ..." hint from a page
function detectCitationParts(rawPageText) {
  // Heuristics robust to typical CBA formatting
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

// ---------- PDF load (disk → HTTP fallback) ----------
async function loadPdfBytes(pdfPublicPath, origin) {
  const diskPath = path.join(process.cwd(), 'public', pdfPublicPath.replace(/^\//, ''));
  if (fs.existsSync(diskPath)) {
    return fs.readFileSync(diskPath); // Buffer
  }
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

// ---------- matching ----------
function scoreAgainstPage(snippetNorm, pageNorm) {
  if (!snippetNorm) return 0;
  if (pageNorm.includes(snippetNorm)) return 1.0;
  const toks = snippetNorm.split(' ').filter(w => w.length > 2);
  if (!toks.length) return 0;
  let hit = 0;
  for (const w of toks) if (pageNorm.includes(` ${w} `)) hit++;
  return hit / toks.length;
}

function confFromScore(x) {
  if (x >= 0.98) return 'High';
  if (x >= 0.80) return 'Medium';
  return 'Low';
}

async function findBestPage(rawQuote, publishedHref, origin) {
  await ensurePagesLoaded(publishedHref, origin);

  const trimmed = rawQuote.split(/\s+/).slice(0, 40).join(' ');
  const sn = norm(trimmed);

  let best = { idx: -1, score: 0 };
  for (let i = 0; i < _normPages.length; i++) {
    const s = scoreAgainstPage(sn, _normPages[i]);
    if (s > best.score) { best = { idx: i, score: s }; }
    if (best.score === 1.0) break;
  }

  const pageNum = best.idx >= 0 ? best.idx + 1 : null;

  let displayQuote = trimmed;
  let articleHintParts = { article: '', section: '' };

  if (pageNum) {
    const rawPageText = _rawPages[pageNum - 1];
    if (best.score < 0.98) {
      const wanted = tokenize(trimmed);
      displayQuote = buildSnippet(rawPageText, wanted, 25, 40);
    }
    articleHintParts = detectCitationParts(rawPageText);
  }

  return {
    page: pageNum,
    score: best.score,
    confidence: confFromScore(best.score),
    displayQuote,
    articleHintParts
  };
}

// ---------- rewrite the answer ----------
function replaceOrInsertCitationBlock(answerText, citationLine) {
  // If there's already a "Citation:" line, replace that paragraph.
  const rx = /(^|\n)Citation:\s*[\s\S]*?(?=\n{2,}|\n[-–—]{2,}|\nAI interpretation:|\n$)/i;
  if (rx.test(answerText)) {
    return answerText.replace(rx, `\n${citationLine}\n`);
  }
  // Otherwise, append it just before any "Source text" block or at the end.
  const srcRx = /([-–—]{2,}\s*Source\s*text\s*[-–—]{2,})/i;
  if (srcRx.test(answerText)) {
    return answerText.replace(srcRx, `${citationLine}\n\n$1`);
  }
  return `${answerText}\n\n${citationLine}\n`;
}

async function attachVerification(answerText, pdfHref = '/mlb/MLB_CBA_2022.pdf', origin) {
  // We accept either the old "Verification" header or none; we'll output "Source text".
  const verMatch = answerText.match(/[-–—]{2,}\s*Verification\s*[-–—]{2,}([\s\S]*)$/i);
  const tail = verMatch ? verMatch[1] : answerText;

  // Extract up to 3 quotes (curly or straight quotes)
  const quotes = [];
  for (const rx of [/“([^”]{3,400})”/g, /"([^"]{3,400})"/g]) {
    let q;
    while ((q = rx.exec(tail)) && quotes.length < 3) {
      const found = q[1].trim();
      if (found) quotes.push(found);
    }
    if (quotes.length) break;
  }
  if (!quotes.length) {
    // No quotes to work with — return original unchanged.
    return { text: answerText, changed: false };
  }

  // Locate page + build final, REAL excerpts
  const results = [];
  for (const q of quotes) {
    try {
      results.push(await findBestPage(q, pdfHref, origin));
    } catch {
      results.push({ page: null, score: 0, confidence: 'Low', displayQuote: q, articleHintParts: { article: '', section: '' } });
    }
  }

  // Build bullets: Page N + Open page + exact excerpt + Article/Section hint
  const lines = results.map(r => {
    const quote = (r.displayQuote || '').replace(/\s+/g, ' ').trim();
    if (r.page) {
      const parts = r.articleHintParts || {};
      const meta = [parts.article, parts.section].filter(Boolean).join(' · ');
      const hint = meta ? ` — ${meta}` : '';
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${quote}”${hint}`;
    }
    return `• “${quote}”`;
  });

  // Choose the first result with a page for the primary Citation line
  const firstWithPage = results.find(r => r.page);
  if (firstWithPage) {
    const citationLine = buildCitationLine(firstWithPage.articleHintParts || {}, firstWithPage.page, pdfHref);
    answerText = replaceOrInsertCitationBlock(answerText, citationLine);
  }

  // Build the Source text block (replace old Verification block if present)
  const sourceBlock = `—— Source text ——\n${lines.join('\n')}\n`;

  let rebuilt;
  if (verMatch) {
    rebuilt = answerText.replace(
      /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
      () => `\n${sourceBlock}`
    );
  } else {
    rebuilt = `${answerText}\n\n${sourceBlock}`;
  }

  // Confidence applies ONLY to the AI interpretation
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...results.map(r => rank[r.confidence] ?? 1));
  const interpretationConfidence = Object.entries(rank).find(([, v]) => v === minRank)?.[0] || 'Low';
  rebuilt = `${rebuilt}\n• Confidence (AI interpretation): ${interpretationConfidence}\n`;

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
