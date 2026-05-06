import { neon } from "@neondatabase/serverless";
import { SignJWT, jwtVerify } from "jose";
import { Resend } from "resend";
import Stripe from "stripe";

const SITE_URL = "https://realestatewithoutbullshit.com";
const API_URL = "https://api.realestatewithoutbullshit.com";
const FROM_EMAIL = "REBWB <noreply@realestatewithoutbullshit.com>";
const MAGIC_LINK_TTL = "15m";
const SESSION_TTL = "30d";

const ALLOWED_ORIGINS = [
  "https://realestatewithoutbullshit.com",
  "https://www.realestatewithoutbullshit.com",
  "http://localhost:8788",
  "http://localhost:3000",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function json(data, init = {}, origin = "") {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
      ...(init.headers || {}),
    },
  });
}

function jwtSecret(env) {
  return new TextEncoder().encode(env.JWT_SECRET);
}

async function signMagicLinkToken(email, env) {
  return await new SignJWT({ email, purpose: "magic_link" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(MAGIC_LINK_TTL)
    .sign(jwtSecret(env));
}

async function signSessionToken(user, env) {
  return await new SignJWT({ email: user.email, sub: user.id, purpose: "session" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(jwtSecret(env));
}

async function verifyTokenForPurpose(token, purpose, env) {
  const { payload } = await jwtVerify(token, jwtSecret(env));
  if (payload.purpose !== purpose) throw new Error("Wrong token purpose");
  return payload;
}

async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return await verifyTokenForPurpose(token, "session", env);
  } catch {
    return null;
  }
}

async function getOrCreateUser(sql, email) {
  const normalized = String(email).trim().toLowerCase();
  const rows = await sql`
    INSERT INTO users (email)
    VALUES (${normalized})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id, email, created_at
  `;
  return rows[0];
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function magicLinkEmailHtml(link) {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="margin: 0 0 16px;">Sign in to REBWB</h2>
      <p>Click the button below to sign in. This link expires in 15 minutes.</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Sign in</a>
      </p>
      <p style="color: #666; font-size: 14px;">Or paste this URL into your browser:<br><a href="${link}">${link}</a></p>
      <p style="color: #999; font-size: 12px; margin-top: 32px;">If you didn't request this, ignore this email.</p>
    </div>
  `;
}

function magicLinkEmailText(link) {
  return `Sign in to REBWB\n\nOpen this link to sign in (expires in 15 minutes):\n\n${link}\n\nIf you didn't request this, ignore this email.`;
}

function stripeClient(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: "2025-10-28",
  });
}

async function handleStripeWebhook(request, env, sql, origin) {
  const stripe = stripeClient(env);
  const sig = request.headers.get("stripe-signature");
  const body = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const email = session.metadata?.email || session.customer_details?.email;
      const planType = session.metadata?.plan_type;
      if (email && planType) {
        const user = await getOrCreateUser(sql, email);
        await sql`
          INSERT INTO user_purchases (user_id, plan_type, stripe_customer_id, stripe_subscription_id, status)
          VALUES (${user.id}, ${planType}, ${session.customer}, ${session.subscription}, 'active')
        `;
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await sql`
        UPDATE user_purchases SET status = 'canceled'
        WHERE stripe_subscription_id = ${sub.id}
      `;
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : sub.status;
      await sql`
        UPDATE user_purchases SET status = ${status}
        WHERE stripe_subscription_id = ${sub.id}
      `;
      break;
    }
  }

  return json({ received: true }, {}, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const sql = neon(env.NEON_DATABASE_URL);

    // Public endpoints — no auth required.
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true }, {}, origin);
    }

    if (url.pathname === "/api/webhooks/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env, sql, origin);
    }

    if (url.pathname === "/api/auth/request" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (!isValidEmail(email)) {
        return json({ error: "Invalid email" }, { status: 400 }, origin);
      }

      const linkToken = await signMagicLinkToken(email, env);
      const link = `${API_URL}/api/auth/verify?token=${encodeURIComponent(linkToken)}`;

      const resend = new Resend(env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: "Sign in to REBWB",
        html: magicLinkEmailHtml(link),
        text: magicLinkEmailText(link),
      });
      if (error) {
        return json({ error: `Email failed: ${error.message || "unknown"}` }, { status: 502 }, origin);
      }

      return json({ ok: true }, {}, origin);
    }

    if (url.pathname === "/api/auth/verify" && request.method === "GET") {
      const token = url.searchParams.get("token");
      if (!token) return new Response("Missing token", { status: 400 });
      try {
        const claims = await verifyTokenForPurpose(token, "magic_link", env);
        const user = await getOrCreateUser(sql, claims.email);
        const sessionJwt = await signSessionToken(user, env);
        const redirect = `${SITE_URL}/auth-callback.html#token=${encodeURIComponent(sessionJwt)}`;
        return Response.redirect(redirect, 302);
      } catch (err) {
        return new Response(`Invalid or expired link: ${err.message}`, { status: 400 });
      }
    }

    // Authenticated endpoints below this line.
    const claims = await authenticate(request, env);
    if (!claims) return json({ error: "Unauthorized" }, { status: 401 }, origin);
    const userEmail = claims.email;

    if (url.pathname === "/api/me" && request.method === "GET") {
      const user = await getOrCreateUser(sql, userEmail);
      const purchases = await sql`
        SELECT plan_type, status, stripe_subscription_id, created_at
        FROM user_purchases
        WHERE user_id = ${user.id} AND status = 'active'
        ORDER BY created_at DESC
      `;
      return json({ user, purchases }, {}, origin);
    }

    if (url.pathname === "/api/access" && request.method === "GET") {
      const user = await getOrCreateUser(sql, userEmail);
      const rows = await sql`
        SELECT plan_type FROM user_purchases
        WHERE user_id = ${user.id} AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `;
      const plan = rows[0]?.plan_type ?? null;
      return json({ hasAccess: plan !== null, plan }, {}, origin);
    }

    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const stripe = stripeClient(env);
      const { plan_type } = await request.json();
      const priceMap = {
        discipline: env.STRIPE_PRICE_DISCIPLINE,
        system: env.STRIPE_PRICE_SYSTEM,
      };
      const price = priceMap[plan_type];
      if (!price) return json({ error: "Invalid plan_type" }, { status: 400 }, origin);

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        customer_email: userEmail,
        metadata: { plan_type, email: userEmail },
        success_url: `${SITE_URL}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/pricing.html`,
      });

      return json({ url: session.url }, {}, origin);
    }

    if (url.pathname === "/api/kill-switch/runs" && request.method === "POST") {
      const user = await getOrCreateUser(sql, userEmail);
      const body = await request.json();
      const { deal_data, fail_flags = 0, warning_flags = 0, verdict } = body || {};
      const rows = await sql`
        INSERT INTO kill_switch_runs (user_id, deal_data, fail_flags, warning_flags, verdict)
        VALUES (${user.id}, ${deal_data ?? null}, ${fail_flags}, ${warning_flags}, ${verdict ?? null})
        RETURNING id, created_at
      `;
      return json({ run: rows[0] }, {}, origin);
    }

    if (url.pathname === "/api/kill-switch/runs" && request.method === "GET") {
      const user = await getOrCreateUser(sql, userEmail);
      const runs = await sql`
        SELECT id, deal_data, fail_flags, warning_flags, verdict, created_at
        FROM kill_switch_runs
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return json({ runs }, {}, origin);
    }

    return json({ error: "Not found" }, { status: 404 }, origin);
  },
};
