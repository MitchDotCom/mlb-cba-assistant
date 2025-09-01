// /lib/linkifyCitations.js
// Single source of truth for PDF page links using public/mlb/page_map.json
// - Rewrites *all* "Citation:" lines to use the mapped start page for the base Article
// - Rewrites each LEGAL_EXCERPTS "PAGE: N" to the mapped start page
// - Adds working anchor tags to /mlb/MLB_CBA_2022.pdf#page=<start>
// - Ignores any page number coming from the Assistant

import fs from 'fs';
import path from 'path';

let _pageMap = null;
let _articleStartIndex = null;

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

  // Helper to capture Roman numerals
  const romanRe = /Article\s+([IVXLCDM]+)\b/i;

  for (const key of Object.keys(pageMap)) {
    const m = key.match(romanRe);
    if (m) {
      const roman = m[1].toUpperCase();
      const start = pageMap[key]?.start;
      if (Number.isInteger(start)) {
        if (!idx.has(roman)) {
          idx.set(roman, start);
        } else {
          // keep the earliest start if duplicates ever appear
          idx.set(roman, Math.min(idx.get(roman), start));
        }
      }
    }
  }

  _articleStartIndex = idx;
  return _articleStartIndex;
}

// Extract base article Roman numeral from strings like:
// "Article VI", "Article VI(A)", "Article XXIII(B)(3)", etc.
function extractBaseArticleRoman(label) {
  if (!label) return null;
  const m = label.match(/Article\s+([IVXLCDM]+)/i);
  return m ? m[1].toUpperCase() : null;
}

// Produce the <a> element
function makePdfLink(page) {
  const href = `/mlb/MLB_CBA_2022.pdf#page=${page}`;
  return `Page ${page} — <a href="${href}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

/**
 * Main entry:
 * Takes the full Assistant response text and:
 *  1) Normalizes every "Citation:" line to your mapped start page + clickable link
 *  2) Normalizes every LEGAL_EXCERPTS PAGE: N to your mapped start page + clickable link
 *  3) Leaves everything else intact
 */
export function linkifyCitations(fullText) {
  if (!fullText || typeof fullText !== 'string') return fullText;

  const articleIndex = buildArticleStartIndex();

  let out = fullText;

  // -----------------------------
  // A) Fix "Citation:" block lines
  //    Pattern to catch lines like:
  //    CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
  //    CBA (2022–2026), Article VI(E)(1)(b); Page 23 — Open page
  //
  // We will ignore the trailing "Page <n>" and replace with mapped start page.
  // -----------------------------
  out = out.replace(
    /(CBA\s*\(2022[\s–-]*2026\)\s*,?\s*Article\s+[IVXLCDM]+(?:\([^)]*\))*)(?:;?\s*Page\s*\d+\s*—\s*(?:Open page)?|\s*)(?=$)/gmi,
    (match, articleLabel) => {
      const roman = extractBaseArticleRoman(articleLabel);
      const start = roman ? articleIndex.get(roman) : null;
      if (!start) {
        // Couldn’t resolve; return original text without breaking it
        return `${articleLabel}`;
      }
      return `${articleLabel}; ${makePdfLink(start)}`;
    }
  );

  // Also handle cases where multiple citation lines appear on one line
  out = out.replace(
    /(CBA\s*\(2022[\s–-]*2026\)\s*,?\s*Article\s+[IVXLCDM]+(?:\([^)]*\))*)\s*;?\s*Page\s*\d+\s*—\s*(?:Open page)?/gmi,
    (match, articleLabel) => {
      const roman = extractBaseArticleRoman(articleLabel);
      const start = roman ? articleIndex.get(roman) : null;
      return start ? `${articleLabel}; ${makePdfLink(start)}` : match;
    }
  );

  // -----------------------------
  // B) Fix LEGAL_EXCERPTS header lines
  //    Format expected:
  //    ARTICLE: Article VI(E)(1)(b) | PAGE: 23
  // We replace the PAGE number with the mapped start page + link.
  // -----------------------------
  out = out.replace(
    /(ARTICLE:\s*Article\s+[IVXLCDM]+(?:\([^|]*\))?\s*\|\s*PAGE:\s*)(\d+)/gmi,
    (match, prefix) => {
      const artMatch = match.match(/ARTICLE:\s*Article\s+([IVXLCDM]+)/i);
      const roman = artMatch ? artMatch[1].toUpperCase() : null;
      const start = roman ? articleIndex.get(roman) : null;
      if (!start) return match; // leave unchanged if unknown
      return `${prefix}${start} — <a href="/mlb/MLB_CBA_2022.pdf#page=${start}" target="_blank" rel="noopener noreferrer">Open page</a>`;
    }
  );

  // -----------------------------
  // C) Final cleanup for any stray "Page N — Open page" without anchor
  //    (shouldn’t be necessary, but just in case)
  // -----------------------------
  out = out.replace(
    /Page\s+(\d+)\s+—\s*Open page/g,
    (m, p) => `Page ${p} — <a href="/mlb/MLB_CBA_2022.pdf#page=${p}" target="_blank" rel="noopener noreferrer">Open page</a>`
  );

  return out;
}
