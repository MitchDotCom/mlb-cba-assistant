// /lib/linkifyCitations.js
//
// Rewrites only the "Citation:" lines in the assistant text.
// It ignores model-provided page numbers and injects the correct PDF page
// using your public/mlb/page_map.json mapping.
//
// Output uses Markdown links ([Open page](...)) so ReactMarkdown will linkify.

function toDotPath(articleLabel) {
  // e.g. "Article XXIII(B)(3)(b)" -> "XXIII.B.3.B"
  if (!articleLabel) return "";
  const roman = (articleLabel.match(/Article\s+([IVXLC]+)/i) || [])[1];
  if (!roman) return "";
  const parts = [];
  const subs = articleLabel.match(/\(([A-Za-z0-9]+)\)/g) || [];
  for (const s of subs) {
    let v = s.replace(/[()]/g, "");
    // Uppercase letters, keep digits
    v = /^[A-Za-z]+$/.test(v) ? v.toUpperCase() : v;
    parts.push(v);
  }
  return [roman.toUpperCase(), ...parts].join(".");
}

function keySlug(key) {
  // "XXIII.B.3 (CBT — Base Tax Rates)" -> "XXIII.B.3"
  return String(key || "").split(" ")[0].trim();
}

// Returns a PDF page number (integer) or null.
function findPageForArticle(articleLabel, pageMapObj) {
  if (!pageMapObj || typeof pageMapObj !== "object") return null;

  const dot = toDotPath(articleLabel);      // e.g. "XXIII.B.3"
  const roman = (articleLabel.match(/Article\s+([IVXLC]+)/i) || [])[1]?.toUpperCase();

  // 1) Exact/starts-with match on slug
  if (dot) {
    // Exact slug match
    for (const k of Object.keys(pageMapObj)) {
      if (keySlug(k) === dot) return Number(pageMapObj[k]) || null;
    }
    // Prefix match (allow more specific keys in map)
    for (const k of Object.keys(pageMapObj)) {
      if (keySlug(k).startsWith(dot)) return Number(pageMapObj[k]) || null;
    }
    // If the dot path is *more* specific than keys, allow reverse
    for (const k of Object.keys(pageMapObj)) {
      const slug = keySlug(k);
      if (dot.startsWith(slug)) return Number(pageMapObj[k]) || null;
    }
  }

  // 2) Fallback: article start (prefer an "ARTICLE <ROMAN>—..." key or plain "<ROMAN>")
  if (roman) {
    // Plain ROMAN (article start) – many maps include "XXIII (CBT — Article Start)"
    for (const k of Object.keys(pageMapObj)) {
      const slug = keySlug(k);
      if (slug === roman) return Number(pageMapObj[k]) || null;
    }
    // Any key that begins with ROMAN – take the smallest page number as the article start
    let best = null;
    for (const k of Object.keys(pageMapObj)) {
      if (keySlug(k).startsWith(roman)) {
        const p = Number(pageMapObj[k]) || null;
        if (p && (best === null || p < best)) best = p;
      }
    }
    if (best !== null) return best;
  }

  return null;
}

export function linkifyCitationsWithMap(text, pageMapObj, pdfHref = "/mlb/MLB_CBA_2022.pdf") {
  if (!text || typeof text !== "string") return text;

  // Grab only the three Citation lines (don’t touch LEGAL_EXCERPTS)
  // Typical line:
  // CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
  const citationLineRe = /^(\s*CBA\s*\(.*?\),\s*Article\s+([^;]+);\s*)Page\s+\d+\s+—\s+Open page\s*$/gmi;

  return text.replace(citationLineRe, (full, pre, articleLabel) => {
    // articleLabel here is like "XXIII(B)(3)" or "VI(A)(1)"
    const labelFull = `Article ${articleLabel}`; // restore "Article "
    const page = findPageForArticle(labelFull, pageMapObj);

    if (page) {
      return `${pre}Page ${page} — [Open page](${pdfHref}#page=${page})`;
    }
    // If we cannot find a page confidently, keep the line but drop the bad link
    return `${pre}Page — Open page`;
  });
}
