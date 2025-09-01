// lib/linkifyCitations.js
// Deterministic page-linking:
// - Ignore the model's page numbers completely.
// - Use only Article start pages from public/mlb/page_map.json.
// - Rewrite PAGE numbers + add <a> link, preserving any trailing text (e.g., QUOTE: ...).

import fs from "fs";
import path from "path";

// Normalize for simple matching
function norm(s) {
  return String(s || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Load the map once per invocation
function loadPageMap() {
  try {
    const p = path.join(process.cwd(), "public", "mlb", "page_map.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

// Build: "VI" -> 25, "XXIII" -> 115, etc.
function buildArticleStartIndex(pageMap) {
  const idx = {};
  const re = /^article\s+([ivxlcdm]+)\s*[\u2014-]/i; // "ARTICLE VI—Salaries" (em dash or hyphen)
  for (const key of Object.keys(pageMap)) {
    const entry = pageMap[key];
    if (!entry || typeof entry.title !== "string") continue;
    const title = norm(entry.title);
    const m = title.match(re);
    if (!m) continue;
    const roman = (m[1] || "").toUpperCase();
    const start = Number(entry.start);
    if (!Number.isFinite(start)) continue;
    if (!(roman in idx)) idx[roman] = start; // first win = article start
  }
  return idx;
}

function parseArticleRoman(label) {
  if (!label) return null;
  const m = label.match(/article\s+([ivxlcdm]+)/i);
  return m ? (m[1] || "").toUpperCase() : null;
}

function makeLink(pdfHref, page) {
  return ` — <a href="${pdfHref}#page=${page}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

export function linkifyCitations(modelText, pdfHref = "/mlb/MLB_CBA_2022.pdf") {
  if (typeof modelText !== "string" || !modelText.trim()) return modelText || "";

  const map = loadPageMap();
  const startIndex = buildArticleStartIndex(map);

  let text = modelText;

  // 1) CITATION lines (whole-line rewrite)
  //    Example source lines to catch (we ignore the model's page number):
  //    CBA (2022–2026), Article VI(A)(1); Page 18 — Open page
  //    CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
  text = text.replace(
    /^(\s*CBA\s*\([^)]*\),\s*Article\s+)([^;]+)(;[^\n]*)$/gim,
    (m, prefix, label /* e.g., 'VI(A)(1)' */, _rest) => {
      const roman = parseArticleRoman(`Article ${label}`);
      const page = roman && startIndex[roman] ? startIndex[roman] : null;
      if (page) {
        return `${prefix}${label}; Page ${page}${makeLink(pdfHref, page)}`;
      }
      return `${prefix}${label}; Page — (page not found)`;
    }
  );

  // 2) LEGAL_EXCERPTS "ARTICLE: ... | PAGE: ..." (in-place PAGE rewrite, preserve tail)
  //
  //    We only replace the PAGE: segment and keep trailing text (e.g., " QUOTE: ...").
  //
  //    Captures:
  //      1 = the full article label ("Article VI(A)(1)")
  //      2 = whatever follows PAGE: up to the point we detect a boundary
  //      3 = the boundary and remaining tail (either " QUOTE: ..." or newline/end)
  //
  text = text.replace(
    /ARTICLE:\s*(Article\s+[^\|]+)\|\s*PAGE:\s*([^\n]*?)(?=(\s+QUOTE:|$|\n))/gim,
    (m, label, _oldPage, tail) => {
      const roman = parseArticleRoman(label);
      const page = roman && startIndex[roman] ? startIndex[roman] : null;
      if (page) {
        return `ARTICLE: ${label}| PAGE: ${page}${makeLink(pdfHref, page)}${tail || ""}`;
      }
      return `ARTICLE: ${label}| PAGE: —${tail || ""}`;
    }
  );

  return text;
}

export default linkifyCitations;
