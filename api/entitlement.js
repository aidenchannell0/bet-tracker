// Returns the caller's Grid Build entitlement: subscribed?, builds used this week, limit.
// Authenticated via the Supabase JWT (Authorization: Bearer <token>).

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FREE_BUILDS_PER_WEEK = 3;

function startOfWeekIso() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const fallback = { subscribed: false, usage: 0, limit: FREE_BUILDS_PER_WEEK };
  const supabase = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;
  if (!supabase) return res.status(200).json(fallback);

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    const { data: userData } = await supabase.auth.getUser(token);
    const user = userData?.user;
    if (!user) return res.status(200).json(fallback);

    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_status")
      .eq("user_id", user.id)
      .maybeSingle();

    const subscribed = profile?.subscription_status === "active";
    let usage = 0;
    if (!subscribed) {
      const { count } = await supabase
        .from("grid_build_usage")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", startOfWeekIso());
      usage = count || 0;
    }

    return res.status(200).json({ subscribed, usage, limit: FREE_BUILDS_PER_WEEK });
  } catch (error) {
    console.error("entitlement error:", error);
    return res.status(200).json(fallback);
  }
}
