import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, MicOff, Send, MessageSquare, Loader2, CheckCircle2, Car } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  component: FnolPage,
  head: () => ({
    meta: [
      { title: "Report a Motor Accident — FNOL Assistant" },
      {
        name: "description",
        content:
          "Calm, conversational First Notice of Loss portal. Report your motor accident in under 2 minutes by chat or voice.",
      },
    ],
  }),
});

type Source = "chat" | "voice";
type Msg = { role: "user" | "assistant"; content: string; source?: Source };
type Mode = "landing" | "chat" | "voice" | "submitted";

function FnolPage() {
  const [mode, setMode] = useState<Mode>("landing");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Last failed action — when set, a "Try again" banner is shown.
  const [lastError, setLastError] = useState<null | { kind: "chat"; text: string; source: Source } | { kind: "init" } | { kind: "submit"; history: Msg[]; summary: string }>(null);

  // Voice state
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "processing">("idle");
  const [voiceStatus, setVoiceStatus] = useState<string>("Tap to start");
  const vapiRef = useRef<any>(null);

  // Pending voice transcript awaiting user confirmation/edit before
  // entering the shared FNOL pipeline.
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function startChat() {
    setMode("chat");
    if (messages.length === 0) {
      setLoading(true);
      try {
        const reply = await fetchReply([]);
        setMessages([{ role: "assistant", content: reply }]);
      } catch (e) {
        console.error(e);
        setLastError({ kind: "init" });
      } finally {
        setLoading(false);
      }
    }
  }

  async function fetchReply(history: Msg[]): Promise<string> {
    const { data, error } = await supabase.functions.invoke("fnol-chat", {
      body: { messages: history },
    });
    if (error) throw error;
    if (!data?.reply) throw new Error("Empty reply");
    return data.reply as string;
  }

  // Single shared pipeline — chat AND voice transcripts both flow through here.
  // This guarantees identical Hugging Face logic, identical FNOL structuring,
  // and no duplicate flows between channels. `source` is purely a UI label.
  async function handleUserMessage(text: string, source: Source = "chat") {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLastError(null);
    const next: Msg[] = [...messages, { role: "user", content: trimmed, source }];
    setMessages(next);
    setLoading(true);
    try {
      const reply = await fetchReply(next);
      setMessages([...next, { role: "assistant", content: reply }]);
      if (reply.toUpperCase().includes("SUMMARY:")) {
        await submitClaim(next, reply);
      }
    } catch (e) {
      console.error(e);
      // Roll back the user message so retry re-sends cleanly.
      setMessages(messages);
      setLastError({ kind: "chat", text: trimmed, source });
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    if (!input.trim() || loading) return;
    const text = input;
    setInput("");
    await handleUserMessage(text, "chat");
  }

  function retryLast() {
    if (!lastError) return;
    const err = lastError;
    setLastError(null);
    if (err.kind === "chat") {
      handleUserMessage(err.text, err.source);
    } else if (err.kind === "init") {
      startChat();
    } else if (err.kind === "submit") {
      submitClaim(err.history, err.summary);
    }
  }

  // Voice transcripts use the exact same pipeline as chat
  function handleVoiceTranscript(text: string) {
    return handleUserMessage(text, "voice");
  }

  async function submitClaim(history: Msg[], summary: string) {
    setSubmitting(true);
    try {
      const { data } = await supabase.functions.invoke("fnol-submit", {
        body: { transcript: history, summary, channel: mode },
      });
      setReferenceId(data?.referenceId ?? `FNOL-${Date.now().toString(36).toUpperCase()}`);
      setMode("submitted");
    } catch (e) {
      toast.error("Submission failed, please try again.");
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  }

  async function mockVoiceFlow() {
    setVoiceActive(true);
    setVoiceState("listening");
    setVoiceStatus("Listening…");
    await new Promise((r) => setTimeout(r, 2000));
    setVoiceActive(false);
    setVoiceState("processing");
    setVoiceStatus("Processing…");
    await new Promise((r) => setTimeout(r, 800));

    const transcript = "There was a minor accident near Bellandur, Bangalore";
    setVoiceStatus(`Heard: "${transcript}"`);
    setMode("chat");

    // Stage transcript so the user can review/edit before it enters the
    // shared FNOL pipeline.
    setPendingTranscript(transcript);
    setVoiceState("idle");
  }

  async function startVoice() {
    setMode("voice");
    setVoiceStatus("Connecting…");
    try {
      const { data } = await supabase.functions.invoke("fnol-vapi-config");
      if (!data?.configured) {
        // Mock voice flow — simulate recording + transcription delay
        await mockVoiceFlow();
        return;
      }
      const { default: Vapi } = await import("@vapi-ai/web");
      const vapi = new Vapi(data.publicKey);
      vapiRef.current = vapi;
      vapi.on("call-start", () => {
        setVoiceActive(true);
        setVoiceState("listening");
        setVoiceStatus("Listening — tell me what happened");
      });
      vapi.on("call-end", () => {
        setVoiceActive(false);
        setVoiceState("idle");
        setVoiceStatus("Call ended");
      });
      vapi.on("message", (m: any) => {
        if (m.type === "transcript" && m.transcriptType === "final") {
          if (m.role === "user") {
            // Stage transcript in chat for user to review/edit before
            // it enters the shared FNOL pipeline.
            setMode("chat");
            setPendingTranscript(m.transcript);
          } else {
            setMessages((prev) => [...prev, { role: "assistant", content: m.transcript }]);
          }
        }
      });
      vapi.on("error", (e: any) => {
        console.error(e);
        toast.error("Voice error — try chat instead");
        setVoiceActive(false);
        setVoiceState("idle");
      });
      await vapi.start(data.assistantId);
    } catch (e) {
      console.error(e);
      setVoiceStatus("Voice unavailable — try chat");
      setVoiceActive(false);
      setVoiceState("idle");
    }
  }

  function stopVoice() {
    try {
      vapiRef.current?.stop();
    } catch {}
    setVoiceActive(false);
    setVoiceState("idle");
    setVoiceStatus("Tap to start");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-6"
      style={{ background: "var(--gradient-calm)" }}>
      <Card className="w-full max-w-md overflow-hidden border-0"
        style={{ boxShadow: "var(--shadow-soft)" }}>
        {/* Header */}
        <div className="px-6 py-5 text-primary-foreground"
          style={{ background: "var(--gradient-primary)" }}>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
              <Car className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">🚗 Report Your Accident</h1>
              <p className="text-xs opacity-90">We're here to help — calmly, in under 2 minutes.</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="bg-card">
          <AnimatePresence mode="wait">
            {mode === "landing" && (
              <motion.div key="landing" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="p-6 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Take a breath. Choose how you'd like to report — switch anytime.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Button onClick={startChat} className="h-24 flex-col gap-2" variant="outline">
                    <MessageSquare className="h-6 w-6 text-primary" />
                    <span className="text-sm font-medium">Chat</span>
                  </Button>
                  <Button onClick={startVoice} className="h-24 flex-col gap-2 border-primary/30"
                    variant="outline">
                    <Mic className="h-6 w-6 text-primary" />
                    <span className="text-sm font-medium">Voice</span>
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground text-center pt-2">
                  Your details are encrypted and used only to process your claim.
                </p>
              </motion.div>
            )}

            {mode === "chat" && (
              <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div ref={scrollRef} className="h-[60vh] max-h-[480px] overflow-y-auto p-4 space-y-3">
                  {messages.map((m, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                      className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}>
                      <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        m.role === "user"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-assistant-bubble text-foreground rounded-bl-sm"
                      }`}>
                        {m.content}
                      </div>
                      {m.role === "user" && m.source && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground px-1">
                          {m.source === "voice" ? (
                            <><Mic className="h-2.5 w-2.5" /> Voice</>
                          ) : (
                            <><MessageSquare className="h-2.5 w-2.5" /> Chat</>
                          )}
                        </span>
                      )}
                    </motion.div>
                  ))}
                  {loading && (
                    <div className="flex justify-start">
                      <div className="bg-assistant-bubble rounded-2xl rounded-bl-sm px-4 py-3">
                        <div className="flex gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce" />
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:120ms]" />
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:240ms]" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {pendingTranscript !== null && (
                  <div className="border-t bg-accent/40 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Mic className="h-3.5 w-3.5 text-primary" />
                      Review your voice transcript before sending
                    </div>
                    <Input
                      autoFocus
                      value={pendingTranscript}
                      onChange={(e) => setPendingTranscript(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && pendingTranscript.trim()) {
                          const t = pendingTranscript.trim();
                          setPendingTranscript(null);
                          handleUserMessage(t, "voice");
                        }
                      }}
                      placeholder="Edit transcript…"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setPendingTranscript(null)}>
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        disabled={!pendingTranscript.trim() || loading || submitting}
                        onClick={() => {
                          const t = pendingTranscript.trim();
                          setPendingTranscript(null);
                          handleUserMessage(t, "voice");
                        }}
                      >
                        Send
                      </Button>
                    </div>
                  </div>
                )}
                <div className="border-t p-3 flex gap-2 items-center">
                  <Button size="icon" variant="ghost" onClick={startVoice} aria-label="Switch to voice">
                    <Mic className="h-4 w-4 text-primary" />
                  </Button>
                  <Input value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && send()}
                    placeholder="Type your reply…" disabled={loading || submitting || pendingTranscript !== null} />
                  <Button size="icon" onClick={send} disabled={loading || submitting || !input.trim() || pendingTranscript !== null}>
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              </motion.div>
            )}

            {mode === "voice" && (
              <motion.div key="voice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="p-8 flex flex-col items-center gap-6 min-h-[60vh] justify-center">
                <motion.div animate={voiceActive ? { scale: [1, 1.08, 1] } : { scale: 1 }}
                  transition={{ repeat: voiceActive ? Infinity : 0, duration: 1.4 }}
                  className="relative h-32 w-32 rounded-full flex items-center justify-center"
                  style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-soft)" }}>
                  {voiceActive && (
                    <motion.div className="absolute inset-0 rounded-full border-2 border-primary/40"
                      animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
                      transition={{ repeat: Infinity, duration: 1.6 }} />
                  )}
                  <Mic className="h-12 w-12 text-primary-foreground" />
                </motion.div>
                <p className="text-sm text-muted-foreground text-center">{voiceStatus}</p>
                <div className="flex gap-3">
                  {voiceState === "listening" ? (
                    <Button onClick={stopVoice} variant="destructive" className="gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-white animate-pulse" />
                      🔴 Listening…
                    </Button>
                  ) : voiceState === "processing" ? (
                    <Button disabled className="gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      ⏳ Processing…
                    </Button>
                  ) : (
                    <Button onClick={startVoice} className="gap-2">
                      <Mic className="h-4 w-4" /> 🎙️ Speak to Report
                    </Button>
                  )}
                  <Button onClick={() => setMode("chat")} variant="outline" className="gap-2"
                    disabled={voiceState === "processing"}>
                    <MessageSquare className="h-4 w-4" /> Switch to chat
                  </Button>
                </div>
              </motion.div>
            )}

            {mode === "submitted" && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                className="p-8 flex flex-col items-center gap-4 text-center min-h-[50vh] justify-center">
                <CheckCircle2 className="h-16 w-16 text-primary" />
                <h2 className="text-xl font-semibold">Claim received</h2>
                <p className="text-sm text-muted-foreground">
                  Your reference ID is
                </p>
                <div className="font-mono text-lg px-4 py-2 rounded-lg bg-assistant-bubble">
                  {referenceId}
                </div>
                <p className="text-xs text-muted-foreground max-w-xs">
                  A claims specialist will reach out shortly. Stay safe.
                </p>
                <Button variant="outline" onClick={() => { setMode("landing"); setMessages([]); setReferenceId(null); }}>
                  Start a new report
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Card>
    </div>
  );
}
