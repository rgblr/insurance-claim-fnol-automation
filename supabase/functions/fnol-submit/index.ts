// Forwards the structured FNOL payload to a Make.com webhook; mocks if URL not set.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const webhookUrl = Deno.env.get("MAKE_WEBHOOK_URL");
    const referenceId = `FNOL-${Date.now().toString(36).toUpperCase()}`;

    if (!webhookUrl) {
      console.log("MAKE_WEBHOOK_URL not set — mock submission:", payload);
      return new Response(
        JSON.stringify({ ok: true, referenceId, mocked: true, message: "This is a demo FNOL response" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceId, ...payload }),
    });

    return new Response(
      JSON.stringify({ ok: res.ok, referenceId, mocked: false, status: res.status }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("fnol-submit error:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
