// lib/pdfIndex.js
// Verification linker for MLB CBA answers.
// - Server-only (Next.js API route). No worker needed.
// - Loads PDF from /public first; falls back to HTTP fetch from your domain.
// - For each model "quote" in the Verification section:
//     * picks the best-matching page
//     * if the quote is paraphrased, replaces it with a REAL 25–40 word excerpt
//     * emits:  • Page N — [Open page](/mlb/MLB_CBA_2022.pdf#page=N) — “<exact CBA excerpt>”
// - Adds a (best-effort) Article/Section hint on that line when detected.
// - Final line:  • Confidence (AI interpretation): High/Medium/Low

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

// Try to extract an "Article ..." or "Section ..." hint from a page
function detectCitationHint(rawPageText) {
  // These are heuristics; the CBA typography may vary.
  const art = rawPageText.match(/Article\s+[IVXLCDM]+[—\-\:\s]+[A-Z][A-Za-z0-9\s,.'&\-()]{3,80}/i);
  const sec = rawPageText.match(/\bSection\s+[A-Z0-9][A-Z0-9().\-]*[—\-\:\s]+[A-Z][A-Za-z0-9\s,.'&\-()]{3,80}/i);
  const clause = rawPageText.match(/\b[A-Z]\)[\s\-–—]+[A-Z][A-Za-z0-9\s,.'&\-()]{3,80}/); // e.g., (a) …, A) …
  const parts = [];
  if (art) parts.push(art[0].replace(/\s+/g, ' ').trim());
  if (sec) parts.push(sec[0].replace(/\s+/g, ' ').trim());
  if (!parts.length && clause) parts.push(clause[0].replace(/\s+/g, ' ').trim());
  return parts.length ? ' — ' + parts.join(' · ') : '';
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
  return Buffer.from(ab); // Buffer
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
  let articleHint = '';

  if (pageNum) {
    const rawPageText = _rawPages[pageNum - 1];
    // If the match was weak, replace with a REAL excerpt from the page
    if (best.score < 0.98) {
      const wanted = tokenize(trimmed);
      displayQuote = buildSnippet(rawPageText, wanted, 25, 40);
    }
    articleHint = detectCitationHint(rawPageText);
  }

  return {
    page: pageNum,
    score: best.score,
    confidence: confFromScore(best.score),
    displayQuote,
    articleHint
  };
}

// ---------- render Verification block ----------
async function attachVerification(answerText, pdfHref = '/mlb/MLB_CBA_2022.pdf', origin) {
  // Find the Verification section the Assistant appended
  const m = answerText.match(/[-–—]{2,}\s*Verification\s*[-–—]{2,}([\s\S]*)$/i);
  if (!m) return { text: answerText, changed: false };

  const tail = m[1];

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
  if (!quotes.length) return { text: answerText, changed: false };

  // Locate page + build final, REAL excerpts
  const results = [];
  for (const q of quotes) {
    try {
      results.push(await findBestPage(q, pdfHref, origin));
    } catch {
      results.push({ page: null, score: 0, confidence: 'Low', displayQuote: q, articleHint: '' });
    }
  }

  // Build bullets: Page N + Open page + exact excerpt (and any Article/Section hint)
  const lines = results.map(r => {
    const quote = (r.displayQuote || '').replace(/\s+/g, ' ').trim();
    if (r.page) {
      const hint = r.articleHint || '';
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${quote}”${hint}`;
    }
    // If we truly can’t find a page, still show the quote (rare after fuzzy)
    return `• “${quote}”`;
  });

  // *** IMPORTANT: Confidence label applies only to the AI interpretation ***
  // We keep the same min-of-scores logic to be conservative about interpretation.
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...results.map(r => rank[r.confidence] ?? 1));
  const interpretationConfidence = Object.entries(rank).find(([, v]) => v === minRank)?.[0] || 'Low';
  lines.push(`• Confidence (AI interpretation): ${interpretationConfidence}`);

  // Replace the tail section in the original answer
  const rebuilt = answerText.replace(
    /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
    (_, hdr) => `${hdr}\n${lines.join('\n')}\n`
  );

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
