// FNOL chat backend: calls Hugging Face Serverless API; falls back to demo when no token.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are a calm, empathetic FNOL (First Notice of Loss) assistant for a motor insurance company.
Your job is to help a possibly stressed user report a motor accident in under 2 minutes.
Guide them through these fields one at a time, in a warm conversational tone (1-2 short sentences max per turn):
1. Are you safe? Anyone injured?
2. Policy number or registered phone
3. Date & time of accident
4. Location (address or landmark)
5. Brief description of what happened
6. Vehicle damage description
7. Other vehicle / third party involved?
8. Photos available? (yes/no)

Once all fields are gathered, respond with a short summary starting with "SUMMARY:" and a JSON object on the next line containing the structured data.`;

async function callHuggingFace(token: string, messages: Array<{ role: string; content: string }>) {
  // Use a free conversational instruct model on HF Serverless Inference
  const model = "mistralai/Mistral-7B-Instruct-v0.3";
  const prompt =
    `<s>[INST] ${SYSTEM_PROMPT}\n\nConversation so far:\n` +
    messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n") +
    `\n\nRespond as the assistant with the next short message. [/INST]`;

  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 180, temperature: 0.5, return_full_text: false },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HF API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text.trim();
  if (typeof data === "object" && data.generated_text) return data.generated_text.trim();
  return "Got it. Could you share a bit more detail?";
}

// Deterministic mock fallback used when HUGGINGFACE_API_TOKEN isn't configured.
function mockReply(messages: Array<{ role: string; content: string }>) {
  const userTurns = messages.filter((m) => m.role === "user").length;
  const script = [
    "Hi, I'm here to help. First — are you safe right now? Is anyone injured?",
    "Thanks for letting me know. Could you share your policy number or registered phone?",
    "Got it. When did the accident happen? (date and approximate time)",
    "Where did it happen? An address, junction or landmark works.",
    "Can you briefly describe what happened?",
    "What damage does your vehicle have?",
    "Was another vehicle or person involved? Any details would help.",
    "Last one — do you have photos of the scene or damage? (yes/no)",
    'SUMMARY: Thanks, I have everything I need. Submitting your claim now.\n{"status":"complete","note":"This is a demo FNOL response"}',
  ];
  return script[Math.min(userTurns, script.length - 1)];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages } = await req.json();
    const token = Deno.env.get("HUGGINGFACE_API_TOKEN");

    let reply: string;
    let source: "huggingface" | "mock" = "mock";

    if (!token) {
      reply = mockReply(messages ?? []);
    } else {
      try {
        reply = await callHuggingFace(token, messages ?? []);
        source = "huggingface";
      } catch (e) {
        console.error("HF call failed, falling back to mock:", e);
        reply = mockReply(messages ?? []);
      }
    }

    return new Response(JSON.stringify({ reply, source }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("fnol-chat error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
