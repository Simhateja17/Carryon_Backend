import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library@9";
import serviceAccount from "../service-account.json" with { type: "json" };

interface WebhookPayload {
  type: "INSERT" | "UPDATE";
  table: string;
  record: Record<string, unknown>;
  schema: "public";
  old_record: null | Record<string, unknown>;
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  const payload: WebhookPayload = await req.json();

  if (payload.table === "Booking") {
    return handleBookingEvent(payload);
  }

  if (payload.table === "DriverNotification") {
    return handleNotificationEvent(payload);
  }

  return jsonResponse({ message: `Unhandled table: ${payload.table}` });
});

// ── Booking table: new job searching for driver ─────────────

async function handleBookingEvent(payload: WebhookPayload) {
  const record = payload.record as {
    id: string;
    status: string;
    estimatedPrice: number;
    distance: number;
  };

  if (record.status !== "SEARCHING_DRIVER") {
    return jsonResponse({ message: "Not a SEARCHING_DRIVER event, skipping" });
  }

  // Push to all online drivers
  const { data: drivers } = await supabase
    .from("Driver")
    .select("id, fcmToken")
    .eq("isOnline", true)
    .not("fcmToken", "is", null);

  if (!drivers || drivers.length === 0) {
    return jsonResponse({ message: "No online drivers with FCM tokens" });
  }

  const results = await sendFcmToMany(
    drivers.map((d: { fcmToken: string }) => d.fcmToken),
    {
      title: "New Delivery Request",
      body: `New delivery available — RM${record.estimatedPrice?.toFixed(2) || "0.00"}, ${record.distance?.toFixed(1) || "0"}km`,
    },
    { type: "JOB_REQUEST", bookingId: record.id }
  );

  return jsonResponse({ sent: results.length, results });
}

// ── DriverNotification table: marketing / system push ───────

async function handleNotificationEvent(payload: WebhookPayload) {
  const record = payload.record as {
    id: string;
    driverId: string;
    title: string;
    message: string;
    type: string;
  };

  // Look up the specific driver's FCM token
  const { data: driver } = await supabase
    .from("Driver")
    .select("fcmToken")
    .eq("id", record.driverId)
    .single();

  if (!driver?.fcmToken) {
    return jsonResponse({ message: "Driver has no FCM token" });
  }

  const results = await sendFcmToMany(
    [driver.fcmToken],
    { title: record.title, body: record.message },
    { type: record.type, notificationId: record.id }
  );

  return jsonResponse({ sent: 1, results });
}

// ── FCM helpers ─────────────────────────────────────────────

async function sendFcmToMany(
  tokens: string[],
  notification: { title: string; body: string },
  data: Record<string, string>
) {
  const accessToken = await getAccessToken({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  });

  return Promise.allSettled(
    tokens.map(async (token) => {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              notification,
              data,
              android: {
                priority: "high",
                notification: {
                  sound: "default",
                  channelId: "job_requests",
                },
              },
            },
          }),
        }
      );
      return res.json();
    })
  );
}

function getAccessToken({
  clientEmail,
  privateKey,
}: {
  clientEmail: string;
  privateKey: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const jwtClient = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    });
    jwtClient.authorize((err, tokens) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(tokens!.access_token!);
    });
  });
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
