// lib/pdfIndex.js
// Server-only PDF text linker for the Verification block.
//
// Fixes:
// - Use pdfjs-dist LEGACY build in Node (dynamic import -> works on Vercel)
// - Always pass Uint8Array (not Buffer) to pdfjs getDocument
// - Read PDF from /public when available, else fetch over HTTP
// - If page not found, add a "Find in PDF" link so users can still verify fast

const fs = require('fs');
const path = require('path');

let _pages = null;

// Dynamically import pdfjs LEGACY build for Node
async function getPdfjs() {
  try {
    // Legacy build (ESM). No ".js" extension.
    const mod = await import('pdfjs-dist/legacy/build/pdf');
    return { getDocument: mod.getDocument || mod.default?.getDocument };
  } catch {
    // Fallback to root (still ESM in v4+)
    const mod2 = await import('pdfjs-dist');
    return { getDocument: mod2.getDocument || mod2.default?.getDocument };
  }
}

// Normalize text for robust matching
function norm(s) {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s"']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Load the PDF bytes from disk or HTTP
async function loadPdfBytes(pdfPublicPath, origin) {
  // 1) Try reading from the deployed /public folder
  const diskPath = path.join(process.cwd(), 'public', pdfPublicPath.replace(/^\//, ''));
  if (fs.existsSync(diskPath)) {
    console.log('[pdfIndex] using DISK path', diskPath);
    return fs.readFileSync(diskPath); // Buffer
  }

  // 2) Fallback: fetch over HTTP (works on previews + prod)
  const base =
    origin ||
    process.env.SELF_BASE_URL || // optional override, e.g. https://mlb.mitchleblanc.xyz
    `https://${process.env.VERCEL_URL || 'mlb.mitchleblanc.xyz'}`;

  const url = `${base}${pdfPublicPath}`;
  console.log('[pdfIndex] using HTTP fetch', url);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab); // Buffer
}

// Read + cache the PDF as normalized text per page
async function loadPdf(publishedHref, origin) {
  if (_pages) return _pages;

  const buf = await loadPdfBytes(publishedHref, origin);
  // Convert Buffer -> Uint8Array (required by pdfjs)
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  console.log('[pdfIndex] loaded PDF bytes:', bytes.byteLength, 'bytes');

  const { getDocument } = await getPdfjs();
  if (typeof getDocument !== 'function') throw new Error('pdfjs getDocument() unavailable');

  // No worker needed on Node; pass Uint8Array
  const loadingTask = getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ');
    pages.push(norm(text));
  }
  _pages = pages;
  return _pages;
}

// Scoring: exact substring wins; else token overlap ratio
function score(snippet, page) {
  if (!snippet) return 0;
  if (page.includes(snippet)) return 1.0;
  const toks = snippet.split(' ').filter((w) => w.length > 2);
  if (!toks.length) return 0;
  let hit = 0;
  for (const w of toks) if (page.includes(` ${w} `)) hit++;
  return hit / toks.length;
}

function confidence(x) {
  if (x >= 0.98) return 'High';
  if (x >= 0.80) return 'Medium';
  return 'Low';
}

// Find best page for one short quote (<= 40 words)
async function findBestPage(rawQuote, publishedHref, origin) {
  const pages = await loadPdf(publishedHref, origin);
  const trimmed = rawQuote.split(/\s+/).slice(0, 40).join(' ');
  const sn = norm(trimmed);

  let best = { idx: -1, score: 0 };
  for (let i = 0; i < pages.length; i++) {
    const s = score(sn, pages[i]);
    if (s > best.score) best = { idx: i, score: s };
    if (best.score === 1.0) break;
  }

  return {
    page: best.idx >= 0 ? best.idx + 1 : null,
    quote: trimmed,
    score: best.score,
    confidence: confidence(best.score),
  };
}

// Replace the trailing "Verification" block with page links (or search link) + one confidence line
async function attachVerification(answerText, pdfHref = '/mlb/MLB_CBA_2022.pdf', origin) {
  // Find the Verification section the Assistant appended
  const m = answerText.match(/[-–—]{2,}\s*Verification\s*[-–—]{2,}([\s\S]*)$/i);
  if (!m) return { text: answerText, changed: false };

  const tail = m[1];

  // Extract up to 3 quotes (supports curly or straight quotes)
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

  // Find pages (with hard fail-safe)
  const found = [];
  for (const q of quotes) {
    try {
      found.push(await findBestPage(q, pdfHref, origin));
    } catch (e) {
      console.error('[pdfIndex] findBestPage error:', e?.message || e);
      found.push({ page: null, quote: q, score: 0, confidence: 'Low' });
    }
  }

  // Build lines: prefer page links; always include a working search link if page not found
  const lines = found.map((r) => {
    const searchParam = `#search=${encodeURIComponent(r.quote)}`;
    if (r.page) {
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${r.quote}”`;
    }
    return `• [Find in PDF](${pdfHref}${searchParam}) — “${r.quote}”`;
  });

  // Overall confidence = the lowest of the quotes
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...found.map((r) => rank[r.confidence] ?? 1));
  const overall = Object.entries(rank).find(([, v]) => v === minRank)?.[0] || 'Low';
  lines.push(`• Confidence: ${overall}`);

  const rebuilt = answerText.replace(
    /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
    (_, hdr) => `${hdr}\n${lines.join('\n')}\n`
  );

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
