// Creates a Stripe Customer Portal session so subscribers can manage/cancel their subscription.
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
  if (!process.env.STRIPE_SECRET_KEY) {
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

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({ error: "No billing account found. Please subscribe first." });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl(req)}/`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (error) {
    console.error("create-portal-session error:", error);
    return res.status(500).json({ error: "Could not open billing portal." });
  }
}
