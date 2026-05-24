// Stripe webhook: keeps profiles.subscription_status in sync with Stripe.
// Needs the raw request body for signature verification, so body parsing is disabled.

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !supabaseServiceKey) {
    return res.status(500).json({ error: "Stripe/Supabase not configured." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error("Webhook signature verification failed:", error.message);
    return res.status(400).json({ error: `Webhook Error: ${error.message}` });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.user_id;
      if (userId) {
        await supabase.from("profiles").upsert(
          {
            user_id: userId,
            stripe_customer_id: session.customer || null,
            stripe_subscription_id: session.subscription || null,
            subscription_status: "active",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const status =
        event.type === "customer.subscription.deleted"
          ? "canceled"
          : subscription.status === "active" || subscription.status === "trialing"
          ? "active"
          : subscription.status;
      await supabase
        .from("profiles")
        .update({
          subscription_status: status,
          stripe_subscription_id: subscription.id,
          current_period_end: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_customer_id", subscription.customer);
    }
  } catch (error) {
    console.error("Webhook handler error:", error);
    // Acknowledge anyway so Stripe doesn't retry indefinitely; we log for follow-up.
  }

  return res.status(200).json({ received: true });
}
