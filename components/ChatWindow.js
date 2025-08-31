// components/ChatWindow.js
import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function ChatWindow() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);

  async function submit(text) {
    const userMessage = { role: "user", content: text };
    setMessages(prev => [...prev, userMessage]);
    setInput(""); setIsTyping(true); setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMessage] })
      });
      const data = await res.json();
      const assistantMessage = { role: "assistant", content: data.result || "No response." };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (e) {
      setError("Sorry—something went wrong.");
    } finally {
      setIsTyping(false);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const t = input.trim();
    if (!t || isTyping) return;
    submit(t);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"#fafafa" }}>
      <div style={{ flex:1, overflowY:"auto", padding:16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display:"flex", justifyContent: m.role==="user" ? "flex-end" : "flex-start", marginBottom:12 }}>
            <div style={{
              maxWidth:"100%",
              background: m.role==="user" ? "#2563eb" : "#fff",
              color: m.role==="user" ? "#fff" : "#111",
              border: m.role==="user" ? "none" : "1px solid #e5e7eb",
              borderRadius:12, padding:"10px 12px", fontSize:14, lineHeight:1.5, whiteSpace:"pre-wrap"
            }}>
              {m.role === "assistant" ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({node, ...props}) => <a {...props} target="_blank" rel="noopener noreferrer" />
                  }}
                >
                  {m.content}
                </ReactMarkdown>
              ) : m.content}
            </div>
          </div>
        ))}
        {isTyping && <div style={{ color:"#6b7280", fontSize:13 }}>Assistant is typing…</div>}
        {error && <div style={{ color:"#b91c1c", fontSize:13 }}>{error}</div>}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} style={{ borderTop:"1px solid #eee", padding:10, background:"#fff" }}>
        <textarea
          value={input} onChange={e=>setInput(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Ask a CBA question… (Enter to send, Shift+Enter for newline)"
          style={{ width:"100%", height:72, resize:"none", border:"1px solid #e5e7eb", borderRadius:10, padding:10, fontSize:14 }}
        />
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:8 }}>
          <button type="submit" disabled={isTyping || !input.trim()}
            style={{ background: isTyping || !input.trim() ? "#d1d5db" : "#2563eb", color:"#fff", border:"none", borderRadius:8, padding:"8px 12px", fontSize:14 }}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
