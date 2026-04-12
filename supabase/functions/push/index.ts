/**
 * Push delivery is handled by the backend API (firebase-admin).
 * This edge function intentionally does not send notifications to avoid duplicate pushes.
 */
interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table?: string;
  schema?: string;
  record?: Record<string, unknown>;
  old_record?: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  let payload: WebhookPayload | null = null;
  try {
    payload = await req.json();
  } catch {
    // Accept non-JSON invocations and return a no-op response.
  }

  return new Response(
    JSON.stringify({
      success: true,
      disabled: true,
      message: "Push delivery is disabled in Supabase Edge Function. Use backend API FCM path.",
      table: payload?.table ?? null,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
