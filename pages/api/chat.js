import { Configuration, OpenAIApi } from "openai";
import { resolvePageNumber } from "../../lib/resolvePageNumber.js";

// Ensure API key is set
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Main API handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0,
    });

    let output = completion.choices[0].message.content;

    // Post-process citations to swap in correct page numbers
    output = linkifyCitations(output);

    return res.status(200).json({ result: output });
  } catch (err) {
    console.error("Error in chat handler:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Replace Assistant-supplied citations with trusted PDF links
 */
function linkifyCitations(text) {
  const citationRegex =
    /CBA \(2022–2026\), Article ([A-Za-z0-9().–]+)(?:; Page \d+)?/g;

  return text.replace(citationRegex, (match, articleKey) => {
    const page = resolvePageNumber(`Article ${articleKey}`);
    if (page) {
      return `CBA (2022–2026), Article ${articleKey}; Page ${page} — <a href="/mlb/MLB_CBA_2022.pdf#page=${page}" target="_blank" rel="noopener noreferrer">Open page</a>`;
    }
    // fallback: keep the original if no mapping
    return match;
  });
}
