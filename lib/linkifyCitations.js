// lib/linkifyCitations.js
import fs from "fs";
import path from "path";

let _pageMap = null;
function loadPageMap() {
  if (_pageMap) return _pageMap;
  const p = path.join(process.cwd(), "public", "mlb", "page_map.json");
  const raw = fs.readFileSync(p, "utf8");
  const obj = JSON.parse(raw);

  // Build a "clean" map (strip any descriptive suffix after ' (')
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.split(" (")[0].trim(); // e.g. "XXIII.B.3"
    clean[key] = v; // v is the PDF viewer page number (1-based)
  }
  _pageMap = clean;
  return _pageMap;
}

// Convert "Article VI(E)(1)(b)" -> "VI.E.1(b)"
function normalizeArticleLabel(articleLabelRaw) {
  // remove "Article " prefix, spaces, and weird dashes
  let s = articleLabelRaw.replace(/^Article\s+/i, "").replace(/\s+/g, "");
  // Extract roman numeral at start
  const m = s.match(/^([IVXLCDM]+)/i);
  if (!m) return null;
  const roman = m[1].toUpperCase();
  let rest = s.slice(roman.length);

  // Pull (...) groups, e.g. (E)(1)(b)
  const groups = [];
  const re = /\(([A-Za-z0-9]+)\)/g;
  let g;
  while ((g = re.exec(rest)) !== null) {
    groups.push(g[1]);
  }

  if (groups.length === 0) {
    // e.g. just "XXIII"
    return roman;
  }

  // Build normalized key:
  // All groups become ".<group>" except the LAST single-letter lowercase group which becomes "(x)"
  const parts = [roman];
  for (let i = 0; i < groups.length; i++) {
    const token = groups[i];
    const isLast = i === groups.length - 1;
    if (isLast && /^[a-z]$/.test(token)) {
      parts[parts.length - 1] = parts[parts.length - 1] + `(${token})`; // attach "(b)" to previous segment
    } else {
      // uppercase section letters should stay uppercase (e.g., E), numbers as-is
      const segment = /^[A-Za-z]$/.test(token) ? token.toUpperCase() : token;
      parts.push(segment);
    }
  }
  // Join with dots between segments except where we appended (x)
  // Example path: ["VI","E","1(b)"] => "VI.E.1(b)"
  const out = parts
    .map((p, idx) => {
      if (idx === 0) return p;
      return p.includes("(") ? p : `.${p}`;
    })
    .join("");

  return out;
}

// Given a normalized key like "XXIII.B.3", return PDF page from page_map.json
function lookupPdfPage(normalizedKey, map) {
  if (!normalizedKey) return null;

  // try exact
  if (map[normalizedKey] != null) return map[normalizedKey];

  // try stripping trailing parenthetical "(x)"
  let k = normalizedKey;
  if (/\([^)]+\)$/.test(k)) {
    const withoutParen = k.replace(/\([^)]+\)$/, "");
    if (map[withoutParen] != null) return map[withoutParen];
    k = withoutParen;
  }

  // progressively strip deepest ".segment"
  while (k.includes(".")) {
    k = k.replace(/\.[^.]+$/, ""); // drop last .segment
    if (map[k] != null) return map[k];
  }

  // Try very coarse: just roman article
  if (map[k] != null) return map[k];

  // As a last-ditch: fuzzy prefix match (pick first hit)
  const prefix = normalizedKey.split("(")[0];
  const hit = Object.keys(map).find((key) => key.startsWith(prefix));
  if (hit) return map[hit];

  return null;
}

// Replace "Citation:" lines to use page_map and add working Open page links.
// We ONLY touch the Citation block. Everything else is passed through unchanged.
export function linkifyCitationsAndFixPages(fullText) {
  const map = loadPageMap();

  const lines = fullText.split(/\r?\n/);
  const out = [];

  let inCitationBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (/^Citation\s*:?/i.test(line)) {
      inCitationBlock = true;
      out.push(line.trim()); // keep the "Citation:" header line
      continue;
    }
    if (/^LEGAL_EXCERPTS\s*:?/i.test(line)) {
      inCitationBlock = false; // stop modifying at LEGAL_EXCERPTS
      out.push(line);
      continue;
    }
    if (inCitationBlock) {
      // Expected per-line format (from your system prompt):
      // CBA (2022–2026), Article VI(E)(1)(b); Page 23 — Open page
      // We will re-derive Page N from the Article/Section using page_map.json.
      const m = line.match(/CBA\s*\(2022–2026\),\s*Article\s+([^;]+);\s*Page\s+(\d+)/i);
      if (m) {
        const rawArticle = m[1].trim();                 // e.g. "VI(E)(1)(b)"
        const normalized = normalizeArticleLabel(rawArticle); // e.g. "VI.E.1(b)"
        const pdfPage = lookupPdfPage(normalized, map);

        if (pdfPage != null) {
          // Rebuild the line with corrected page and a working link
          line = line.replace(/Page\s+\d+.*/i, `Page ${pdfPage} — Open page`);
          // Add markdown link if not present
          if (!/\[Open page\]\(/i.test(line)) {
            line = line.replace(
              /Open page/i,
              `[Open page](/mlb/MLB_CBA_2022.pdf#page=${pdfPage})`
            );
          } else {
            // If someone already injected a link, ensure it points to the right page
            line = line.replace(
              /\(\/mlb\/MLB_CBA_2022\.pdf#page=\d+\)/i,
              `(/mlb/MLB_CBA_2022.pdf#page=${pdfPage})`
            );
          }
        } else {
          // Could not map — still ensure Open page link uses the model’s page number
          const fallbackMatch = line.match(/Page\s+(\d+)/i);
          const fallback = fallbackMatch ? Number(fallbackMatch[1]) : null;
          if (fallback) {
            if (!/\[Open page\]\(/i.test(line)) {
              line = line.replace(
                /Open page/i,
                `[Open page](/mlb/MLB_CBA_2022.pdf#page=${fallback})`
              );
            }
          }
        }

        out.push(line);
        continue;
      }
      // Not a recognizable citation line; just pass through
      out.push(line);
      continue;
    }

    // Outside Citation block
    out.push(line);
  }

  return out.join("\n");
}
