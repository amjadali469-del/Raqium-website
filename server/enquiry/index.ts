// Raqium website enquiry form: checks a submission and posts it to Slack.
//
// Runs as a Supabase Edge Function named "raqium-enquiry", deployed with verify_jwt = false because the public
// website calls it without a login. Secret (Supabase -> Edge Functions -> Secrets):
//   RAQIUM_SLACK_WEBHOOK_URL   a Slack "Incoming Webhook" address for the channel that should receive enquiries.
// The webhook address is never in this repository or in the web page.

const ALLOWED_ORIGINS = new Set(["https://raqiumtech.co.uk", "https://www.raqiumtech.co.uk"]);

export const KINDS: Record<string, string> = {
  private: "Private individual",
  business: "Business or institution",
};
export const NATURES: Record<string, string> = {
  investing: "Investing",
  piloting: "Piloting a platform",
  partnering: "Partnering",
  other: "Something else",
};

const MIN_FILL_MS = 3000; // a person needs longer than this to fill the form; a script posting straight away does not
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5; // submissions per address per hour (per running instance: a brake, not a guarantee)
const hits = new Map<string, number[]>();

export interface Enquiry {
  kind: string;
  nature: string;
  company: string;
  name: string;
  email: string;
  phone: string;
  message: string;
}
export type Checked = { ok: true; value: Enquiry } | { ok: false; field: string; message: string };

// Remove control characters; single-line fields also lose line breaks and repeated spaces.
const text = (v: unknown, max: number, multiline = false): string => {
  if (typeof v !== "string") return "";
  // deno-lint-ignore no-control-regex
  let s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = multiline ? s.replace(/\r\n?/g, "\n") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
};

export function check(body: unknown): Checked {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const kind = text(b["kind"], 20);
  const nature = text(b["nature"], 20);
  const company = text(b["company"], 120);
  const name = text(b["name"], 100);
  const email = text(b["email"], 254);
  const phone = text(b["phone"], 30);
  const message = text(b["message"], 1500, true);

  if (!(kind in KINDS)) return { ok: false, field: "kind", message: "Please choose who is enquiring." };
  if (!(nature in NATURES)) return { ok: false, field: "nature", message: "Please choose the nature of your enquiry." };
  if (kind === "business" && company.length < 2)
    return { ok: false, field: "company", message: "Please give the company or institution name." };
  if (name.length < 2) return { ok: false, field: "name", message: "Please give a contact name." };
  if (!email && !phone) return { ok: false, field: "email", message: "Please give an email address or a phone number." };
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email))
    return { ok: false, field: "email", message: "That email address doesn't look right." };
  if (phone && (!/^[+()\d][\d\s().+-]{5,28}$/.test(phone) || phone.replace(/\D/g, "").length < 7))
    return { ok: false, field: "phone", message: "That phone number doesn't look right." };
  if (message.length < 10) return { ok: false, field: "message", message: "Please add a short description of your enquiry." };
  return { ok: true, value: { kind, nature, company, name, email, phone, message } };
}

// Slack reads < > & specially, so they are escaped: this stops visitors adding @channel pings or links.
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function slackPayload(e: Enquiry) {
  const field = (label: string, value: string) => ({
    type: "mrkdwn",
    text: `*${label}*\n${cap(esc(value) || "—", 300)}`,
  });
  const nature = NATURES[e.nature] ?? e.nature;
  return {
    text: `New website enquiry from ${cap(esc(e.name), 80)} (${nature})`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "New Raqium website enquiry" } },
      {
        type: "section",
        fields: [
          field("Enquiring as", KINDS[e.kind] ?? e.kind),
          field("Nature of enquiry", nature),
          field("Name", e.name),
          field("Company or institution", e.company),
          field("Email", e.email),
          field("Phone", e.phone),
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*Description*\n${cap(esc(e.message), 2900)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Sent from the raqiumtech.co.uk contact form" }] },
    ],
  };
}

const limited = (ip: string, now: number): boolean => {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(k);
  return false;
};

export async function handle(
  req: Request,
  getEnv: (name: string) => string | undefined,
  now: number = Date.now(),
): Promise<Response> {
  const origin = req.headers.get("origin") ?? "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (!ALLOWED_ORIGINS.has(origin)) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const raw = await req.text();
  if (raw.length > 12000) return reply({ error: "too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  // Robots: the hidden "website" box is filled in, or the form was posted faster than a person could fill it.
  // They get the same "thank you" so they learn nothing; nothing is sent.
  const elapsed = typeof b["elapsed"] === "number" ? b["elapsed"] : 0;
  if ((typeof b["website"] === "string" && b["website"] !== "") || elapsed < MIN_FILL_MS) return reply({ ok: true });

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (limited(ip, now)) return reply({ error: "rate_limited" }, 429);

  const checked = check(b);
  if (!checked.ok) return reply({ error: "invalid", field: checked.field, message: checked.message }, 400);

  const hook = getEnv("RAQIUM_SLACK_WEBHOOK_URL");
  if (!hook) {
    console.error("raqium-enquiry: RAQIUM_SLACK_WEBHOOK_URL is not set");
    return reply({ error: "not_configured" }, 503);
  }
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload(checked.value)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("raqium-enquiry: Slack answered", res.status);
      return reply({ error: "delivery_failed" }, 502);
    }
  } catch (e) {
    console.error("raqium-enquiry: Slack call failed", e instanceof Error ? e.name : "error");
    return reply({ error: "delivery_failed" }, 502);
  }
  return reply({ ok: true });
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && typeof D.serve === "function") D.serve((req: Request) => handle(req, (n) => D.env.get(n)));
