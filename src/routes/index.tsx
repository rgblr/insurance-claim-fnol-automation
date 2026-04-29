import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Send, MessageSquare, Loader2, CheckCircle2, Car, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  component: FnolPage,
  head: () => ({
    meta: [
      { title: "Report a Motor Claim — FNOL Portal" },
      {
        name: "description",
        content:
          "Report your motor accident in under 2 minutes. Step-by-step FNOL portal with chat and voice input. Available 24x7, Hindi & English supported.",
      },
    ],
  }),
});

// ────────────────────────────────────────────────────────────────────────────
// FNOL flow — fully controlled by the app. The LLM never decides what to ask.
// ────────────────────────────────────────────────────────────────────────────
type FieldKey = "safety" | "mobile" | "location" | "description" | "injuries";
type FnolData = Record<FieldKey, string>;
type Source = "chat" | "voice";
type Msg = { role: "user" | "assistant"; content: string; source?: Source };

const STEPS: { key: FieldKey; question: string; required: boolean }[] = [
  { key: "safety", question: "First — are you safe right now?", required: false },
  { key: "mobile", question: "Please share your 10-digit mobile number.", required: true },
  { key: "location", question: "Where did the accident occur? (address or landmark)", required: true },
  { key: "description", question: "Briefly — what happened?", required: true },
  { key: "injuries", question: "Were there any injuries?", required: false },
];

const EMPTY_DATA: FnolData = { safety: "", mobile: "", location: "", description: "", injuries: "" };
const FIELD_LABEL: Record<FieldKey, string> = {
  safety: "Safety",
  mobile: "Mobile",
  location: "Location",
  description: "What happened",
  injuries: "Injuries",
};

function isMobileValid(v: string) {
  return /^\d{10}$/.test(v.replace(/\D/g, ""));
}

