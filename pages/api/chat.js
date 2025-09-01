// pages/api/chat.js
import OpenAI from "openai";
import pageMap from "../../lib/page_map.json";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper: try to resolve page number for a quoted excerpt
function resolvePageNumber(quote) {
  if (!quote) return null;

  // search values of pageMap for exact substring match
  for (const [section, page] of Object.entries(pageMap)) {
    if (quote.includes(section)) {
      return page;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
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

    let text = completion.choices[0].message.content;

    // Try to inject PDF links based on page_map.json
    text = text.replace(/Page (\d+)/g, (match, p1) => {
      const page = parseInt(p1, 10);
      if (!isNaN(page)) {
        return `Page ${page} — <a href="/mlb/MLB_CBA_2022.pdf#page=${page}" target="_blank" rel="noopener noreferrer">Open page</a>`;
      }
      return match;
    });

    // Additionally check LEGAL_EXCERPTS quotes for mapping
    text = text.replace(
      /QUOTE: "(.*?)"/g,
      (match, quote) => {
        const page = resolvePageNumber(quote);
        if (page) {
          return `QUOTE: "${quote}" (See <a href="/mlb/MLB_CBA_2022.pdf#page=${page}" target="_blank" rel="noopener noreferrer">Page ${page}</a>)`;
        }
        return match;
      }
    );

    res.status(200).json({ output: text });
  } catch (err) {
    console.error("Chat API error:", err);
    res.status(500).json({ error: "Something went wrong." });
  }
}
