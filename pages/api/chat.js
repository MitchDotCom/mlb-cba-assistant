// pages/api/chat.js
import { linkifyCitationsAndFixPages } from "@/lib/linkifyCitations";

// If you already have your OpenAI call code, keep it.
// Replace ONLY the final text handling to run through linkifyCitationsAndFixPages.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { messages } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "Missing messages array" });
      return;
    }

    // === Your existing Assistants call goes here ===
    // Example placeholder: you already had this working; keep your code.
    // const resultFromAssistant = await runAssistant(messages);
    // const rawText = resultFromAssistant; // string

    // ---- BEGIN: replace this block with your existing assistant call ----
    // PLACEHOLDER to prevent deploy errors. You MUST replace with your current logic.
    const rawText = "Placeholder. This will be replaced by your Assistant output.";
    // ---- END: replace this block with your existing assistant call ----

    const fixed = linkifyCitationsAndFixPages(rawText);

    res.status(200).json({ result: fixed });
  } catch (err) {
    console.error("API /chat error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
}