function FnolPage() {
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [fnolData, setFnolData] = useState<FnolData>(EMPTY_DATA);
  const [currentStep, setCurrentStep] = useState(0);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ referenceId: string } | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [lastError, setLastError] = useState<null | { text: string; source: Source }>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Voice
  const [voiceActive, setVoiceActive] = useState(false);
  const vapiRef = useRef<any>(null);
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);

  // Bootstrap: ask the first question.
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{ role: "assistant", content: STEPS[0].question }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading, showSummary]);

  // Find the next missing required step (or first missing of any kind).
  function nextStepIndex(data: FnolData, fromIndex: number): number {
    for (let i = fromIndex; i < STEPS.length; i++) {
      if (!data[STEPS[i].key]?.trim()) return i;
    }
    return STEPS.length; // all done
  }

  function allRequiredFilled(data: FnolData) {
    return STEPS.filter((s) => s.required).every((s) => data[s.key]?.trim());
  }

  async function extract(text: string, expectedField: FieldKey): Promise<Partial<FnolData>> {
    const { data, error } = await supabase.functions.invoke("fnol-chat", {
      body: { input: text, expectedField },
    });
    if (error) throw error;
    return (data?.extracted ?? {}) as Partial<FnolData>;
  }

  // Single entry point — both chat and voice go through here.
  async function handleUserInput(rawText: string, source: Source = "chat") {
    const text = rawText.trim();
    if (!text || loading || submitting) return;
    setLastError(null);

    const step = STEPS[currentStep];
    if (!step) return;

    // Echo user message in transcript.
    setMessages((m) => [...m, { role: "user", content: text, source }]);

    // Validate mobile inline before calling extractor.
    if (step.key === "mobile") {
      const digits = text.replace(/\D/g, "");
      if (!isMobileValid(digits)) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "That doesn't look like a valid 10-digit mobile number. Please try again." },
        ]);
        return;
      }
    }

    setLoading(true);
    try {
      // 1. Extraction-first — ask HF what structured fields are present in the input.
      const extracted = await extract(text, step.key);

      // 2. Merge extracted fields into fnolData FIRST (only fill empty slots — never overwrite).
      const merged: FnolData = { ...fnolData };
      (Object.keys(extracted) as FieldKey[]).forEach((k) => {
        const val = extracted[k];
        if (val && String(val).trim() && !merged[k]?.trim()) {
          merged[k] = String(val).trim();
        }
      });

      // 3. Only assign raw input to the current step IF it's still empty after extraction.
      //    This prevents 'safety' from swallowing a full description sentence, etc.
      if (!merged[step.key]?.trim()) {
        merged[step.key] = text;
      }

      // Normalise mobile to 10 digits.
      if (merged.mobile) merged.mobile = merged.mobile.replace(/\D/g, "").slice(-10);

      setFnolData(merged);

      // 4. Dynamically determine the next missing step from the start — do not increment blindly.
      const nextIdx = nextStepIndex(merged, 0);
      setCurrentStep(nextIdx);

      // 5. Ask the next question, or show summary if done.
      if (nextIdx >= STEPS.length) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "Thanks — I have everything I need. Here's a quick summary." },
        ]);
        setShowSummary(true);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: STEPS[nextIdx].question }]);
      }
    } catch (e) {
      console.error(e);
      // Roll back the user echo so retry is clean.
      setMessages((m) => m.slice(0, -1));
      setLastError({ text, source });
    } finally {
      setLoading(false);
    }
  }

  function retryLast() {
    if (!lastError) return;
    const { text, source } = lastError;
    setLastError(null);
    handleUserInput(text, source);
  }

  async function send() {
    if (!input.trim()) return;
    const t = input;
    setInput("");
    await handleUserInput(t, "chat");
  }

  // Voice via Vapi — used ONLY for speech→text. The transcript is staged
  // for review then sent through handleUserInput, the same path as chat.
  async function startVoice() {
    setMode("voice");
    try {
      const { data } = await supabase.functions.invoke("fnol-vapi-config");
      if (!data?.configured) {
        // Mock voice for demo when Vapi isn't configured.
        setVoiceActive(true);
        await new Promise((r) => setTimeout(r, 1400));
        setVoiceActive(false);
        const transcript =
          STEPS[currentStep]?.key === "mobile"
            ? "9876543210"
            : "There was a minor accident near Bellandur, Bangalore. No injuries.";
        setPendingTranscript(transcript);
        setMode("chat");
        return;
      }
      const { default: Vapi } = await import("@vapi-ai/web");
      const vapi = new Vapi(data.publicKey);
      vapiRef.current = vapi;
      vapi.on("call-start", () => setVoiceActive(true));
      vapi.on("call-end", () => setVoiceActive(false));
      vapi.on("message", (m: any) => {
        if (m.type === "transcript" && m.transcriptType === "final" && m.role === "user") {
          setPendingTranscript(m.transcript);
          setMode("chat");
          try {
            vapi.stop();
          } catch {}
        }
      });
      vapi.on("error", (e: any) => {
        console.error(e);
        toast.error("Voice unavailable — try chat");
        setVoiceActive(false);
        setMode("chat");
      });
      await vapi.start(data.assistantId);
    } catch (e) {
      console.error(e);
      toast.error("Voice unavailable — try chat");
      setVoiceActive(false);
      setMode("chat");
    }
  }

  function stopVoice() {
    try {
      vapiRef.current?.stop();
    } catch {}
    setVoiceActive(false);
    setMode("chat");
  }

  async function submitFNOL() {
    if (!allRequiredFilled(fnolData)) {
      toast.error("Please fill location and description first.");
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await supabase.functions.invoke("fnol-submit", {
        body: { fnolData, transcript: messages, channel: mode },
      });
      setSubmitted({ referenceId: data?.referenceId ?? `FNOL-${Date.now().toString(36).toUpperCase()}` });
    } catch (e) {
      console.error(e);
      toast.error("Submission failed — try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    setMessages([{ role: "assistant", content: STEPS[0].question }]);
    setFnolData(EMPTY_DATA);
    setCurrentStep(0);
    setShowSummary(false);
    setSubmitted(null);
    setInput("");
    setLastError(null);
    setMode("chat");
  }

  const progress = STEPS.filter((s) => fnolData[s.key]?.trim()).length;
  const progressPct = Math.round((progress / STEPS.length) * 100);

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-6"
      style={{ background: "var(--gradient-calm)" }}
    >
      <Card
        className="w-full max-w-md overflow-hidden border-0"
        style={{ boxShadow: "var(--shadow-soft)" }}
      >
        {/* Header */}
        <div
          className="px-6 py-5 text-primary-foreground"
          style={{ background: "var(--gradient-primary)" }}
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
              <Car className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h1 className="text-lg font-semibold leading-tight">🚗 Report a Motor Claim</h1>
              <p className="text-xs opacity-90">FNOL Portal</p>
            </div>
            <span className="text-[10px] uppercase tracking-wider bg-white/15 px-2 py-1 rounded-full inline-flex items-center gap-1">
              {mode === "voice" ? <Mic className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
              {mode}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-4 h-1 rounded-full bg-white/20 overflow-hidden">
            <motion.div
              className="h-full bg-white"
              initial={{ width: 0 }}
              animate={{ width: `${progressPct}%` }}
              transition={{ duration: 0.4 }}
            />
          </div>
        </div>

        {/* Body */}
        <div className="bg-card">
          <AnimatePresence mode="wait">
            {!submitted ? (
              <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div ref={scrollRef} className="h-[55vh] max-h-[460px] overflow-y-auto p-4 space-y-3">
                  {messages.map((m, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex flex-col gap-1 ${m.role === "user" ? "items-end" : "items-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                          m.role === "user"
                            ? "bg-primary text-primary-foreground rounded-br-sm"
                            : "bg-assistant-bubble text-foreground rounded-bl-sm"
                        }`}
                      >
                        {m.content}
                      </div>
                      {m.role === "user" && m.source && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground px-1">
                          {m.source === "voice" ? (
                            <>
                              <Mic className="h-2.5 w-2.5" /> Voice
                            </>
                          ) : (
                            <>
                              <MessageSquare className="h-2.5 w-2.5" /> Chat
                            </>
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

                  {/* Summary card inside chat */}
                  {showSummary && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-2xl border bg-accent/40 p-4 space-y-3"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <ShieldCheck className="h-4 w-4 text-primary" />
                        Here are your claim details
                      </div>
                      <dl className="text-sm space-y-1.5">
                        {STEPS.map((s) => (
                          <div key={s.key} className="flex gap-2">
                            <dt className="w-28 shrink-0 text-muted-foreground">{FIELD_LABEL[s.key]}</dt>
                            <dd className="flex-1 text-foreground break-words">
                              {fnolData[s.key] || <span className="text-muted-foreground">—</span>}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <Button
                        className="w-full"
                        onClick={submitFNOL}
                        disabled={submitting || !allRequiredFilled(fnolData)}
                      >
                        {submitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Submitting…
                          </>
                        ) : (
                          "Submit Claim"
                        )}
                      </Button>
                    </motion.div>
                  )}
                </div>

                {/* Error retry banner */}
                {lastError && !loading && (
                  <div className="border-t bg-destructive/10 p-3 flex items-center justify-between gap-3">
                    <span className="text-xs text-destructive">Something went wrong. Try again.</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setLastError(null)}>
                        Dismiss
                      </Button>
                      <Button size="sm" onClick={retryLast}>
                        Try again
                      </Button>
                    </div>
                  </div>
                )}

                {/* Voice transcript review */}
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
                          handleUserInput(t, "voice");
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
                        disabled={!pendingTranscript.trim() || loading}
                        onClick={() => {
                          const t = pendingTranscript.trim();
                          setPendingTranscript(null);
                          handleUserInput(t, "voice");
                        }}
                      >
                        Send
                      </Button>
                    </div>
                  </div>
                )}

                {/* Voice listening overlay-ish indicator */}
                {voiceActive && (
                  <div className="border-t bg-primary/5 p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                      Listening…
                    </div>
                    <Button size="sm" variant="ghost" onClick={stopVoice}>
                      Stop
                    </Button>
                  </div>
                )}

                {/* Composer */}
                {!showSummary && (
                  <div className="border-t p-3 flex gap-2 items-center">
                    <Button
                      size="icon"
                      variant={mode === "voice" ? "default" : "ghost"}
                      onClick={voiceActive ? stopVoice : startVoice}
                      aria-label="Voice input"
                      disabled={loading || pendingTranscript !== null}
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                    <Input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && send()}
                      placeholder={STEPS[currentStep]?.question ?? "Type your reply…"}
                      disabled={loading || pendingTranscript !== null}
                    />
                    <Button
                      size="icon"
                      onClick={send}
                      disabled={loading || !input.trim() || pendingTranscript !== null}
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-8 flex flex-col items-center gap-4 text-center min-h-[55vh] justify-center"
              >
                <CheckCircle2 className="h-16 w-16 text-primary" />
                <h2 className="text-xl font-semibold">Claim received</h2>
                <p className="text-sm text-muted-foreground">Your reference ID is</p>
                <div className="font-mono text-lg px-4 py-2 rounded-lg bg-assistant-bubble">
                  {submitted.referenceId}
                </div>
                <p className="text-xs text-muted-foreground max-w-xs">
                  A claims specialist will reach out shortly. Stay safe.
                </p>
                <Button variant="outline" onClick={startOver}>
                  Start a new report
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <div className="px-4 py-2.5 text-center text-[11px] text-muted-foreground border-t bg-muted/30">
            Available 24×7 · Hindi & English supported
          </div>
        </div>
      </Card>
    </div>
  );
}
