// Creates a Stripe Checkout session for the Grid Build subscription.
// Authenticated via the caller's Supabase JWT (Authorization: Bearer <token>).

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

    const origin = baseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      allow_promotion_codes: true,
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/?upgrade=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("create-checkout-session error:", error);
    return res.status(500).json({ error: "Could not start checkout." });
  }
}
