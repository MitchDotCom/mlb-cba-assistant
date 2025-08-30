// lib/pdfIndex.js
// Server-only PDF text linker for the Verification block.
// - Dynamically imports pdfjs-dist (ESM) so Next/Vercel are happy
// - Tries reading the PDF from /public; if not found, fetches it over HTTP
// - No worker needed on Node

const fs = require('fs');
const path = require('path');

let _pages = null;

async function getPdfjs() {
  try {
    const mod = await import('pdfjs-dist/build/pdf'); // public build (preferred)
    return { getDocument: mod.getDocument || mod.default?.getDocument };
  } catch {
    const mod2 = await import('pdfjs-dist'); // fallback
    return { getDocument: mod2.getDocument || mod2.default?.getDocument };
  }
}

// Make text comparable (case/quotes/punct/spacing)
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
    return fs.readFileSync(diskPath);
  }

  // 2) Fallback: fetch over HTTP (works on previews + prod)
  const base =
    origin ||
    process.env.SELF_BASE_URL || // optional env override
    `https://${process.env.VERCEL_URL || 'mlb.mitchleblanc.xyz'}`;

  const url = `${base}${pdfPublicPath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// Read + cache the PDF as normalized text per page
async function loadPdf(publishedHref, origin) {
  if (_pages) return _pages;

  const data = await loadPdfBytes(publishedHref, origin);
  const { getDocument } = await getPdfjs();
  if (typeof getDocument !== 'function') throw new Error('pdfjs getDocument() unavailable');

  const loadingTask = getDocument({ data });
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

// Replace the trailing "Verification" block with page links + one confidence line
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

  const found = await Promise.all(quotes.map(q => findBestPage(q, pdfHref, origin)));

  const lines = found.map((r) => {
    if (r.page) {
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${r.quote}”`;
    }
    return `• [Page not found] — “${r.quote}”`;
  });

  // Overall confidence = the lowest of the quotes
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...found.map((r) => rank[r.confidence]));
  const overall = Object.entries(rank).find(([, v]) => v === minRank)[0];
  lines.push(`• Confidence: ${overall}`);

  const rebuilt = answerText.replace(
    /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
    (_, hdr) => `${hdr}\n${lines.join('\n')}\n`
  );

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
