// lib/pdfIndex.js
const fs = require('fs');
const path = require('path');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
pdfjs.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/legacy/build/pdf.worker.js');

let _pages = null;

// Normalize for reliable matching
function norm(s) {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s"']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Read + cache PDF text (server-side)
async function loadPdf() {
  if (_pages) return _pages;
  const pdfPath = path.join(process.cwd(), 'public', 'mlb', 'MLB_CBA_2022.pdf');
  const data = fs.readFileSync(pdfPath);
  const doc = await pdfjs.getDocument({ data }).promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(norm(tc.items.map(it => it.str).join(' ')));
  }
  _pages = pages;
  return _pages;
}

// Simple scoring: exact substring wins; else token overlap
function score(snippet, page) {
  if (!snippet) return 0;
  if (page.includes(snippet)) return 1.0;
  const toks = snippet.split(' ').filter(w => w.length > 2);
  if (!toks.length) return 0;
  let hit = 0;
  for (const w of toks) if (page.includes(` ${w} `)) hit++;
  return hit / toks.length; // 0..1
}

function confidence(x) {
  if (x >= 0.98) return 'High';
  if (x >= 0.80) return 'Medium';
  return 'Low';
}

// Best page for a short quote (<= 40 words)
async function findBestPage(rawQuote) {
  const pages = await loadPdf();
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

// Replace the tail "Verification" block with page links + one confidence line
async function attachVerification(answerText, pdfHref = '/mlb/MLB_CBA_2022.pdf') {
  // look for the final block the Assistant adds
  const m = answerText.match(/[-–—]{2,}\s*Verification\s*[-–—]{2,}([\s\S]*)$/i);
  if (!m) return { text: answerText, changed: false };

  const tail = m[1];

  // Pull up to 3 quotes (works with curly or straight quotes)
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

  const found = await Promise.all(quotes.map(findBestPage));

  const lines = found.map(r => {
    if (r.page) {
      return `• Page ${r.page} — [Open page](${pdfHref}#page=${r.page}) — “${r.quote}”`;
    }
    return `• [Page not found] — “${r.quote}”`;
  });

  // Single answer-level confidence = the lowest of the quotes
  const rank = { High: 3, Medium: 2, Low: 1 };
  const minRank = Math.min(...found.map(r => rank[r.confidence]));
  const overall = Object.entries(rank).find(([, v]) => v === minRank)[0];
  lines.push(`• Confidence: ${overall}`);

  const rebuilt = answerText.replace(
    /([-–—]{2,}\s*Verification\s*[-–—]{2,})([\s\S]*)$/i,
    (_, hdr) => `${hdr}\n${lines.join('\n')}\n`
  );

  return { text: rebuilt, changed: true };
}

module.exports = { attachVerification, findBestPage };
