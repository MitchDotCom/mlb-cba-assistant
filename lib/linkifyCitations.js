// lib/linkifyCitations.js
// Rewrites ONLY the page numbers/links in the assistant text using page_map.json as the single source of truth.

function norm(s) {
  return String(s || "")
    .replace(/[\u2018\u2019\u201C\u201D]/g, '"')     // smart quotes -> straight
    .replace(/\u00A0/g, " ")                       // nbsp -> space
    .replace(/\s+/g, " ")                          // collapse spaces
    .trim()
    .toLowerCase();
}

function buildEntries(pageMap) {
  const entries = [];
  for (const k of Object.keys(pageMap || {})) {
    const v = pageMap[k] || {};
    const title = String(v.title || "");
    const start = Number(v.start);
    if (!title || !Number.isFinite(start)) continue;
    entries.push({
      key: k,
      start,
      title,
      tnorm: norm(title),
    });
  }
  // Sort by start page just in case (not strictly required)
  entries.sort((a, b) => a.start - b.start);
  return entries;
}

// Specific subsection labels we can key off when quotes are missing.
// (We only add the ones you actually use a lot; fallback search remains global)
const VI_Subsections = {
  A: "Minimum Salary",
  B: "Maximum Salary Reduction",
  C: "Standard Length of Season",
  D: "Salary Continuation—Military Encampment",
  E: "Salary Arbitration",
};

// Exact phrase match inside the page_map titles
function findPageByQuote(entries, quote) {
  if (!quote) return null;
  let q = quote;
  // trim outer quotes and ellipses
  q = q.replace(/^["“]+/, "").replace(/["”]+$/, "");
  // We want strict substring (EXACT phrase) but normalize spacing/quotes
  const qn = norm(q);
  if (qn.length < 20) return null; // tiny fragments are too noisy; skip
  for (const e of entries) {
    if (e.tnorm.includes(qn)) {
      return e.start;
    }
  }
  return null;
}

// Use the Article label if available (e.g., "Article VI(A)(1)", "Article VI(E)")
function findPageByArticleLabel(entries, label) {
  if (!label) return null;
  const m = /article\s+([ivxlcdm]+)(?:\(([A-Z])\)(?:\(\d+\))?)?/i.exec(label);
  if (!m) return null;
  const roman = (m[1] || "").toUpperCase();
  const letter = m[2]; // e.g., A,B,C,...

  // If we have a subsection letter for Article VI, look for its named heading
  if (roman === "VI" && letter && VI_Subsections[letter]) {
    const needle = norm(`${letter}. ${VI_Subsections[letter]}`);
    for (const e of entries) {
      if (e.tnorm.includes(needle)) return e.start;
    }
  }

  // Fallback: find the main article entry ("ARTICLE VI—")
  const needleArticle = norm(`ARTICLE ${roman}—`);
  for (const e of entries) {
    if (e.tnorm.includes(needleArticle)) return e.start;
  }

  return null;
}

function makeLink(pdfHref, page) {
  const p = Number(page);
  if (!Number.isFinite(p)) return "";
  return ` — <a href="${pdfHref}#page=${p}" target="_blank" rel="noopener noreferrer">Open page</a>`;
}

export function linkifyCitationsWithMap(rawText, pageMap, pdfHref = "/mlb/MLB_CBA_2022.pdf") {
  if (!rawText || typeof rawText !== "string") return rawText || "";
  const entries = buildEntries(pageMap);

  const lines = rawText.split(/\r?\n/);
  const out = [];

  // We need to handle two patterns:
  // 1) CITATION lines, e.g.:
  //    "CBA (2022–2026), Article VI(A)(1); Page 23 — Open page"
  // 2) LEGAL_EXCERPTS block lines, e.g.:
  //    "ARTICLE: Article VI(A)(1) | PAGE: 18"
  //    next line: 'QUOTE: "The minimum salary ... 2022 ... 2026."'

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // --- Pattern 1: Plain citation lines starting with "CBA ("
    // We rebuild the entire trailing page/link segment from mapping.
    if (/^\s*CBA\s*\(.*\),\s*Article\s+[^;]+;/.test(line)) {
      const m = line.match(/Article\s+([^;]+);/i);
      const articleLabel = m ? m[1] : "";
      const page = findPageByArticleLabel(entries, articleLabel);
      if (page) {
        // Replace any existing "; Page ... — ..." tail with corrected one
        line = line.replace(/;.*$/, `; Page ${page}${makeLink(pdfHref, page)}`);
      } else {
        // Keep the line but nuke the incorrect page if present
        line = line.replace(/;.*$/, `; Page — (page not found)`);
      }
      out.push(line);
      continue;
    }

    // --- Pattern 2: LEGAL_EXCERPTS "ARTICLE: ... | PAGE: ..."
    const art = line.match(/^\s*ARTICLE:\s*(.+?)\s*\|\s*PAGE:\s*.*$/i);
    if (art) {
      const label = art[1];

      // Look ahead for the corresponding QUOTE line to get an exact phrase
      const next = lines[i + 1] || "";
      const qm = next.match(/^\s*QUOTE:\s*["“]?(.+?)["”]?\s*$/i);
      let page = null;

      if (qm) {
        page = findPageByQuote(entries, qm[1]);
      }
      if (!page) {
        page = findPageByArticleLabel(entries, label);
      }

      if (page) {
        line = `ARTICLE: ${label} | PAGE: ${page}${makeLink(pdfHref, page)}`;
      } else {
        // Keep original line but remove/blank the page number (don’t spread wrong data)
        line = `ARTICLE: ${label} | PAGE: —`;
      }

      out.push(line);
      continue;
    }

    // Default passthrough
    out.push(line);
  }

  return out.join("\n");
}

export default linkifyCitationsWithMap;
