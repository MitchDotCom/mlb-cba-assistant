// pages/api/chat.js
// Minimal Assistants v2 passthrough — no linkify, reuses thread, tighter polling.

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ result: "Method not allowed" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const assistant_id = process.env.OPENAI_ASSISTANT_ID;
    if (!OPENAI_API_KEY || !assistant_id) {
      return res.status(500).json({ result: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID." });
    }

    const { message, threadId: existingThreadId } = req.body ?? {};
    const text = (message ?? "").toString().trim();
    if (!text) return res.status(200).json({ result: "No question provided." });

    const j = async (url, opts) => {
      const r = await fetch(url, {
        ...opts,
        headers: {
          ...(opts?.headers || {}),
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status} ${r.statusText} — ${body.slice(0, 400)}`);
      }
      return r.json();
    };

    // Reuse thread if provided; otherwise create once.
    let threadId = existingThreadId;
    if (!threadId) {
      const thread = await j("https://api.openai.com/v1/threads", { method: "POST", body: "{}" });
      threadId = thread.id;
    }

    // Add only the new user message (no re-sending the entire history).
    await j(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: text }),
    });

    // Run the assistant.
    const run = await j(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id }),
    });

    // Poll faster (every 250ms, up to ~30s).
    let status = null;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await j(
        `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`,
        { method: "GET" }
      );
      status = s.status;
      if (status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(status)) {
        throw new Error(`Run ${status}`);
      }
    }
    if (status !== "completed") throw new Error("Run timed out");

    // Read the latest assistant message.
    const msgs = await j(
      `https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=10`,
      { method: "GET" }
    );
    const firstAssistant = (msgs?.data || []).find((m) => m.role === "assistant");
    const textOut =
      (firstAssistant?.content || [])
        .map((c) => (typeof c?.text?.value === "string" ? c.text.value : ""))
        .join("\n")
        .trim() || "No response from assistant.";

    // Return raw Assistant output — no linkification.
    return res.status(200).json({ result: textOut, threadId });
  } catch (err) {
    console.error("/api/chat error:", err);
    return res.status(200).json({ result: "Sorry—something went wrong. Please try again." });
  }
}
