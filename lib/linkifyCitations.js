// /lib/linkifyCitations.js
// Rewrites "Citation:" and "LEGAL_EXCERPTS:" lines to use the START PAGE from /public/mlb/page_map.json.
// We IGNORE any page numbers provided by OpenAI output.
// We DO NOT guess; we map only by Article/Section label.
//
// Expected inputs to map (examples in your data):
// "Article XXIII(B)(3)" -> "XXIII.B.3"
// "Article XXIII(C)"    -> "XXIII.C"
// "Article VI(E)(1)(b)" -> "VI.E.1(b)"
//
// Keys in page_map.json typically look like:
// "XXIII.B.3 (CBT — Base Tax Rates)": 118
// → we match by the compact key before the first space: "XXIII.B.3"
//
// If we can’t resolve a label, we leave the line untouched (fail-safe).

import fs from "fs";
import path from "path";

let PAGE_MAP = {};
let KEY_INDEX = new Map(); // normalizedKey -> startPage

function loadPageMap() {
  try {
    const p = path.join(process.cwd(), "public", "mlb", "page_map.json");
    const txt = fs.readFileSync(p, "utf8");
    PAGE_MAP = JSON.parse(txt);

    KEY_INDEX.clear();
    for (const rawKey of Object.keys(PAGE_MAP)) {
      // Take everything before the first " (" (strip any description)
      const compact = rawKey.split(" (")[0].trim();          // e.g., "XXIII.B.3"
      const norm = normalizeKey(compact);                    // normalized → "XXIII.B.3"
      KEY_INDEX.set(norm, PAGE_MAP[rawKey]);                 // store start page
    }
  } catch (e) {
    console.error("[linkifyCitations] Failed to load /public/mlb/page_map.json:", e?.message || e);
    PAGE_MAP = {};
    KEY_INDEX.clear();
  }
}

// Normalize keys to a consistent dot/paren notation
function normalizeKey(s) {
  return s.replace(/\s+/g, "").trim(); // keep dots/parens as-is
}

// Convert “Article VI(E)(1)(b)” → candidate keys to try: [ "VI.E.1(b)", "VI.E.1", "VI.E", "VI" ]
function articleLabelToCandidates(articleLabel) {
  if (!articleLabel) return [];
  let s = String(articleLabel).trim();

  // Strip leading "Article " and whitespace
  s = s.replace(/^Article\s+/i, "");

  // Remove all whitespace
  s = s.replace(/\s+/g, "");

  // Quick sanity: must start with Roman numerals
  const m = s.match(/^([IVXLCDM]+)(.*)$/i);
  if (!m) return [];
  const roman = m[1].toUpperCase();
  let rest = m[2] || "";

  // Parse a chain of segments like (E)(1)(b)
  const segs = [];
  while (rest.startsWith("(")) {
    const seg = rest.match(/^\(([A-Za-z0-9]+)\)/);
    if (!seg) break;
    segs.push(seg[1]); // e.g., E, 1, b
    rest = rest.slice(seg[0].length);
  }

  // Build candidates from most specific -> least
  // Use dot between alphanumeric segments; keep lowercase in final parens if present
  const alnum = [];
  let finalParen = null;
  for (const s2 of segs) {
    if (/^[0-9]+$/.test(s2)) {
      alnum.push(s2);
    } else if (/^[A-Z]+$/.test(s2)) {
      alnum.push(s2.toUpperCase());
    } else if (/^[a-z]+$/.test(s2)) {
      // assume only one lowercase final subclause is useful to preserve as "(x)"
      finalParen = s2;
    }
  }

  const candidates = [];
  // Most specific with final paren, if present
  if (alnum.length > 0) {
    const base = `${roman}.${alnum.join(".")}`;
    if (finalParen) candidates.push(`${base}(${finalParen})`);
    candidates.push(base);
  } else {
    candidates.push(roman);
  }

  // Also progressively generalize (drop trailing dot segments)
  if (alnum.length >= 2) {
    for (let cut = alnum.length - 1; cut >= 1; cut--) {
      candidates.push(`${roman}.${alnum.slice(0, cut).join(".")}`);
    }
  }
  // Finally, the pure article roman as last resort
  if (!candidates.includes(roman)) candidates.push(roman);

  // Normalize
  return [...new Set(candidates.map(normalizeKey))];
}

function findStartPageForLabel(articleLabel) {
  const cands = articleLabelToCandidates(articleLabel);
  for (const c of cands) {
    if (KEY_INDEX.has(c)) return KEY_INDEX.get(c);
  }
  return null;
}

// Replace the "Page N — Open page" portion with a link built from our mapping.
// Accepts both Citation lines and LEGAL_EXCERPTS ARTICLE lines.
function rewriteLineWithLink(line, articleLabel) {
  const startPage = findStartPageForLabel(articleLabel);
  if (!startPage) return line; // leave untouched if we can't resolve

  const link = `/mlb/MLB_CBA_2022.pdf#page=${startPage}`;

  // If it's a Citation line already containing "Page ..." replace that section;
  // otherwise, append our canonical page info.
  if (/; Page\s+\d+\s+—\s+Open page/i.test(line)) {
    return line.replace(/; Page\s+\d+\s+—\s+Open page/i, `; Page ${startPage} — <a href="${link}" target="_blank" rel="noopener noreferrer">Open page</a>`);
  }

  // LEGAL_EXCERPTS ARTICLE line: keep as-is; we'll modify the companion PAGE line instead.
  return line;
}

function rewritePageLine(pageLine, articleLabel) {
  const startPage = findStartPageForLabel(articleLabel);
  if (!startPage) return pageLine;
  const link = `/mlb/MLB_CBA_2022.pdf#page=${startPage}`;
  return `PAGE: ${startPage} — <a href="${link}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

// Main exported function
export async function linkifyCitations(raw) {
  // Load/refresh mapping once per cold start
  if (KEY_INDEX.size === 0) loadPageMap();

  const lines = String(raw).split(/\r?\n/);
  const out = [];
  let inLegal = false;
  let lastArticleLabel = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Start/stop LEGAL_EXCERPTS block detection
    if (/^\s*LEGAL_EXCERPTS\s*:?\s*$/i.test(line)) {
      inLegal = true;
      lastArticleLabel = null;
      out.push(line);
      continue;
    }

    if (inLegal) {
      // Capture ARTICLE line
      const artMatch = line.match(/^\s*ARTICLE:\s*(.+?)\s*\|\s*PAGE:\s*.*$/i) ||
                       line.match(/^\s*ARTICLE:\s*(.+?)\s*$/i);
      if (artMatch) {
        lastArticleLabel = artMatch[1].trim();
        // Don't touch ARTICLE line itself, the PAGE line next will be rewritten
        out.push(line);
        continue;
      }

      // Rewrite PAGE: ... line using the ARTICLE label we just captured
      if (/^\s*PAGE:\s*/i.test(line) && lastArticleLabel) {
        out.push(rewritePageLine(line, lastArticleLabel));
        continue;
      }

      // End of LEGAL_EXCERPTS: if we hit a blank line followed by non-LEGAL content, we keep going normally
      out.push(line);
      continue;
    }

    // Outside LEGAL_EXCERPTS: handle Citation lines
    // Example: CBA (2022–2026), Article VI(E)(1)(b); Page 23 — Open page
    const citMatch = line.match(/CBA\s*\(.*?\),\s*Article\s+([^;]+);/i);
    if (citMatch) {
      const articleLabel = `Article ${citMatch[1].trim()}`;
      line = rewriteLineWithLink(line, articleLabel);
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
