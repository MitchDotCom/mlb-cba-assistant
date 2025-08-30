import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { q } = req.body;
  if (!q) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    // Fetch page_map.json from your public folder
    const resp = await fetch(
      `${process.env.VERCEL_URL
        ? "https://" + process.env.VERCEL_URL
        : "http://localhost:3000"}/mlb/page_map.json`
    );
    const pageMap = await resp.json();

    // Build the system prompt add-on
    const pageMapNote = `PAGE_MAP: ${JSON.stringify(pageMap)}`;

    // Call the Assistant
    const run = await client.chat.completions.create({
      model: "gpt-4.1",
      temperature: 0.05,
      messages: [
        {
          role: "system",
          content: pageMapNote,
        },
        { role: "user", content: q },
      ],
    });

    const answer = run.choices[0].message.content.trim();
    return res.status(200).json({ text: answer });
  } catch (err) {
    console.error("Error in MLB API:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

