// /lib/linkifyCitations.js
export function linkifyCitations(text) {
  if (!text) return text;

  // normalize dash usage to em dash
  let out = String(text).replace(/—|–/g, "—");

  // Page 158 — Open page  ->  Page 158 — [Open page](/mlb/MLB_CBA_2022.pdf#page=158)
  out = out.replace(
    /Page\s+(\d{1,4})\s+—\s+Open page/gi,
    (_m, n) => `Page ${n} — [Open page](/mlb/MLB_CBA_2022.pdf#page=${n})`
  );

  return out;
}
