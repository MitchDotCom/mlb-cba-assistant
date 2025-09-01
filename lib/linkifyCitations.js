import pageMap from "../public/mlb/page_map.json";

/**
 * Replace raw citations in assistant output with links to the correct PDF pages,
 * based ONLY on the verified mapping in page_map.json.
 * We ignore any page numbers from the assistant.
 */
export default function linkifyCitations(text) {
  if (!text) return "";

  // Regex to catch article-style citations in the assistant output
  const citationRegex = /CBA\s*\(2022–2026\),\s*Article\s+([A-Z0-9().\-–]+)(?:; Page \d+)?/g;

  return text.replace(citationRegex, (match, articleLabel) => {
    // Try exact match from page_map.json
    const mappingKey = Object.keys(pageMap).find(key =>
      key.includes(articleLabel)
    );

    if (mappingKey) {
      const startPage = pageMap[mappingKey].start;
      return `CBA (2022–2026), Article ${articleLabel}; Page ${startPage} — <a href="/mlb/MLB_CBA_2022.pdf#page=${startPage}" target="_blank" rel="noopener noreferrer">Open page</a>`;
    }

    // If no mapping found, return plain text without link
    return `CBA (2022–2026), Article ${articleLabel}`;
  });
}
