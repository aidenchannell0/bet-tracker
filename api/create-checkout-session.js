// Creates a Stripe Checkout session for the Grid Build subscription.
// Authenticated via the caller's Supabase JWT (Authorization: Bearer <token>).

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Founding-member promo: the first 20 people to subscribe get a locked-in
// discounted rate (A$4.99 vs A$6.99) via a forever-duration Stripe coupon.
const FOUNDING_LIMIT = 20;

function baseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${req.headers.host}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    return res.status(500).json({ error: "Stripe is not configured." });
  }
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: "Supabase service key is not configured." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (userError || !user) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    // Reuse or create the Stripe customer for this user
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = profile?.stripe_customer_id;
    // Verify the stored customer still exists in THIS Stripe account/mode. A
    // customer created under test keys (or since deleted) 404s after switching
    // to live keys — which surfaced as "No such customer" at checkout. If it's
    // gone, drop it and create a fresh one below.
    if (customerId) {
      try {
        const existing = await stripe.customers.retrieve(customerId);
        if (existing?.deleted) customerId = null;
      } catch (lookupErr) {
        if (lookupErr?.code === "resource_missing" || lookupErr?.statusCode === 404) {
          customerId = null;
        } else {
          throw lookupErr;
        }
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      await supabase
        .from("profiles")
        .upsert({ user_id: user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
    }

    // Founding-member eligibility: apply the locked-in coupon if this user
    // would be within the first FOUNDING_LIMIT active subscribers and a coupon
    // is configured. Stripe Checkout can't combine `discounts` with
    // `allow_promotion_codes`, so we use one or the other.
    let foundingEligible = false;
    if (process.env.STRIPE_FOUNDING_COUPON) {
      const { count } = await supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("subscription_status", "active");
      foundingEligible = (count || 0) < FOUNDING_LIMIT;
    }

    const origin = baseUrl(req);
    const sessionParams = {
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { user_id: user.id, founding: foundingEligible ? "1" : "0" },
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/?upgrade=cancelled`,
    };
    if (foundingEligible) {
      sessionParams.discounts = [{ coupon: process.env.STRIPE_FOUNDING_COUPON }];
    } else {
      sessionParams.allow_promotion_codes = true;
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create(sessionParams);
    } catch (couponErr) {
      // Don't let a bad founding coupon (expired / fully redeemed / deleted)
      // block checkout — fall back to a standard session so users can still
      // subscribe at the regular price.
      if (foundingEligible) {
        console.error("Founding coupon failed, retrying without it:", couponErr?.message);
        delete sessionParams.discounts;
        sessionParams.allow_promotion_codes = true;
        session = await stripe.checkout.sessions.create(sessionParams);
      } else {
        throw couponErr;
      }
    }

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("create-checkout-session error:", error);
    // Surface the real Stripe message (e.g. "No such price", "Invalid API Key",
    // coupon errors) so config issues are diagnosable from the client.
    return res.status(500).json({ error: error?.message || "Could not start checkout." });
  }
}
