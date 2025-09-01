// /lib/linkifyCitations.js
// Single source of truth for PDF page links using public/mlb/page_map.json
// - Rewrites ALL page numbers to your mapped start page (ignores model-provided pages)
// - Adds working anchor tags to /mlb/MLB_CBA_2022.pdf#page=<start>
// - For LEGAL_EXCERPTS items, first tries to match the quoted text against titles in page_map.json.
//   If no phrase match, falls back to base-Article roman mapping.

import fs from 'fs';
import path from 'path';

let _pageMap = null;
let _articleStartIndex = null;
let _titlesIndex = null;

function loadPageMap() {
  if (_pageMap) return _pageMap;
  const p = path.join(process.cwd(), 'public', 'mlb', 'page_map.json');
  const raw = fs.readFileSync(p, 'utf8');
  _pageMap = JSON.parse(raw);
  return _pageMap;
}

// Build a map like { 'VI': 25, 'XXIII': 115, ... } from keys like "Article VI—Salaries"
function buildArticleStartIndex() {
  if (_articleStartIndex) return _articleStartIndex;

  const pageMap = loadPageMap();
  const idx = new Map();
  const romanRe = /Article\s+([IVXLCDM]+)\b/i;

  for (const key of Object.keys(pageMap)) {
    const m = key.match(romanRe);
    if (m) {
      const roman = m[1].toUpperCase();
      const start = pageMap[key]?.start;
      if (Number.isInteger(start)) {
        if (!idx.has(roman)) idx.set(roman, start);
        else idx.set(roman, Math.min(idx.get(roman), start));
      }
    }
  }

  _articleStartIndex = idx;
  return _articleStartIndex;
}

// Make lowercase title index for quick phrase matching
function buildTitlesIndex() {
  if (_titlesIndex) return _titlesIndex;
  const pageMap = loadPageMap();
  _titlesIndex = Object.entries(pageMap).map(([key, val]) => ({
    key,
    start: val?.start,
    end: val?.end,
    title: (val?.title || '').toLowerCase(),
  }));
  return _titlesIndex;
}

function extractBaseArticleRoman(label) {
  if (!label) return null;
  const m = label.match(/Article\s+([IVXLCDM]+)/i);
  return m ? m[1].toUpperCase() : null;
}

function makePdfLink(page) {
  const href = `/mlb/MLB_CBA_2022.pdf#page=${page}`;
  return `Page ${page} — <a href="${href}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

// Given the quote text, try to find a page_map entry whose title contains an exact phrase window
function findPageByQuote(quote) {
  if (!quote) return null;
  const titles = buildTitlesIndex();
  const text = quote
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^\w\s$(),.-]/g, '') // keep common punctuation helpful for money amounts
    .toLowerCase()
    .trim();

  if (!text) return null;

  // Tokenize and try window sizes (prefers longer exact phrase first)
  const tokens = text.split(/\s+/).filter(Boolean);
  const windowSizes = [12, 10, 9, 8, 7]; // tune if needed

  for (const win of windowSizes) {
    if (tokens.length < win) continue;
    for (let i = 0; i <= tokens.length - win; i++) {
      const phrase = tokens.slice(i, i + win).join(' ');
      // quick skip: ignore trivial or very generic phrases
      if (phrase.length < 25) continue;

      const hit = titles.find(t => t.title.includes(phrase));
      if (hit && Number.isInteger(hit.start)) {
        return hit.start;
      }
    }
  }
  return null;
}

export function linkifyCitations(fullText) {
  if (!fullText || typeof fullText !== 'string') return fullText;

  const articleIndex = buildArticleStartIndex();

  let out = fullText;

  // ---------------------------------------------------------
  // A) CITATION lines: rewrite to mapped start page
  // Handle one or many per block. We ignore any 'Page N' that model produced.
  // Examples to catch:
  //   CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
  //   CBA (2022–2026), Article VI(E)(1)(b); Page 23 — Open page
  //   CBA (2022–2026), Article XX(A); Page 100 — Open page
  // ---------------------------------------------------------
  out = out.replace(
    /(CBA\s*\(2022[\s–-]*2026\)\s*,?\s*Article\s+[IVXLCDM]+(?:\([^;]*\))?)(?:;?\s*Page\s*\d+\s*—\s*(?:Open page)?|\s*)/gmi,
    (match, articleLabel) => {
      const roman = extractBaseArticleRoman(articleLabel);
      const start = roman ? articleIndex.get(roman) : null;
      if (!start) return `${articleLabel}`; // leave original label if we can’t map
      return `${articleLabel}; ${makePdfLink(start)}`;
    }
  );

  // ---------------------------------------------------------
  // B) LEGAL_EXCERPTS header lines: rewrite to mapped start page
  // Format:
  //   ARTICLE: Article VI(E)(1)(b) | PAGE: 23
  //
  // We also try phrase-match from the subsequent QUOTE: "..." line,
  // and if we find a more precise page in page_map titles, we use that.
  // ---------------------------------------------------------

  // We’ll process the LEGAL_EXCERPTS block holistically so we can look at QUOTE that follows.
  out = out.replace(
    /(ARTICLE:\s*Article\s+[IVXLCDM]+(?:\([^|]*\))?\s*\|\s*PAGE:\s*)(\d+)((?:.*\n\s*QUOTE:\s*".*")?)/gmi,
    (whole, prefix, _pageNum, maybeQuoteLine) => {
      // get base article roman
      const artMatch = whole.match(/ARTICLE:\s*Article\s+([IVXLCDM]+)/i);
      const roman = artMatch ? artMatch[1].toUpperCase() : null;
      let mapped = roman ? articleIndex.get(roman) : null;

      // if a QUOTE line is on the same “item”, try phrase find
      const qMatch = maybeQuoteLine && maybeQuoteLine.match(/QUOTE:\s*"([^"]+)"/i);
      if (qMatch && qMatch[1]) {
        const byPhrase = findPageByQuote(qMatch[1]);
        if (Number.isInteger(byPhrase)) mapped = byPhrase;
      }

      if (!mapped) return whole; // can’t map; leave as-is
      return `${prefix}${mapped} — <a href="/mlb/MLB_CBA_2022.pdf#page=${mapped}" target="_blank" rel="noopener noreferrer">Open page</a>`;
    }
  );

  // As a safety net, if any residual “PAGE: N — Open page” lacks a link, add it
  out = out.replace(
    /PAGE:\s*(\d+)\s*—\s*Open page/g,
    (m, p) => `PAGE: ${p} — <a href="/mlb/MLB_CBA_2022.pdf#page=${p}" target="_blank" rel="noopener noreferrer">Open page</a>`
  );

  return out;
}
