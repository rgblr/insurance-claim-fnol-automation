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
const INPUT_PLACEHOLDER: Record<FieldKey, string> = {
  safety: "Type Yes or No",
  mobile: "Enter 10-digit mobile number",
  location: "Enter accident location",
  description: "Briefly describe what happened",
  injuries: "Yes or No",
};
const STEP_LABEL: Record<FieldKey, string> = {
  safety: "Safety Check",
  mobile: "Contact Number",
  location: "Accident Location",
  description: "Incident Details",
  injuries: "Injury Check",
};

function isMobileValid(v: string) {
  return /^[6-9]\d{9}$/.test(v.replace(/\D/g, ""));
}

// Detect if user is trying to correct a previously entered field.
// Returns the target field key + the corrected raw text (or null).
function detectCorrection(text: string): { field: FieldKey; value: string } | null {
  const lower = text.toLowerCase();
  const hasIntent = /\b(change|update|correct|actually|not\s+\w+\s+but|instead|rather|sorry,?\s*(it'?s|its|i meant)|i meant)\b/.test(lower);
  if (!hasIntent) return null;
  // Identify target field by keyword
  let field: FieldKey | null = null;
  if (/\b(mobile|phone|number|contact)\b/.test(lower)) field = "mobile";
  else if (/\b(location|address|place|where|landmark)\b/.test(lower)) field = "location";
  else if (/\b(injur|hurt|wound)\b/.test(lower)) field = "injuries";
  else if (/\b(description|happened|incident|accident\s+detail|what\s+happened)\b/.test(lower)) field = "description";
  else if (/\b(safe|safety)\b/.test(lower)) field = "safety";
  if (!field) return null;
  return { field, value: text };
}

// Convert spoken number words to digits.
// "nine eight seven..." → "987..."; "my number is one two three" → "my number is 123"
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};
function wordsToDigits(input: string): string {
  // Normalise punctuation/hyphens/commas between number words so "nine-eight"
  // or "nine, eight" still tokenises as separate words.
  let out = input.replace(/[-_,.]+/g, " ");

  // Repeat: "double X" / "triple X" (also "double-three").
  out = out.replace(
    /\b(double|triple)\s+(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_m, qty: string, word: string) => {
      const digit = NUMBER_WORDS[word.toLowerCase()];
      if (!digit) return _m;
      const count = qty.toLowerCase() === "triple" ? 3 : 2;
      return " " + digit.repeat(count) + " ";
    },
  );

  // Standalone number words → digit.
  out = out.replace(
    /\b(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (m) => NUMBER_WORDS[m.toLowerCase()] ?? m,
  );
  return out;
}

// Pull a 10-digit mobile number out of any free-form text (after normalising
// spoken number words). Returns "" if none is found.
function extractMobile(text: string): string {
  const digits = normalizePhoneNumber(text);
  return digits.length >= 10 ? digits.slice(-10) : "";
}

// Normalise any phone input (typed or spoken) into a pure digits-only string.
// Handles word digits, "double X"/"triple X", spaces, hyphens, brackets, etc.
export function normalizePhoneNumber(input: string): string {
  if (!input) return "";
  const wordMap: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9", oh: "0",
  };
  const digitWords = "zero|one|two|three|four|five|six|seven|eight|nine|oh";
  let result = String(input).toLowerCase();
  result = result.replace(
    new RegExp(`double\\s+(${digitWords})`, "g"),
    (_, d: string) => wordMap[d].repeat(2),
  );
  result = result.replace(
    new RegExp(`triple\\s+(${digitWords})`, "g"),
    (_, d: string) => wordMap[d].repeat(3),
  );
  result = result.replace(/double\s+(\d)/g, (_, d: string) => d.repeat(2));
  result = result.replace(/triple\s+(\d)/g, (_, d: string) => d.repeat(3));
  result = result.replace(
    new RegExp(`\\b(${digitWords})\\b`, "g"),
    (m: string) => wordMap[m],
  );
  result = result.replace(/[\s\-\(\)\.]/g, "");
  result = result.replace(/\D/g, "");
  return result;
}

// Normalise any mobile input (typed or spoken) into a digits-only string,
// preserving a leading "+" for country codes when present.
export function normalizeMobileInput(text: string): string {
  if (!text) return "";
  // Convert spoken "plus" → "+"
  let out = String(text).replace(/\bplus\b/gi, "+");
  // Convert spoken number words / "double X" → digits
  out = wordsToDigits(out);
  // Detect leading + (after optional whitespace) for country code
  const hasPlus = /^\s*\+/.test(out) || /\+\s*\d/.test(out);
  // Strip everything except digits
  const digits = out.replace(/\D/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

// Normalise a safety response → "Yes" | "No" | null (unclear).
export function normalizeSafety(text: string): "Yes" | "No" | null {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  // Negative first (so "not safe" / "i am not safe" doesn't match the "safe" Yes pattern).
  if (/\b(no|nope|nah|not\s+safe|unsafe|injured|hurt|bleeding|i\s*am\s*not\s*safe|i'?m\s*not\s*safe|negative)\b/.test(lower)) {
    return "No";
  }
  if (/\b(yes|yeah|yep|yup|safe|i\s*am\s*safe|i'?m\s*safe|all\s*good|fine|okay|ok|affirmative|y)\b/.test(lower)) {
    return "Yes";
  }
  return null;
}

// Normalise any affirmative/negative input (typed or spoken) → "Yes" | "No".
export const normalizeYesNo = (text: string): "Yes" | "No" => {
  if (!text) return "No";
  const lower = text.toLowerCase().trim();
  const isExactNo = /\bno\b/.test(lower);
  const isExactYes = /\byes\b|\by\b/.test(lower);
  const yesVariants = ['yeah', 'yep', 'yup', 'correct', 'right', 'sure', 'absolutely', 'of course', 'definitely', 'affirmative'];
  const noVariants = ['nope', 'nah', 'negative', 'not really', 'none', 'never'];
  if (isExactYes || yesVariants.some(v => lower.includes(v))) return "Yes";
  if (isExactNo || noVariants.some(v => lower.includes(v))) return "No";
  return "No";
};

function FnolPage() {
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [fnolData, setFnolData] = useState<FnolData>(EMPTY_DATA);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ referenceId: string } | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [lastError, setLastError] = useState<null | { text: string; source: Source }>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Voice — single source of truth: voice writes into the same fnolData/currentStep as chat.
  const [voiceActive, setVoiceActive] = useState(false);
  const vapiRef = useRef<any>(null);
  const vapiPublicKeyRef = useRef<string | null>(null);
  const vapiAssistantIdRef = useRef<string | null>(null);
  const VapiCtorRef = useRef<any>(null);
  const voiceFlowActiveRef = useRef(false);
  const [voiceFlowActive, setVoiceFlowActive] = useState(false);
  const fnolDataRef = useRef<FnolData>(EMPTY_DATA);
  const [showVoiceReview, setShowVoiceReview] = useState(false);
  const showVoiceReviewRef = useRef(false);
  const [editableVoice, setEditableVoice] = useState<FnolData>(EMPTY_DATA);
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  const isAssistantSpeakingRef = useRef(false);
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState(false);
  // new const - ref perplexity
  const lastSpeechEndRef = useRef<number>(0);
  // Voice state machine + processing lock + dedup
  const voiceStateRef = useRef<"idle" | "listening" | "processing" | "speaking">("idle");
  const processingLockRef = useRef(false);
  const lastProcessedTextRef = useRef<string>("");

  // Keep ref in sync so voice handlers see latest fnolData without stale closures.
  useEffect(() => { fnolDataRef.current = fnolData; }, [fnolData]);

  const setMutedSafe = (m: boolean) => {
    try { vapiRef.current?.setMuted?.(m); } catch {}
  };

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

  // Single source of truth — first incomplete step in defined order.
  // UI (step indicator, chat question, input placeholder) all derive from this.
  function getCurrentStep(data: FnolData) {
    return STEPS.find((step) => !data[step.key]?.trim()) ?? null;
  }

  function getStepIndex(step: { key: FieldKey } | null) {
    if (!step) return -1;
    return STEPS.findIndex((s) => s.key === step.key);
  }

  function getQuestion(key: FieldKey) {
    return STEPS.find((s) => s.key === key)?.question ?? "";
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

    const currentStep = getCurrentStep(fnolData);

    setMessages((m) => [...m, { role: "user", content: text, source }]);
    setLoading(true);

    try {
      console.log("STEP:", currentStep?.key, "INPUT:", text);

      // ── CORRECTION INTENT ────────────────────────────────────────────────
      const correction = detectCorrection(text);
      if (correction) {
        const merged: FnolData = { ...fnolData };
        let ack = "Got it, I've updated your details.";
        let valid = true;

        if (correction.field === "mobile") {
          const digits = normalizePhoneNumber(correction.value);
          const ten = digits.slice(-10);
          if (isMobileValid(ten)) {
            merged.mobile = ten;
          } else {
            valid = false;
            ack = "I couldn't catch a valid 10-digit Indian mobile number. Please say it digit by digit.";
          }
        } else if (correction.field === "safety") {
          const s = normalizeSafety(correction.value);
          if (s) merged.safety = s;
          else { valid = false; ack = "Please confirm — are you safe right now? Yes or No."; }
        } else if (correction.field === "injuries") {
          merged.injuries = normalizeYesNo(correction.value);
        } else {
          try {
            const ex = await extract(correction.value, correction.field);
            const v = (ex as any)?.[correction.field];
            merged[correction.field] = (v && String(v).trim()) || correction.value;
          } catch {
            merged[correction.field] = correction.value;
          }
        }

        if (valid) setFnolData(merged);
        const nextStep = getCurrentStep(merged);
        console.log("MERGED:", merged, "NEXT:", nextStep?.key);
        const followUp = nextStep ? getQuestion(nextStep.key) : "All set — please review and submit your claim.";
        setMessages((m) => [
          ...m,
          { role: "assistant", content: valid ? `${ack} ${followUp}` : ack },
        ]);
        if (valid && !nextStep) setShowSummary(true);
        return;
      }

      // ── SAFETY STEP — STRICT ─────────────────────────────────────────────
      if (currentStep?.key === "safety") {
        const s = normalizeSafety(text);
        if (!s) {
          setMessages((m) => [
            ...m,
            { role: "assistant", content: "Please confirm — are you safe right now? Yes or No." },
          ]);
          return;
        }
        const merged: FnolData = { ...fnolData, safety: s };
        setFnolData(merged);
        const nextStep = getCurrentStep(merged);
        console.log("MERGED:", merged, "NEXT:", nextStep?.key);
        if (nextStep) {
          setMessages((m) => [...m, { role: "assistant", content: getQuestion(nextStep.key) }]);
        } else {
          setMessages((m) => [...m, { role: "assistant", content: "Thanks — I have everything I need. Here's a quick summary." }]);
          setShowSummary(true);
        }
        return;
      }

      // ── MOBILE STEP — STRICT ─────────────────────────────────────────────
              if (currentStep?.key === "mobile") {
        // Protect existing valid mobile.
        if (isMobileValid(fnolData.mobile)) {
          const nextStep = getCurrentStep(fnolData);
          if (nextStep) setMessages((m) => [...m, { role: "assistant", content: getQuestion(nextStep.key) }]);
          return;
        }
        const digits = normalizePhoneNumber(text);
        // Must have AT LEAST 10 digits before taking last 10
        if (digits.length < 10) {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content:
                "I couldn't catch a valid 10-digit Indian mobile number. Please say all 10 digits clearly, for example: nine eight seven six five four three two one zero.",
            },
          ]);
          return;
        }
        const ten = digits.slice(-10);
        if (!isMobileValid(ten)) {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content:
                "I couldn't catch a valid 10-digit Indian mobile number. It must start with 6, 7, 8 or 9. Please say it digit by digit.",
            },
          ]);
          return;
        }
        const merged: FnolData = { ...fnolData, mobile: ten };
        setFnolData(merged);
        const nextStep = getCurrentStep(merged);
        console.log("MERGED:", merged, "NEXT:", nextStep?.key);
        if (nextStep) {
          setMessages((m) => [...m, { role: "assistant", content: getQuestion(nextStep.key) }]);
        } else {
          setMessages((m) => [...m, { role: "assistant", content: "Thanks — I have everything I need. Here's a quick summary." }]);
          setShowSummary(true);
        }
        return;
      }

      // ── EXTRACT FOR OTHER STEPS ──────────────────────────────────────────
      const extractedRaw = await extract(text, currentStep?.key ?? "description");
      const allowedKeys: FieldKey[] = ["location", "description", "injuries"];
      const extracted: Partial<FnolData> = {};
      if (extractedRaw) {
        (Object.keys(extractedRaw) as FieldKey[]).forEach((key) => {
          if (allowedKeys.includes(key) && extractedRaw[key] && String(extractedRaw[key]).trim()) {
            extracted[key] = String(extractedRaw[key]).trim();
          }
        });
      }

      // Regex safety net.
      if (!extracted.location) {
        const match = text.match(/near ([a-zA-Z\s]+)/i);
        if (match) extracted.location = match[1].trim();
      }
      if (!extracted.injuries) {
        const lower = text.toLowerCase();
        if (lower.includes("no injuries") || lower.includes("no injury")) {
          extracted.injuries = "No";
        } else if (lower.includes("injury") || lower.includes("injuries")) {
          extracted.injuries = "Yes";
        }
      }

      // Merge — never overwrite existing valid values.
      const merged: FnolData = { ...fnolData };
      (Object.keys(extracted) as FieldKey[]).forEach((k) => {
        const val = extracted[k];
        if (val && !merged[k]?.trim()) merged[k] = val;
      });

      // Fallback to raw text for current step if extractor missed.
      if (currentStep && !merged[currentStep.key]?.trim()) {
        merged[currentStep.key] = currentStep.key === "injuries" ? normalizeYesNo(text) : text;
      }

      // Protect existing valid mobile / safety from being clobbered.
      if (isMobileValid(fnolData.mobile)) merged.mobile = fnolData.mobile;
      if (fnolData.safety === "Yes" || fnolData.safety === "No") merged.safety = fnolData.safety;

      setFnolData(merged);
      const nextStep = getCurrentStep(merged);
      console.log("MERGED:", merged, "NEXT:", nextStep?.key);
      if (nextStep) {
        setMessages((m) => [...m, { role: "assistant", content: getQuestion(nextStep.key) }]);
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: "Thanks — I have everything I need. Here's a quick summary." },
        ]);
        setShowSummary(true);
      }
    } catch (e) {
      console.error(e);
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

  // ── VAPI lifecycle ────────────────────────────────────────────────────────
  // We do NOT auto-start voice on page load. We only lazy-fetch the config and
  // dynamically import the SDK; the actual `vapi.start()` happens on user click.
  // The instance is held in a ref so re-renders never recreate it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.functions.invoke("fnol-vapi-config");
        if (cancelled || !data?.configured) return;
        const { default: Vapi } = await import("@vapi-ai/web");
        if (cancelled) return;
        VapiCtorRef.current = Vapi;
        vapiPublicKeyRef.current = data.publicKey;
        vapiAssistantIdRef.current = data.assistantId;
      } catch (e) {
        console.error("VAPI config load failed", e);
      }
    })();
    return () => {
      cancelled = true;
      // Always clean up an active session on unmount / refresh / nav-away.
      try { vapiRef.current?.stop?.(); } catch {}
      vapiRef.current = null;
    };
  }, []);

  // Also stop the session on tab close / refresh.
  useEffect(() => {
    const handler = () => {
      try { vapiRef.current?.stop?.(); } catch {}
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  function detachVapiListeners(vapi: any) {
    if (!vapi) return;
    try {
      ["call-start", "call-end", "speech-start", "speech-end", "message", "error"].forEach((evt) =>
        vapi.removeAllListeners?.(evt),
      );
    } catch {}
  }

function attachVapiListeners(vapi: any) {
  vapi.on("call-start", () => {
    setVoiceActive(true);
  });
  vapi.on("call-end", () => {
    setVoiceActive(false);
    setVoiceFlowActive(false);
    voiceFlowActiveRef.current = false;
  });
  vapi.on("speech-start", () => {
    isAssistantSpeakingRef.current = true;
    setIsAssistantSpeaking(true);
    setMutedSafe(true);
  });
  vapi.on("speech-end", () => {
    lastSpeechEndRef.current = Date.now();
    setTimeout(() => {
      isAssistantSpeakingRef.current = false;
      setIsAssistantSpeaking(false);
      setMutedSafe(false);
    }, 1800);
  });
  vapi.on("error", (e: any) => {
    console.error("VAPI error", e);
  });
  vapi.on("message", (m: any) => {
    if (m?.type !== "transcript" || m?.role !== "user") return;
    if (m.transcriptType !== "final") return;
    if (!voiceFlowActiveRef.current || showVoiceReviewRef.current) return;
    if (isAssistantSpeakingRef.current) return;
    if (Date.now() - lastSpeechEndRef.current < 1800) return;
    const text = String(m.transcript ?? "").trim();
    if (!text) return;
    handleUserInput(text, "voice");
  });
}
  // Mic press: explicit user action starts the session.
  async function startVoice() {
    setMode("voice");

    // Mock fallback if VAPI not configured.
    if (!VapiCtorRef.current || !vapiPublicKeyRef.current || !vapiAssistantIdRef.current) {
      toast.error("Voice is not configured. Please use chat.");
      setMode("chat");
      return;
    }

    // Always stop any prior session before starting a new one.
    try {
      if (vapiRef.current) {
        detachVapiListeners(vapiRef.current);
        await vapiRef.current.stop?.();
      }
    } catch {}
    vapiRef.current = null;

    const vapi = new VapiCtorRef.current(vapiPublicKeyRef.current);
    vapiRef.current = vapi;

    // Register ALL listeners BEFORE start().
    attachVapiListeners(vapi);

    voiceFlowActiveRef.current = true;
    setVoiceFlowActive(true);
    setVoiceActive(true);
    showVoiceReviewRef.current = false;
    setShowVoiceReview(false);

    // Pass the current step context to VAPI so the assistant aligns with the screen.
    const current = getCurrentStep(fnolDataRef.current);
    const variableValues = {
      currentStep: current ? STEP_LABEL[current.key] : "Summary",
      currentQuestion: current ? current.question : "",
    };

    try {
      await vapi.start(vapiAssistantIdRef.current, { variableValues });
    } catch (e) {
      console.error("VAPI start failed", e);
      voiceFlowActiveRef.current = false;
      setVoiceFlowActive(false);
      setVoiceActive(false);
      toast.error("Couldn't start voice. Please try again.");
    }
  }

  function stopVoice() {
    voiceFlowActiveRef.current = false;
    setVoiceFlowActive(false);
    setVoiceActive(false);
    try {
      if (vapiRef.current) {
        detachVapiListeners(vapiRef.current);
        vapiRef.current.stop?.();
      }
    } catch {}
    vapiRef.current = null;
    setMode("chat");
  }

  function cancelVoiceReview() {
    showVoiceReviewRef.current = false;
    setShowVoiceReview(false);
    setEditableVoice(EMPTY_DATA);
    // Reset claim data and restart voice flow from Step 1.
    setFnolData(EMPTY_DATA);
    fnolDataRef.current = EMPTY_DATA;
    setMessages([{ role: "assistant", content: STEPS[0].question }]);
    startVoice();
  }

  // When all required fields are filled while voice flow is active,
  // surface the editable review screen.
  useEffect(() => {
    if (voiceFlowActive && !showVoiceReview && getCurrentStep(fnolData) === null) {
      setEditableVoice(fnolData);
      showVoiceReviewRef.current = true;
      setShowVoiceReview(true);
    }
  }, [fnolData, voiceFlowActive, showVoiceReview]);


  function getISTTimestamp() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
    const istTime = new Date(now.getTime() + istOffset);
    return istTime.toISOString().replace("Z", "+05:30");
  }

  function generateClaimId() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ymd = `${istNow.getUTCFullYear()}${pad(istNow.getUTCMonth() + 1)}${pad(istNow.getUTCDate())}`;
    const hms = `${pad(istNow.getUTCHours())}${pad(istNow.getUTCMinutes())}${pad(istNow.getUTCSeconds())}`;
    return `CLM-${ymd}-${hms}`;
  }

  async function submitVoiceFNOL() {
    setSubmitting(true);
    const claimid = generateClaimId();
    const payload = {
      claimid,
      timestamp: getISTTimestamp(),
      safety: normalizeYesNo(editableVoice.safety),
      mobile: normalizeMobileInput(editableVoice.mobile),
      location: editableVoice.location,
      description: editableVoice.description,
      injuries: normalizeYesNo(editableVoice.injuries),
    };
    try {
      const res = await fetch("https://hook.eu1.make.com/v6zxfe8jqgq115au1h26vtj9r6cwfmb1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Persist edited values back to the single source of truth.
      setFnolData(editableVoice);
      fnolDataRef.current = editableVoice;
      // Stop VAPI session at successful submit.
      try {
        if (vapiRef.current) {
          detachVapiListeners(vapiRef.current);
          vapiRef.current.stop?.();
        }
      } catch {}
      vapiRef.current = null;
      voiceFlowActiveRef.current = false;
      showVoiceReviewRef.current = false;
      setShowVoiceReview(false);
      setVoiceFlowActive(false);
      setVoiceActive(false);
      setSubmitted({ referenceId: claimid });
    } catch (e) {
      console.error(e);
      toast.error("Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitFNOL() {
    if (!allRequiredFilled(fnolData)) {
      toast.error("Please fill location and description first.");
      return;
    }
    setSubmitting(true);
    const claimid = generateClaimId();
    const payload = {
      claimid,
      timestamp: getISTTimestamp(),
      safety: normalizeYesNo(fnolData.safety),
      mobile: normalizeMobileInput(fnolData.mobile),
      location: fnolData.location,
      description: fnolData.description,
      injuries: normalizeYesNo(fnolData.injuries),
    };
    try {
      const res = await fetch("https://hook.eu1.make.com/v6zxfe8jqgq115au1h26vtj9r6cwfmb1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSubmitted({ referenceId: claimid });
    } catch (e) {
      console.error(e);
      toast.error("Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function startOver() {
    // Stop any active voice session and clear all claim data.
    try {
      if (vapiRef.current) {
        detachVapiListeners(vapiRef.current);
        vapiRef.current.stop?.();
      }
    } catch {}
    vapiRef.current = null;
    voiceFlowActiveRef.current = false;
    setVoiceFlowActive(false);
    setVoiceActive(false);
    showVoiceReviewRef.current = false;
    setShowVoiceReview(false);
    setEditableVoice(EMPTY_DATA);
    setMessages([{ role: "assistant", content: STEPS[0].question }]);
    setFnolData(EMPTY_DATA);
    fnolDataRef.current = EMPTY_DATA;
    setShowSummary(false);
    setSubmitted(null);
    setInput("");
    setLastError(null);
    setPendingTranscript(null);
    setMode("chat");
  }

  // SINGLE source of truth — both chat & voice derive UI from fnolData.
  const activeStep = getCurrentStep(fnolData);
  const activeStepIndex = getStepIndex(activeStep);
  const activeStepNumber = activeStepIndex >= 0 ? activeStepIndex + 1 : STEPS.length;
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
          {/* Step indicator */}
          {!submitted && !showSummary && activeStep && (
            <p className="mt-3 text-[11px] opacity-90">
              Step {activeStepNumber} of {STEPS.length} • {STEP_LABEL[activeStep.key]}
            </p>
          )}
          {/* Progress bar */}
          <div className="mt-2 h-1 rounded-full bg-white/20 overflow-hidden">
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
                <div ref={scrollRef} className="h-[55vh] max-h-[460px] overflow-y-auto p-4 space-y-4">
                  <p className="text-xs text-muted-foreground text-center px-2 pb-1">
                    We'll guide you through reporting your accident in a few simple steps.
                  </p>
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

                {/* Continuous voice review (5-question edit screen) */}
                {showVoiceReview && (
                  <div className="border-t bg-accent/40 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Mic className="h-4 w-4 text-primary" />
                      Review your answers before submitting
                    </div>
                    <div className="space-y-2">
                      {STEPS.map((s) => (
                        <div key={s.key} className="space-y-1">
                          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            {FIELD_LABEL[s.key]}
                          </label>
                          <Input
                            value={editableVoice[s.key]}
                            onChange={(e) =>
                              setEditableVoice((prev) => ({ ...prev, [s.key]: e.target.value }))
                            }
                            placeholder={INPUT_PLACEHOLDER[s.key]}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" onClick={cancelVoiceReview} disabled={submitting}>
                        Re-record
                      </Button>
                      <Button size="sm" onClick={submitVoiceFNOL} disabled={submitting}>
                        {submitting ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Submitting…
                          </>
                        ) : (
                          "Submit"
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Voice listening overlay-ish indicator */}
                {voiceActive && !showVoiceReview && (
                  <div className="border-t bg-primary/5 p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-primary">
                      <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                      Listening… {activeStep ? `(${STEP_LABEL[activeStep.key]})` : ""}
                    </div>
                    <Button size="sm" variant="ghost" onClick={stopVoice}>
                      Stop
                    </Button>
                  </div>
                )}


                {/* Composer */}
                {!showSummary && (
                  <div className="border-t">
                    {/* Quick replies for yes/no steps */}
                    {activeStep && (activeStep.key === "safety" || activeStep.key === "injuries") && (
                      <div className="px-3 pt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          disabled={loading || pendingTranscript !== null}
                          onClick={() => handleUserInput("Yes", "chat")}
                        >
                          Yes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          disabled={loading || pendingTranscript !== null}
                          onClick={() => handleUserInput("No", "chat")}
                        >
                          No
                        </Button>
                      </div>
                    )}
                    <div className="p-3 flex gap-2 items-center">
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
                        placeholder={activeStep ? INPUT_PLACEHOLDER[activeStep.key] : "Type your reply…"}
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
                <p className="text-sm text-muted-foreground">Your Claim ID is</p>
                <div className="font-mono text-lg px-4 py-2 rounded-lg bg-assistant-bubble">
                  {submitted.referenceId}
                </div>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Your claim has been submitted. An adjuster will contact you shortly.
                </p>
                <Button variant="outline" onClick={startOver}>
                  Start a new report
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <div className="px-4 py-2.5 text-center text-[11px] text-muted-foreground border-t bg-muted/30">
            Available 24×7 • English supported
          </div>
        </div>
      </Card>
    </div>
  );
}
