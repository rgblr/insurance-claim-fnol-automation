// Returns Vapi public key + assistant id for the browser; safe (publishable) values.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const publicKey = Deno.env.get("VAPI_PUBLIC_KEY") ?? "";
  const assistantId = Deno.env.get("VAPI_ASSISTANT_ID") ?? "";
  return new Response(
    JSON.stringify({ publicKey, assistantId, configured: !!(publicKey && assistantId) }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
