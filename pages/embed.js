import { useState, useRef, useEffect } from "react";
import Head from "next/head";
import ReactMarkdown from "react-markdown";
// If you installed these, keep them; otherwise remove these two lines.
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

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
          :root { --page-bg: #ffe066; --ink: #222; --brand: #ffe066; --primary:#2563eb; }
          /* Support modern mobile viewports */
          .vh { height: 100vh; }
          @supports (height: 100dvh) { .vh { height: 100dvh; } }
          @supports (height: 100svh) { .vh { height: 100svh; } }

          /* Mobile: make card square-edged (no outer rounding), full-bleed */
          @media (max-width: 600px) {
            .mlb-cba-chat-card {
              width: 100vw !important;
              max-width: 100vw !important;
              border-radius: 0 !important;
              border-left: none !important;
              border-right: none !important;
              box-shadow: none !important;
            }
          }
          a { color: var(--primary); }
        `}</style>
      </Head>

      <div
        style={{
          background: "var(--page-bg)",
          fontFamily: "'Instrument Sans', sans-serif",
          minHeight: "100vh",
          width: "100vw",
          boxSizing: "border-box",
        }}
      >
        <div
          className="mlb-cba-chat-card vh"
          style={{
            background: "#fff",
            width: "100vw",
            maxWidth: 480,
            margin: "0 auto",
            borderRadius: 16,            // card owns the rounding
            overflow: "hidden",          // clip children so no white arcs show
            boxShadow: "0 0 10px rgba(0,0,0,0.1)",
            display: "flex",
            flexDirection: "column",
            border: "3px solid var(--ink)",
            minHeight: 400,
            boxSizing: "border-box",
          }}
        >
          {/* HEADER (no radius here) */}
          <div
            style={{
              background: "var(--ink)",
              color: "var(--brand)",
              padding: "10px 0 6px 0",
              textAlign: "center",
              fontWeight: 700,
              fontSize: "clamp(1.05rem, 2vw, 1.1rem)",
              letterSpacing: "0.3px",
              borderBottom: "2px solid var(--ink)",
              flexShrink: 0,
            }}
          >
            MLB CBA Assistant
            <div
              style={{
                fontWeight: 400,
                fontSize: "clamp(0.9rem, 1.8vw, 0.98rem)",
                color: "#fff7cc",
                marginTop: 1,
              }}
            >
              by Mitch Leblanc
            </div>
          </div>

          {/* NOTICE + BACK */}
          <div
            style={{
              background: "#fff8dc",
              borderBottom: "1.5px solid #f1c40f",
              padding: "min(10px, 2vw) min(6vw, 20px)",
              fontSize: "clamp(0.97rem, 2vw, 1rem)",
              color: "#333",
              textAlign: "center",
              flexShrink: 0,
            }}
          >
            <b>Ask anything about the 2022 MLB CBA.</b>
            <div style={{ marginTop: 10 }}>
              <a
                href="https://mitchleblanc.xyz"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  background: "var(--ink)",
                  color: "var(--brand)",
                  border: "none",
                  borderRadius: 8,
                  padding: "8px 18px",
                  textDecoration: "none",
                  fontWeight: 600,
                  fontSize: "clamp(0.95rem, 2vw, 1rem)",
                  marginTop: 8,
                  display: "inline-block",
                  width: "100%",
                  maxWidth: 250,
                }}
              >
                ← Back to Website
              </a>
            </div>
          </div>

          {/* CHAT WINDOW */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            style={{
              flex: 1,
              minHeight: 0,
              padding: "min(16px, 3vw)",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              background: "#fff",
            }}
          >
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                  background: msg.role === "user" ? "var(--primary)" : "#e5e7eb",
                  color: msg.role === "user" ? "white" : "#111827",
                  padding: "12px 14px",
                  borderRadius: 18,
                  maxWidth: "90vw",
                  fontSize: 14,
                  lineHeight: 1.4,
                  wordBreak: "break-word",
                }}
              >
                <ReactMarkdown
                  // If you removed the imports, also remove these two props:
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                >
                  {msg.content}
                </ReactMarkdown>
              </div>
            ))}
            {isTyping && (
              <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
                Assistant is reviewing the CBA… One moment.
              </div>
            )}
            {error && (
              <div style={{ fontSize: 12, color: "#b91c1c" }}>{error}</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* INPUT */}
          <form
            onSubmit={handleSubmit}
            style={{
              display: "flex",
              padding: "min(12px, 2.2vw)",
              borderTop: "1px solid #e5e7eb",
              background: "#fafafa",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <textarea
              rows={1}
              onKeyDown={handleKeyDown}
              style={{
                flex: 1,
                padding: "10px 14px",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                fontSize: 14,
                resize: "none",
                width: 0,
                minWidth: 0,
              }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask me about the MLB CBA…"
            />
            <button
              type="submit"
              disabled={isTyping || !input.trim()}
              style={{
                background: isTyping ? "#9ca3af" : "var(--primary)",
                color: "white",
                border: "none",
                padding: "10px 16px",
                borderRadius: 8,
                cursor: isTyping ? "not-allowed" : "pointer",
                fontSize: "1rem",
                opacity: isTyping ? 0.8 : 1,
              }}
              aria-disabled={isTyping}
            >
              Send
            </button>
          </form>

          {/* FOOTER (no radius here; card clips it) */}
          <div
            style={{
              background: "#fff",
              color: "#555",
              fontSize: "clamp(0.86rem, 1.5vw, 0.93rem)",
              textAlign: "center",
              padding: "7px 0 9px 0",
              borderTop: "1px solid #f3e0a8",
              wordBreak: "break-word",
              flexShrink: 0,
            }}
          >
            &copy; {new Date().getFullYear()} Mitch Leblanc.<br />
            <span style={{ color: "#aaa" }}>
              For informational purposes only. Always consult the official <b>MLB</b> CBA for legal certainty.
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
