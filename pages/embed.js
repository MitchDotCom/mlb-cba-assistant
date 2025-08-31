import { useState, useRef, useEffect } from "react";
import Head from "next/head";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function EmbedChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const submit = async (text) => {
    const userMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // send full convo (keeps your existing behavior)
        body: JSON.stringify({ messages: [...messages, userMessage] }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const assistantMessage = {
        role: "assistant",
        content: data.result || "No response from assistant.",
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (e) {
      setError("Sorry—something went wrong. Please try again.");
    } finally {
      setIsTyping(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;
    submit(input.trim());
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!input.trim() || isTyping) return;
      submit(input.trim());
    }
  };

  return (
    <>
      <Head>
        <title>MLB CBA Assistant</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          html, body, #__next { height: 100%; margin: 0; padding: 0; }
          .vh { height: 100vh; }
          @supports (height: 100dvh) { .vh { height: 100dvh; } }
          @media (max-width: 640px) {
            .card { max-width: 100vw !important; border-left: none !important; border-right: none !important; box-shadow: none !important; }
          }
          a { color: #2563eb; }
        `}</style>
      </Head>

      {/* FULL-BLEED BACKGROUND */}
      <div
        className="vh"
        style={{
          background: "#ffe066",
          fontFamily: "'Instrument Sans', sans-serif",
          width: "100vw",
          boxSizing: "border-box",
          display: "flex",
          justifyContent: "center",
        }}
      >
        {/* CARD */}
        <div
          className="card vh"
          style={{
            background: "#fff",
            width: "100vw",
            maxWidth: 520,
            margin: "0 auto",
            borderRadius: 0,
            border: "1px solid #e5e7eb",
            boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* HEADER */}
          <div style={{ padding: "16px 18px", borderBottom: "1px solid #eee" }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>MLB CBA Assistant</div>
            <div style={{ color: "#6b7280", fontSize: 12 }}>
              Answers with page-linked citations and source excerpts.
            </div>
          </div>

          {/* MESSAGES */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px 18px",
              background: "#fafafa",
            }}
          >
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  marginBottom: 12,
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "100%",
                    background: m.role === "user" ? "#2563eb" : "#fff",
                    color: m.role === "user" ? "#fff" : "#111827",
                    border: m.role === "user" ? "none" : "1px solid #e5e7eb",
                    borderRadius: 12,
                    padding: "10px 12px",
                    fontSize: 14,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {m.role === "assistant" ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node, ...props }) => (
                          <a {...props} target="_blank" rel="noopener noreferrer" />
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
            {isTyping && (
              <div style={{ color: "#6b7280", fontSize: 13 }}>Assistant is typing…</div>
            )}
            {error && (
              <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{error}</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* INPUT */}
          <form onSubmit={handleSubmit} style={{ padding: 12, borderTop: "1px solid #eee" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a CBA question… (Enter to send, Shift+Enter for newline)"
              style={{
                width: "100%",
                height: 72,
                resize: "none",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                padding: 10,
                outline: "none",
                fontFamily: "inherit",
                fontSize: 14,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button
                type="submit"
                disabled={isTyping || !input.trim()}
                style={{
                  background: isTyping || !input.trim() ? "#d1d5db" : "#2563eb",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 14,
                  cursor: isTyping || !input.trim() ? "not-allowed" : "pointer",
                }}
              >
                Send
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
