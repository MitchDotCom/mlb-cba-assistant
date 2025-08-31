// lib/pdfIndex.js
// Verification linker for your MLB CBA assistant.
//
// What this does now:
// 1) Loads the CBA PDF (from /public or, if needed, via HTTP).
// 2) Finds the best page for each short quote.
// 3) If the model's quote isn't an exact match, extracts a REAL 25–40 word snippet
//    from the best page so your Verification block still shows actual CBA text.
// 4) Adds two links per line:
//    • "Open page"  -> /mlb/MLB_CBA_2022.pdf#page=N
//    • "Search viewer" -> /pdfjs/web/viewer.html?file=/mlb/MLB_CBA_2022.pdf#search="snippet"
//       (PDF.js viewer highlights the text; see note below to add the viewer assets.)
//
// Server-only. No worker needed. Uses dynamic ESM import that works on Vercel.

const fs = require('fs');
const path = require('path');

let _normPages = null;
let _rawPages  = null;

// ---------- pdfjs loader (LEGACY build for Node) ----------
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
    .filter(w => w.length >= 4); // keep distinctive terms
}

// Extract a 25–40 word real snippet from a page around the strongest term overlap
function buildSnippet(rawPageText, wantedTerms, minWords = 25, maxWords = 40) {
  const words = rawPageText.split(/\s+/);
  if (words.length <= maxWords) return rawPageText.trim();

  const wantedSet = new Set(wantedTerms.map(t => t.toLowerCase()));
  let bestIdx = -1, bestScore = -1;

  for (let i = 0; i < words.length; i++) {
    // Check small window for overlap signal
    const windowSize = 12;
    const slice = words.slice(i, i + windowSize).map(w => w.toLowerCase().replace(/[^a-z0-9'-]/g, ''));
    const score = slice.reduce((acc, w) => acc + (wantedSet.has(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  if (bestIdx < 0) bestIdx = 0;

  // Expand to minWords..maxWords around the bestIdx
  const half = Math.floor(minWords / 2);
  let start = Math.max(0, bestIdx - half);
  let end   = Math.min(words.length, start + maxWords);
  if (end - start < minWords) start = Math.max(0, end - minWords);

  let snippet = words.slice(start, end).join(' ').trim();
  // Normalize whitespace quotes
  snippet = snippet.replace(/\s+/g, ' ');
  // Limit to ~300 chars to keep bullets tidy (don’t cut off mid-word hard)
  if (snippet.length > 300) snippet = snippet.slice(0, 295).replace(/\s+\S*$/, '') + '…';
  return snippet;
}

// ---------- PDF load (disk → HTTP fallback) ----------
async function loadPdfBytes(pdfPublicPath, origin) {
  const diskPath = path.join(process.cwd(), 'public', pdfPublicPath.replace(/^\//, ''));
  if (fs.existsSync(diskPath)) {
    return fs.readFileSync(diskPath); // Buffer
  }
  const base =
    origin ||
    process.env.SELF_BASE_URL ||    // optional override
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
    norm.push(text
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
function scoreSnippetAgainstPage(snippetNorm, pageNorm) {
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

  // normalize the quote (first 40 words)
  const trimmed = rawQuote.split(/\s+/).slice(0, 40).join(' ');
  const sn = norm(trimmed);

  let best = { idx: -1, score: 0 };
  for (let i = 0; i < _normPages.length; i++) {
    const s = scoreSnippetAgainstPage(sn, _normPages[i]);
    if (s > best.score) { best = { idx: i, score: s }; }
    if (best.score === 1.0) break;
  }

  const pageNum = best.idx >= 0 ? best.idx + 1 : null;
  const confidence = confFromScore(best.score);

  // If we found a page but the score is weak, synthesize a REAL snippet from that page
  let verifiedSnippet = trimmed;
  if (pageNum && best.score < 0.8) {
    const wanted = tokenize(trimmed);
    const rawPageText = _rawPages[pageNum - 1];
    verifiedSnippet = buildSnippet(rawPageText, wanted, 25, 40);
  }

  return {
    page: pageNum,
    score: best.score,
    confidence,
    // This is the text we will display in the bullet (real CBA snippet when score is low)
    displayQuote: verifiedSnippet
  };
}

// ---------- render Verification block ----------
function buildViewerSearchUrl(origin, pdfHref, text) {
  // You’ll add the PDF.js viewer assets under /public/pdfjs/web/viewer.html (see note below).
  // Then this URL highlights the text reliably in the viewer:
  const fileParam = encodeURIComponent(`${origin}${pdfHref}`);
  const searchParam = encodeURIComponent(text);
  return `/pdfjs/web/viewer.html?file=${fileParam}#search=${searchParam}`;
}

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

  // Try to locate each quote's page; if fuzzy, pull a real snippet from the PDF page
  const results = [];
  for (const q of quotes) {
    try {
      const r = await findBestPage(q, pdfHref, origin);
      results.push(r);
    } catch (e) {
      results.push({ page: null, score: 0, confidence: 'Low', displayQuote: q });
    }
  }

  // Build bullets:
  const lines = results.map(r => {
    const display = r.displayQuote || '';
    const viewerUrl = buildViewerSearchUrl(origin, pdfHref, display);

    if (r.page) {
      // Page link + Search viewer link
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${display}”  ·  [Search viewer](${viewerUrl})`;
    } else {
      // No page -> at least give a working viewer search
      return `• [Search viewer](${viewerUrl}) — “${display}”`;
    }
  });

  // Overall confidence = min of per-quote confidences
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...results.map(r => rank[r.confidence] ?? 1));
  const overall = Object.entries(rank).find(([, v]) => v === minRank)?.[0] || 'Low';
  lines.push(`• Confidence: ${overall}`);

  const rebuilt = answerText.replace(
    /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
    (_, hdr) => `${hdr}\n${lines.join('\n')}\n`
  );

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
