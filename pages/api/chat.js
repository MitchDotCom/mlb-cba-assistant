import { streamText } from "ai";
import OpenAI from "openai";
import pageMap from "./page_map.json";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req) {
  try {
    const { messages } = await req.json();

    // user’s latest query
    const userMessage = messages[messages.length - 1].content;

    // --- EXACT MATCH LOGIC ---
    let matchedSection = null;

    for (const [key, value] of Object.entries(pageMap)) {
      if (userMessage.toLowerCase().includes(key.toLowerCase())) {
        matchedSection = value;
        break; // stop at first exact match
      }
    }

    // If no exact match, send null context
    const context = matchedSection
      ? `Matched CBA Section:\n${matchedSection.title}\nPages ${matchedSection.start}-${matchedSection.end}`
      : "No exact match found in page_map.json";

    // Call OpenAI Assistant with context
    const result = await streamText({
      model: "gpt-4.1", // or the assistant API if you wired it
      messages: [
        ...messages,
        { role: "system", content: `Context from CBA:\n${context}` },
      ],
    });

    return result.toAIStreamResponse();
  } catch (err) {
    console.error("Chat route error:", err);
    return new Response("Something went wrong in chat.js", { status: 500 });
  }
}
