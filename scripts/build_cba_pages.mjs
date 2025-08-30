// scripts/build_cba_pages.mjs
// One-time builder: reads public/mlb/MLB_CBA_2022.pdf -> writes public/mlb/cba_pages.json
// Output shape: [{ "page": 1, "text": "..." }, ...]
// We run this in GitHub Actions so you never have to run anything locally.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PDF_PATH = path.resolve(process.cwd(), "public/mlb/MLB_CBA_2022.pdf");
const OUT_PATH = path.resolve(process.cwd(), "public/mlb/cba_pages.json");

if (!fs.existsSync(PDF_PATH)) {
  console.error(`PDF not found at ${PDF_PATH}. Put MLB_CBA_2022.pdf there first.`);
  process.exit(1);
}

const data = new Uint8Array(fs.readFileSync(PDF_PATH));
const loadingTask = pdfjsLib.getDocument({ data });

const doc = await loadingTask.promise;
const pages = [];

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items.map((it) => (it.str || "")).join(" ");
  pages.push({ page: i, text });
  if (i % 10 === 0) console.log(`Extracted page ${i}/${doc.numPages}`);
}

fs.writeFileSync(OUT_PATH, JSON.stringify(pages), "utf-8");
console.log(`Wrote ${OUT_PATH} with ${pages.length} pages.`);
