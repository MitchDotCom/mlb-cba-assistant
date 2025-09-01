// lib/linkifyCitations.js
// Rewrites page numbers/links by using ONLY the start page from public/mlb/page_map.json.
// We intentionally ignore whatever page number the model wrote.

import fs from "fs";
import path from "path";

// --- Helpers ---------------------------------------------------------------

function norm(s) {
  return String(s || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function loadPageMap() {
  try {
    const p = path.join(process.cwd(), "public", "mlb", "page_map.json");
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    // Fail-safe: return empty; we’ll render “page not found” instead of wrong pages.
    return {};
  }
}

// Build a simple “Article roman → start page” lookup, using the `title` field.
// We look for titles that begin with "ARTICLE <ROMAN>—" (em dash).
function buildArticleStartIndex(pageMap) {
  const idx = {};
  const re = /^article\s+([ivxlcdm]+)\s*[\u2014-]/i; // em dash or hyphen
  for (const k of Object.keys(pageMap || {})) {
    const v = pageMap[k] || {};
    const title = String(v.title || "");
    const start = Number(v.start);
    if (!title || !Number.isFinite(start)) continue;
    const m = norm(title).match(re);
    if (m) {
      const roman = (m[1] || "").toUpperCase();
      // First hit wins; this should already be the article-start entry.
      if (!(roman in idx)) idx[roman] = start;
    }
  }
  return idx;
}

// Parse "Article XXIII(B)(3)" => { roman: "XXIII" }
function parseArticleLabel(label) {
  if (!label) return null;
  const m = label.match(/article\s+([ivxlcdm]+)/i);
  if (!m) return null;
  return { roman: m[1].toUpperCase() };
}

function makePageLink(pdfHref, page) {
  const p = Number(page);
  if (!Number.isFinite(p)) return "";
  return ` — <a href="${pdfHref}#page=${p}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

// --- Core ------------------------------------------------------------------

export function linkifyCitations(modelText, pdfHref = "/mlb/MLB_CBA_2022.pdf") {
  if (!modelText || typeof modelText !== "string") return modelText || "";

  const pageMap = loadPageMap();
  const articleStart = buildArticleStartIndex(pageMap);

  const lines = modelText.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // 1) CITATION lines, e.g.:
    //    CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
    if (/^\s*CBA\s*\(.*\),\s*Article\s+[^;]+;/.test(line)) {
      const m = line.match(/Article\s+([^;]+);/i);
      const label = m ? m[1] : "";
      const parsed = parseArticleLabel(label);
      let page = null;
      if (parsed && parsed.roman && articleStart[parsed.roman]) {
        page = articleStart[parsed.roman];
      }

      if (page) {
        line = line.replace(/;.*$/, `; Page ${page}${makePageLink(pdfHref, page)}`);
      } else {
        // Don’t propagate wrong data; blank it explicitly
        line = line.replace(/;.*$/, `; Page — (page not found)`);
      }
      out.push(line);
      continue;
    }

    // 2) LEGAL_EXCERPTS lines, e.g.:
    //    ARTICLE: Article VI(A)(1) | PAGE: 23
    const art = line.match(/^\s*ARTICLE:\s*(.+?)\s*\|\s*PAGE:\s*.*$/i);
    if (art) {
      const label = art[1];
      const parsed = parseArticleLabel(label);
      let page = null;
      if (parsed && parsed.roman && articleStart[parsed.roman]) {
        page = articleStart[parsed.roman];
      }
      if (page) {
        line = `ARTICLE: ${label} | PAGE: ${page}${makePageLink(pdfHref, page)}`;
      } else {
        line = `ARTICLE: ${label} | PAGE: —`;
      }
      out.push(line);
      continue;
    }

    // passthrough
    out.push(line);
  }

  return out.join("\n");
}

export default linkifyCitations;
