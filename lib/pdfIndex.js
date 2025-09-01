// lib/pdfIndex.js
const fs = require("fs");
const path = require("path");

async function loadPageMap() {
  const p = path.join(process.cwd(), "public/mlb/page_map.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw); // e.g. { "XXIII.B.3 (CBT — Base Tax Rates)": 158, ... }
}

// strip extra spaces, unify formatting
const normKey = s =>
  (s || "")
    .replace(/[^A-Za-z0-9().—\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

// match user article string to map key
function lookupPage(article, pageMap) {
  const keyNorm = normKey(article);
  for (const [k, v] of Object.entries(pageMap)) {
    if (normKey(k).includes(keyNorm) || keyNorm.includes(normKey(k))) {
      return v;
    }
  }
  return null;
}

// ensure only one AI interpretation
function ensureOneAI(body) {
  const lines = body.split("\n");
  let seen = false, out = [];
  for (const line of lines) {
    if (/^\s*AI interpretation:/i.test(line)) {
      if (seen) continue;
      seen = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

// parse LEGAL_EXCERPTS block
function parseLegalExcerpts(answer) {
  const out = [];
  const blockMatch = answer.match(/LEGAL_EXCERPTS:\s*\n([\s\S]*)$/i);
  if (!blockMatch) return out;
  const rx = /^\s*ARTICLE:\s*(.*?)\s*\|\s*PAGE:\s*(\d+)?\s*\n\s*QUOTE:\s*"([\s\S]*?)"/gmi;
  let m;
  while ((m = rx.exec(blockMatch[1]))) {
    out.push({ article: m[1].trim(), page: m[2] ? Number(m[2]) : null, quote: m[3].trim() });
  }
  return out;
}

// rebuild Citation block
function rebuildCitation(assistantText, citeLines) {
  const rx = /(?:^|\n)Citation:\s*([\s\S]*?)(?:\n{2,}|$)/i;
  const repl = `\nCitation:\n${citeLines.join("\n")}\n\n`;
  if (rx.test(assistantText)) return assistantText.replace(rx, repl);
  return assistantText.trim() + repl;
}

async function attachVerification(answerText, questionText, pdfHref="/mlb/MLB_CBA_2022.pdf") {
  let body = ensureOneAI(String(answerText || ""));
  const pageMap = await loadPageMap();
  const items = parseLegalExcerpts(body);

  const citeLines = [];
  for (const it of items) {
    const pg = lookupPage(it.article, pageMap) || it.page;
    if (!pg) continue;
    citeLines.push(
      `CBA (2022–2026), ${it.article}; Page ${pg} — [Open page](${pdfHref}#page=${pg})`
    );
  }

  if (citeLines.length) {
    body = rebuildCitation(body, citeLines);
  }

  return { text: body, page: citeLines.length ? Number(citeLines[0].match(/Page (\d+)/)[1]) : 1 };
}

module.exports = { attachVerification };
