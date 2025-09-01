// lib/linkifyCitations.js
import fs from "fs";
import path from "path";

// Load the verified map at runtime (server-only)
function loadPageMap() {
  try {
    const pageMapPath = path.join(process.cwd(), "public", "mlb", "page_map.json");
    const raw = fs.readFileSync(pageMapPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load page_map.json:", err);
    return {};
  }
}

// Cache once per process
let PAGE_MAP = loadPageMap();

/**
 * Replace raw citations with links that point to the correct PDF page,
 * using ONLY the verified mapping in page_map.json.
 * - Ignores any page number emitted by the assistant.
 * - Always uses the `start` page from PAGE_MAP.
 * - If no mapping key is found, leaves the citation text as-is (no link).
 */
export default function linkifyCitations(text) {
  if (!text || typeof text !== "string") return text;

  // Normalize dash variants just in case (–, — -> -)
  const norm = text.replace(/[—–]/g, "-");

  // Pattern: CBA (2022–2026), Article XXIII(B)(3); Page 158 — Open page
  // We ignore the trailing page stuff and rebuild it from PAGE_MAP.
  const citationRegex =
    /CBA\s*\(2022-?2026\),\s*Article\s+([A-Z0-9().\-]+)(?:;?\s*Page\s*\d+\s*—\s*(?:Open page|<a[\s\S]*?<\/a>))?/gi;

  return norm.replace(citationRegex, (match, articleLabelRaw) => {
    const articleLabel = articleLabelRaw.trim();

    // find a mapping key that includes this label, preferring exact/specific matches
    const keys = Object.keys(PAGE_MAP);
    let foundKey = null;

    // 1) exact (case-sensitive)
    foundKey = keys.find((k) => k === articleLabel);
    // 2) starts with
    if (!foundKey) foundKey = keys.find((k) => k.startsWith(articleLabel));
    // 3) contains
    if (!foundKey) foundKey = keys.find((k) => k.includes(articleLabel));

    if (foundKey) {
      const start = PAGE_MAP[foundKey]?.start;
      if (Number.isFinite(start)) {
        const link = `/mlb/MLB_CBA_2022.pdf#page=${start}`;
        return `CBA (2022–2026), Article ${articleLabel}; Page ${start} — <a href="${link}" target="_blank" rel="noopener noreferrer">Open page</a>`;
      }
    }
    // Fallback: return the original without altering (no invalid link)
    return `CBA (2022–2026), Article ${articleLabel}`;
  });
}
