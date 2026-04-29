// FNOL extractor backend.
// The CONVERSATION FLOW is controlled by the client app — this function does
// NOT drive the dialogue. It uses Hugging Face ONLY to extract structured
// fields from a single user utterance. If the model is unavailable, we fall
// back to lightweight heuristics so the demo always works.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Extracted = {
  location?: string;
  description?: string;
  injuries?: string;
};

const ALLOWED_FIELDS = ["location", "description", "injuries"] as const;

const EXTRACT_PROMPT = (input: string) =>
  `Extract structured data from the user input.

Return ONLY valid JSON. Do not include any extra fields.

Allowed fields ONLY:
- location
- description
- injuries

Schema:
{
  "location": "",
  "description": "",
  "injuries": ""
}

Rules:
- Do NOT include any field not listed above
- "location" = place of accident
- "injuries" = "Yes" or "No"
- If a field is not mentioned, leave it empty

User input: "${input}"`;

function tryParseJson(text: string): Extracted | null {
  // Pull the first {...} block out of the model response.
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj && typeof obj === "object") return obj as Extracted;
  } catch {
    return null;
  }
  return null;
}

async function callHuggingFace(token: string, input: string): Promise<Extracted | null> {
  const model = "mistralai/Mistral-7B-Instruct-v0.3";
  const prompt = `<s>[INST] ${EXTRACT_PROMPT(input)} [/INST]`;

  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 200, temperature: 0.1, return_full_text: false },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HF API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = Array.isArray(data) ? data[0]?.generated_text ?? "" : data.generated_text ?? "";
  return tryParseJson(text);
}

// Lightweight fallback so the demo still extracts something useful when HF
// is rate-limited or the token is missing.
function heuristicExtract(input: string, expectedField?: string): Extracted {
  const out: Extracted = {};
  const t = input.trim();
  const lower = t.toLowerCase();

  // Mobile (10-digit run, optional country code).
  const mobileMatch = t.match(/(?:\+?\d{1,3}[\s-]?)?\d{10}/);
  if (mobileMatch) out.mobile = mobileMatch[0].replace(/\D/g, "").slice(-10);

  // Safety yes/no cues.
  if (/\b(yes|safe|ok|okay|fine|theek|ठीक|सुरक्षित|haan|हाँ)\b/i.test(lower)) out.safety = "yes";
  else if (/\b(no|not safe|hurt|injured|nahi|नहीं)\b/i.test(lower)) out.safety = "no";

  // Injuries cues.
  if (/\b(no injur|nobody hurt|no one hurt|sab theek|koi nahi)\b/i.test(lower)) out.injuries = "none";
  else if (/\b(injur|hurt|bleed|fracture|chot|घायल)\b/i.test(lower)) out.injuries = t;

  // If the app told us which field it was asking about, treat the raw text
  // as that field when we couldn't pattern-match anything better.
  if (expectedField === "location" && !out.location) out.location = t;
  if (expectedField === "description" && !out.description) out.description = t;
  if (expectedField === "safety" && !out.safety) out.safety = t;
  if (expectedField === "injuries" && !out.injuries) out.injuries = t;

  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { input, expectedField } = await req.json();
    if (typeof input !== "string" || !input.trim()) {
      return new Response(JSON.stringify({ extracted: {}, source: "empty" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = Deno.env.get("HUGGINGFACE_API_TOKEN");
    let extracted: Extracted = {};
    let source: "huggingface" | "heuristic" = "heuristic";

    if (token) {
      try {
        const hf = await callHuggingFace(token, input);
        if (hf) {
          extracted = hf;
          source = "huggingface";
        }
      } catch (e) {
        console.error("HF extract failed, using heuristic:", e);
      }
    }

    // Always backfill with heuristics so we never return completely empty.
    const fallback = heuristicExtract(input, expectedField);
    extracted = { ...fallback, ...extracted };

    // Strip empty strings.
    for (const k of Object.keys(extracted) as (keyof Extracted)[]) {
      if (!extracted[k] || !String(extracted[k]).trim()) delete extracted[k];
    }

    return new Response(JSON.stringify({ extracted, source }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("fnol-chat error:", e);
    return new Response(JSON.stringify({ error: String(e), extracted: {} }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
