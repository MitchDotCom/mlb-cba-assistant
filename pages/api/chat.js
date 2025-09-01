// pages/api/chat.js
import OpenAI from "openai";
import pageMap from "../../lib/page_map.json";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function resolvePageNumber(quote) {
  if (!quote) return null;
  for (const [section, page] of Object.entries(pageMap)) {
    if (quote.includes(section)) {
      return page;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are the MLB CBA Assistant. Always provide structured answers with Summary, How it works, Edge cases, Disclaimer, Citation, and LEGAL_EXCERPTS.",
        },
        { role: "user", content: prompt },
      ],
    });

    // Robustly extract assistant reply
    let text =
      completion.choices?.[0]?.message?.content ||
      completion.choices?.[0]?.text ||
      "No response from model.";

    // Add PDF links to "Page X" mentions
    text = text.replace(/Page (\d+)/g, (match, p1) => {
      const page = parseInt(p1, 10);
      if (!isNaN(page)) {
        return `Page ${page} — <a href="/mlb/MLB_CBA_2022.pdf#page=${page}" target="_blank" rel="noopener noreferrer">Open page</a>`;
      }
      return match;
    });

    // Add PDF links to legal quotes
    text = text.replace(/QUOTE: "(.*?)"/g, (match, quote) => {
      const page = resolvePageNumber(quote);
      if (page) {
        return `QUOTE: "${quote}" (See <a href="/mlb/MLB_CBA_2022.pdf#page=${page}" target="_blank" rel="noopener noreferrer">Page ${page}</a>)`;
      }
      return match;
    });

    return res.status(200).json({ output: text });
  } catch (err) {
    console.error("Chat API error:", err);
    return res.status(200).json({
      output:
        "Sorry—something went wrong with the assistant. Please try again.",
    });
  }
}
