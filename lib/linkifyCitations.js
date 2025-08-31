// lib/linkifyCitations.js
export function linkifyCitations(text) {
  if (!text) return text;

  // Normalize em/en dashes around "Open page"
  let out = String(text).replace(/—|–/g, "—");

  // Turn "Page 158 — Open page" into a markdown link everywhere (Citation + Source text)
  out = out.replace(
    /Page\s+(\d{1,4})\s+—\s+Open page/gi,
    (_m, n) => `Page ${n} — [Open page](/mlb/MLB_CBA_2022.pdf#page=${n})`
  );

  return out;
}
