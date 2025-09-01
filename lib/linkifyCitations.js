// /lib/linkifyCitations.js
//
// Converts plain citation markers like:
//   Page 158 — Open page
// into clickable links pointing to your public CBA PDF.
// Make sure the path below matches the actual location of your PDF in /public.

export function linkifyCitations(text) {
  if (!text || typeof text !== "string") return text;

  // Regex to match "Page <number> — Open page"
  const pageRegex = /Page\s+(\d+)\s+—\s+Open page/gi;

  return text.replace(pageRegex, (match, pageNum) => {
    const url = `/mlb/MLB_CBA_2022.pdf#page=${pageNum}`;
    return `Page ${pageNum} — <a href="${url}" target="_blank" rel="noopener noreferrer">Open page</a>`;
  });
}
