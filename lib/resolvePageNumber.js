import pageMap from "../public/mlb/page_map.json";

/**
 * Look up the real PDF page number for an Article/Section key
 */
export function resolvePageNumber(articleKey) {
  // Exact match
  if (pageMap[articleKey]) {
    return pageMap[articleKey];
  }

  // Fuzzy match — find first entry that starts with the requested key
  const found = Object.entries(pageMap).find(([key]) =>
    articleKey.startsWith(key)
  );
  if (found) {
    return found[1];
  }

  // Not found
  return null;
}
