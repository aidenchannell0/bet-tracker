import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, LineChart, Line, AreaChart, Area, ComposedChart, ReferenceLine } from "recharts";
import { Analytics } from "@vercel/analytics/react";

const env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
const supabaseUrl = env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || "";
const hasSupabaseKeys = Boolean(supabaseUrl && supabaseAnonKey);
const supabase = hasSupabaseKeys ? createClient(supabaseUrl, supabaseAnonKey) : null;

function createId() {
  return "bet_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(Number(value || 0));
}

// Compact currency for chart axes, e.g. $50, -$1.2k
function formatCompactCurrency(value) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  const sign = number < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

// A dollar amount expressed in betting units (1 unit = the user's chosen $
// value). e.g. "+12.5u", "-1.7u", or unsigned "8.0u" for staked totals. Returns
// "—" when no unit size is set so we never divide by zero. Bets always store
// dollars; units are purely a display lens computed at render time, so changing
// the unit size re-expresses all history without touching any saved bet.
function formatUnits(value, unitSize, signed = true) {
  if (!(Number(unitSize) > 0)) return "—";
  const u = Number(value || 0) / Number(unitSize);
  const sign = signed && u >= 0 ? "+" : "";
  return `${sign}${u.toFixed(1)}u`;
}

// Odds always show two decimals ($1.40, not $1.4). Leaves non-numeric values as-is.
function formatOdds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : String(value ?? "");
}

// Convert a player's full name to the scraper's "firstinitial_surname"
// name_key format (e.g. "Bailey J. Williams" -> "b_williams"). Matches the
// algorithm in scripts/scrape-{afl,nba}-stats.mjs so a JS-side lookup against
// afl_player_games / nba_player_games hits the index built for those tables.
function toNameKey(full) {
  const words = String(full || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  const last = words[words.length - 1];
  return `${words[0][0]}_${last}`;
}

// Given a leg's line text (e.g. "25+ disposals", "20+ points", "8+ rebounds")
// and a sport code, return the column name on the player_games table that
// holds the actual stat. Returns null if the stat can't be identified.
function statColumnForLeg(lineOrMarket, sport) {
  const s = String(lineOrMarket || "").toLowerCase();
  if ((sport || "AFL").toUpperCase() === "NBA") {
    if (s.includes("point"))    return "pts";
    if (s.includes("rebound") || s.includes("reb")) return "reb";
    if (s.includes("assist"))   return "ast";
    if (s.includes("steal"))    return "stl";
    if (s.includes("block"))    return "blk";
    if (s.includes("three") || s.includes("3pt") || s.includes("fg3")) return "fg3m";
    return null;
  }
  // AFL
  if (s.includes("disposal"))   return "disposals";
  if (s.includes("goal"))       return "goals";
  if (s.includes("mark"))       return "marks";
  if (s.includes("tackle"))     return "tackles";
  if (s.includes("kick"))       return "kicks";
  if (s.includes("handball"))   return "handballs";
  if (s.includes("hitout"))     return "hitouts";
  if (s.includes("clearance"))  return "clearances";
  if (s.includes("fantasy") || s.includes("dream"))   return "fantasy_points";
  if (s.includes("behind"))     return "behinds";
  return null;
}

// e.g. "2026-05-07" -> "7 May 2026" (for the per-leg form-freshness label)
function formatFormDate(iso) {
  const d = new Date(String(iso) + "T00:00:00");
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const point = payload[0].payload || {};
  const isBalance = payload.some((entry) => entry.dataKey === "balance");
  const primary = isBalance ? Number(point.balance || 0) : Number(point.profitLoss ?? payload[0].value ?? 0);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-[#11203B]">{label}</p>
      <p className={(primary >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]") + " mt-0.5 font-medium"}>
        {isBalance ? "Balance " : "P/L "}
        {formatCurrency(primary)}
      </p>
      {isBalance && typeof point.profitLoss === "number" ? (
        <p className="mt-0.5 text-slate-500">{point.profitLoss >= 0 ? "+" : ""}{formatCurrency(point.profitLoss)} this period</p>
      ) : null}
      {typeof point.count === "number" ? (
        <p className="mt-0.5 text-slate-500">{point.count} bet{point.count === 1 ? "" : "s"}</p>
      ) : null}
    </div>
  );
}

function parseBetDate(dateString) {
  const date = new Date(String(dateString || "") + "T00:00:00");
  return Number.isNaN(date.getTime()) ? null : date;
}

function getOrdinalSuffix(day) {
  if (day >= 11 && day <= 13) return "th";
  const lastDigit = day % 10;
  if (lastDigit === 1) return "st";
  if (lastDigit === 2) return "nd";
  if (lastDigit === 3) return "rd";
  return "th";
}

function formatDay(day) {
  return String(day) + getOrdinalSuffix(day);
}

function formatMonth(date) {
  return date.toLocaleString("en-AU", { month: "short" });
}

function getStartOfWeek(date) {
  const start = new Date(date);
  const day = start.getDay();
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  start.setHours(0, 0, 0, 0);
  return start;
}

function getWeekInfo(dateString) {
  const date = parseBetDate(dateString);
  if (!date) return { key: "no-date", label: "No date" };

  const start = getStartOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const key = start.toISOString().slice(0, 10);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const label = sameMonth
    ? formatDay(start.getDate()) + "-" + formatDay(end.getDate()) + " " + formatMonth(end)
    : formatDay(start.getDate()) + " " + formatMonth(start) + "-" + formatDay(end.getDate()) + " " + formatMonth(end);

  return { key, label };
}

function getMonthInfo(dateString) {
  const date = parseBetDate(dateString);
  if (!date) return { key: "no-date", label: "No date" };

  return {
    key: String(date.getFullYear()) + "-" + String(date.getMonth() + 1).padStart(2, "0"),
    label: date.toLocaleString("en-AU", { month: "short", year: "numeric" }),
  };
}

function getYearInfo(dateString) {
  const date = parseBetDate(dateString);
  if (!date) return { key: "no-date", label: "No date" };
  const year = String(date.getFullYear());
  return { key: year, label: year };
}

function getPeriodInfo(dateString, view) {
  if (view === "monthly") return getMonthInfo(dateString);
  if (view === "yearly") return getYearInfo(dateString);
  return getWeekInfo(dateString);
}

function calculateProfitLoss(result, stake, returnAmount) {
  const stakeNum = Number(stake || 0);
  const returnNum = Number(returnAmount || 0);
  if (result === "win") return returnNum - stakeNum;
  if (result === "loss") return -stakeNum;
  if (result === "void") return 0;
  return 0;
}

function isValidResult(result) {
  return result === "win" || result === "loss" || result === "void";
}

function databaseRowToBet(row) {
  return {
    id: row.id,
    date: row.date,
    sport: row.sport || "Other",
    stake: Number(row.stake || 0),
    odds: Number(row.odds || 0),
    result: row.result,
    returnAmount: Number(row.return_amount || 0),
    profitLoss: Number(row.profit_loss || 0),
    notes: String(row.notes || ""),
    bookmaker: String(row.bookmaker || ""),
    betType: String(row.bet_type || ""),
    source: row.source || "manual",
    status: row.status || "settled",
    legs: row.legs || null,
    createdAt: row.created_at,
  };
}

function betToDatabaseRow(bet, userId) {
  return {
    user_id: userId,
    date: bet.date,
    sport: bet.sport || "Other",
    stake: bet.stake,
    odds: bet.odds,
    result: bet.result,
    return_amount: bet.returnAmount,
    profit_loss: bet.profitLoss,
    notes: bet.notes,
    bookmaker: bet.bookmaker || null,
    bet_type: bet.betType || null,
    source: bet.source || "manual",
    status: bet.status || "settled",
    legs: bet.legs || null,
  };
}

function normaliseBet(bet) {
  const source = bet || {};
  const result = isValidResult(source.result) ? source.result : "void";
  const stake = Number(source.stake || 0);
  const returnAmount = Number(source.returnAmount || source.return_amount || 0);
  const profitLoss = Number(source.profitLoss ?? source.profit_loss ?? calculateProfitLoss(result, stake, returnAmount));

  return {
    id: source.id || createId(),
    date: source.date || todayString(),
    sport: source.sport || "Other",
    stake,
    odds: Number(source.odds || 0),
    result,
    returnAmount,
    profitLoss,
    notes: String(source.notes || ""),
    bookmaker: String(source.bookmaker || ""),
    betType: String(source.betType || source.bet_type || ""),
    source: source.source || "manual",
    status: source.status || "settled",
    legs: source.legs || null,
    createdAt: source.createdAt || source.created_at || new Date().toISOString(),
  };
}

function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function runBasicTests() {
  console.assert(calculateProfitLoss("win", 50, 100) === 50, "Win profit/loss test failed");
  console.assert(calculateProfitLoss("loss", 50, 0) === -50, "Loss profit/loss test failed");
  console.assert(calculateProfitLoss("void", 50, 50) === 0, "Void profit/loss test failed");
  console.assert(createId().startsWith("bet_"), "ID creation test failed");
  console.assert(getMonthInfo("2026-04-30").key === "2026-04", "Month key test failed");
  console.assert(getYearInfo("2026-04-30").key === "2026", "Year key test failed");
  console.assert(getPeriodInfo("2026-04-30", "monthly").label === "Apr 2026", "Period monthly label test failed");
  console.assert(getWeekInfo("2026-05-04").label === "4th-10th May", "Week range label test failed");
  console.assert(getWeekInfo("2026-04-30").label === "27th Apr-3rd May", "Cross-month week label test failed");
  console.assert(normaliseBet({ result: "win", stake: 10, returnAmount: 25 }).profitLoss === 15, "Normalise bet test failed");
  console.assert(normaliseBet({ sport: "AFL" }).sport === "AFL", "Sport normalise test failed");
  console.assert(databaseRowToBet({ id: "1", date: "2026-05-04", sport: "NRL", stake: 10, odds: 2, result: "win", return_amount: 20, profit_loss: 10 }).returnAmount === 20, "Database row mapping test failed");
  console.assert(databaseRowToBet({ id: "1", date: "2026-05-04", sport: "NRL", stake: 10, odds: 2, result: "win", return_amount: 20, profit_loss: 10 }).sport === "NRL", "Database sport mapping test failed");
  console.assert(csvCell('hello "mate"') === '"hello ""mate"""', "CSV escaping test failed");
  console.assert(["login", "signup", "reset"].includes("reset"), "Auth mode test failed");
  console.assert(typeof hasSupabaseKeys === "boolean", "Supabase key detection test failed");
}

// Per-club guernsey-style crests (stripes, sashes, chevrons, hoops) drawn as SVG
// in a 32x32 box, clipped to a circle by <TeamCrest>. Keyed by lowercase club name;
// matched longest-first so "North Melbourne"/"Greater Western Sydney" resolve before
// "Melbourne"/"Sydney".
// AFL team crests — SVG guernsey-style patterns, clipped to a circle by the
// TeamCrest component. Each design echoes the actual jumper: stripes, sashes,
// chevrons or solid panels in the team's real colours. Updated 2026-06 to
// match the bookmaker-style references the user provided.
const TEAM_CRESTS = {
  // Adelaide Crows — navy / red / gold horizontal bands
  "adelaide": (
    <>
      <rect width="32" height="32" fill="#002b5c" />
      <rect y="11" width="32" height="11" fill="#e21937" />
      <rect y="22" width="32" height="10" fill="#ffd200" />
    </>
  ),
  // Brisbane Lions — maroon top / navy middle / gold bottom thin band
  "brisbane lions": (
    <>
      <rect width="32" height="32" fill="#7a002e" />
      <rect y="11" width="32" height="11" fill="#0c2340" />
      <rect y="22" width="32" height="10" fill="#fdbb30" />
    </>
  ),
  "brisbane": (
    <>
      <rect width="32" height="32" fill="#7a002e" />
      <rect y="11" width="32" height="11" fill="#0c2340" />
      <rect y="22" width="32" height="10" fill="#fdbb30" />
    </>
  ),
  // Carlton Blues — solid navy with a subtle inner ring nod to the "C"
  "carlton": (
    <>
      <rect width="32" height="32" fill="#0e2547" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="#ffffff" strokeWidth="1.6" />
    </>
  ),
  // Collingwood Magpies — black with two white vertical stripes
  "collingwood": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <rect x="11" width="3" height="32" fill="#ffffff" />
      <rect x="18" width="3" height="32" fill="#ffffff" />
    </>
  ),
  // Essendon Bombers — black with a red diagonal sash
  "essendon": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polygon points="0,8 8,0 32,24 24,32" fill="#cc2031" />
    </>
  ),
  // Fremantle Dockers — purple with double white chevrons
  "fremantle": (
    <>
      <rect width="32" height="32" fill="#2a0d54" />
      <polyline points="5,9 16,17 27,9" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points="5,15 16,23 27,15" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  // Geelong Cats — white with three navy horizontal hoops
  "geelong": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect y="3" width="32" height="5.5" fill="#022b5c" />
      <rect y="13.25" width="32" height="5.5" fill="#022b5c" />
      <rect y="23.5" width="32" height="5.5" fill="#022b5c" />
    </>
  ),
  // Gold Coast Suns — red with a gold sun-disc emblem
  "gold coast": (
    <>
      <rect width="32" height="32" fill="#d6001c" />
      <circle cx="16" cy="16" r="6.5" fill="none" stroke="#f8d000" strokeWidth="1.8" />
      <ellipse cx="16" cy="16" rx="6.5" ry="2.4" fill="#f8d000" />
      <rect x="2.5" y="15" width="27" height="2" fill="#13357f" />
    </>
  ),
  // GWS Giants — orange with a charcoal triangle wedge + white diagonal
  "greater western sydney": (
    <>
      <rect width="32" height="32" fill="#f47920" />
      <polygon points="32,3 32,32 3,32" fill="#3b4148" />
      <line x1="32" y1="3" x2="3" y2="32" stroke="#ffffff" strokeWidth="2.5" />
    </>
  ),
  "gws": (
    <>
      <rect width="32" height="32" fill="#f47920" />
      <polygon points="32,3 32,32 3,32" fill="#3b4148" />
      <line x1="32" y1="3" x2="3" y2="32" stroke="#ffffff" strokeWidth="2.5" />
    </>
  ),
  // Hawthorn Hawks — brown base with three gold vertical stripes
  "hawthorn": (
    <>
      <rect width="32" height="32" fill="#4d2004" />
      <rect x="6" width="3.5" height="32" fill="#fbbf15" />
      <rect x="14.25" width="3.5" height="32" fill="#fbbf15" />
      <rect x="22.5" width="3.5" height="32" fill="#fbbf15" />
    </>
  ),
  // Melbourne Demons — navy with a red "Y" rising from the bottom
  "melbourne": (
    <>
      <rect width="32" height="32" fill="#0c1c3a" />
      <polygon points="0,32 32,32 16,10" fill="#d6001c" />
    </>
  ),
  // North Melbourne Kangaroos — white with four blue vertical stripes
  "north melbourne": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect x="2" width="4.5" height="32" fill="#013b9f" />
      <rect x="9.5" width="4.5" height="32" fill="#013b9f" />
      <rect x="17.5" width="4.5" height="32" fill="#013b9f" />
      <rect x="25.5" width="4.5" height="32" fill="#013b9f" />
    </>
  ),
  "kangaroos": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect x="2" width="4.5" height="32" fill="#013b9f" />
      <rect x="9.5" width="4.5" height="32" fill="#013b9f" />
      <rect x="17.5" width="4.5" height="32" fill="#013b9f" />
      <rect x="25.5" width="4.5" height="32" fill="#013b9f" />
    </>
  ),
  // Port Adelaide Power — black with white + teal chevrons (the Port "V")
  "port adelaide": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polyline points="5,9 16,17 27,9" fill="none" stroke="#ffffff" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points="5,14 16,22 27,14" fill="none" stroke="#01b6c7" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  // Richmond Tigers — black with a yellow diagonal sash
  "richmond": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polygon points="0,8 8,0 32,24 24,32" fill="#ffd200" />
    </>
  ),
  // St Kilda Saints — three vertical bands: red / white / black
  "st kilda": (
    <>
      <rect width="32" height="32" fill="#ed0f05" />
      <rect x="11" width="10" height="32" fill="#ffffff" />
      <rect x="21" width="11" height="32" fill="#000000" />
    </>
  ),
  // Sydney Swans — white with a red shield-V at the top
  "sydney": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <polygon points="0,0 32,0 32,11 16,17 0,11" fill="#ed171f" />
    </>
  ),
  // West Coast Eagles — navy left half, gold right half (split)
  "west coast": (
    <>
      <rect width="32" height="32" fill="#06214f" />
      <rect x="16" width="16" height="32" fill="#f2a900" />
    </>
  ),
  // Western Bulldogs — three horizontal bands: red / white / royal blue
  "western bulldogs": (
    <>
      <rect width="32" height="32" fill="#e1251b" />
      <rect y="11" width="32" height="10" fill="#ffffff" />
      <rect y="21" width="32" height="11" fill="#0a4595" />
    </>
  ),
  "bulldogs": (
    <>
      <rect width="32" height="32" fill="#e1251b" />
      <rect y="11" width="32" height="10" fill="#ffffff" />
      <rect y="21" width="32" height="11" fill="#0a4595" />
    </>
  ),
};

function teamKey(team) {
  if (!team) return null;
  const key = String(team).toLowerCase().trim();
  const names = Object.keys(TEAM_CRESTS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (key === name || key.includes(name)) return name;
  }
  return null;
}

function TeamCrest({ team, className = "" }) {
  const clipId = React.useId();
  const key = teamKey(team);
  // First-choice render: the team has a custom guernsey-pattern SVG.
  if (key) {
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label={team}>
        <title>{team}</title>
        <defs>
          <clipPath id={clipId}>
            <circle cx="16" cy="16" r="16" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>{TEAM_CRESTS[key]}</g>
        <circle cx="16" cy="16" r="15.2" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
      </svg>
    );
  }
  // Fallback A: team has a TEAM_TILES entry (NBA teams, alt aliases). Render
  // the primary/accent palette + 3-letter monogram inside a circle so it
  // matches the AFL crests visually instead of being a hard-edged square.
  const tile = tileFor(team);
  if (tile) {
    const labelColor = tile.primary.toUpperCase() === "#FFFFFF" ? tile.accent : "#ffffff";
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label={team}>
        <title>{team}</title>
        <defs>
          <clipPath id={clipId}>
            <circle cx="16" cy="16" r="16" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width="32" height="32" fill={tile.primary} />
          <path d="M0,20 L32,9 L32,32 L0,32 Z" fill={tile.accent} />
          <text x="16" y="21.5" textAnchor="middle" fill={labelColor} fontSize="8.5" fontWeight="700" fontFamily="Inter, sans-serif" letterSpacing="0.5">{tile.abbr}</text>
        </g>
        <circle cx="16" cy="16" r="15.2" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />
      </svg>
    );
  }
  // Fallback B: completely unknown team. Muted circle with the first 3
  // letters of whatever was passed in so the layout never has a hole.
  const fallback = String(team || "?").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "?";
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label={team}>
      <circle cx="16" cy="16" r="16" fill="#1f1f24" />
      <text x="16" y="22" textAnchor="middle" fill="#f5f5f7" fontSize="8.5" fontWeight="700" fontFamily="Inter, sans-serif" letterSpacing="0.5">{fallback}</text>
    </svg>
  );
}

// Countdown to tip-off for the dashboard game cards: "2D 17H", "23H 10M",
// "45M", or "LIVE" once it's started. Coarse on purpose (no live ticking).
function timeUntilGame(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "LIVE";
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return `${days}D ${hours}H`;
  if (hours > 0) return `${hours}H ${minutes}M`;
  return `${minutes}M`;
}

// "7:30 pm · Sat 7 Jun" tip-off label for the dashboard game cards.
function gameKickoff(iso) {
  try {
    const date = new Date(iso);
    const time = date.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase();
    const day = date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
    return `${time} · ${day}`;
  } catch {
    return "";
  }
}

// Short club label for a game card — official 3-letter tile abbr where we have
// one, else the first word of the name clipped to 4 letters.
function teamShort(name) {
  try {
    const tile = tileFor(name);
    if (tile?.abbr) return tile.abbr;
  } catch { /* fall through to derived */ }
  return String(name || "").trim().split(/\s+/)[0].slice(0, 4).toUpperCase() || "?";
}

// Plain-English one-liner for the multi output ("In plain English" band).
// Built from numbers already on the card — chance → "1-in-N", value → fair /
// above-fair / good value, risk score → lower / balanced / higher variance.
// Friendly but accurate "X in Y" for a probability percentage (0–100). Unlikely
// side stays "1 in N" (37% → 1 in 3); likely side reduces a tenths fraction
// (87% → 9 in 10, 80% → 4 in 5, 50% → 1 in 2) instead of the old clamp that
// mislabelled 87% as "1 in 2".
function chanceRatio(probPct) {
  const p = Number(probPct) / 100;
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 0.99) return "~99 in 100";
  if (p >= 0.95) return "~19 in 20";
  if (p < 0.5) return `~1 in ${Math.round(1 / p)}`;
  const num = Math.round(p * 10);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(num, 10) || 1;
  return `~${num / g} in ${10 / g}`;
}

// Plain-English read of a multi as three glanceable, colour-coded pills
// (Chance / Value / Risk). Tones: "green" good, "amber" caution, "neutral".
function plainMultiPills(multi) {
  if (!multi) return [];
  const pills = [];
  const chance = chanceRatio(multi.combinedProbPct);
  if (chance) pills.push({ label: "Chance", value: chance, tone: "neutral" });
  const ev = Number(multi.evPct);
  if (Number.isFinite(ev)) {
    let value, tone;
    if (ev >= 8) { value = "Strong value"; tone = "green"; }
    else if (ev >= 2) { value = "Good value"; tone = "green"; }
    else if (ev > -2) { value = "About fair"; tone = "neutral"; }
    else { value = "Below fair"; tone = "amber"; }
    pills.push({ label: "Value", value, tone });
  }
  const risk = Number(multi.risk);
  if (Number.isFinite(risk)) {
    pills.push({
      label: "Risk",
      value: risk <= 3 ? "Lower variance" : risk <= 6 ? "Balanced" : "Higher variance",
      tone: risk <= 3 ? "green" : risk <= 6 ? "neutral" : "amber",
    });
  }
  return pills;
}

// DEV-ONLY sample fixtures for the dashboard game scroller. `/api/odds` only
// runs on Vercel, so in `vite dev` the real fetch returns nothing — this lets
// the card be developed/reviewed locally. `import.meta.env.DEV` is false in
// production builds, so this branch is dead-code-eliminated from the bundle.
function devSampleGames(sport) {
  const hrs = (h) => new Date(Date.now() + h * 3600000).toISOString();
  if (sport === "NBA") {
    return [
      { id: "dev-nba-1", homeTeam: "Boston Celtics", awayTeam: "New York Knicks", commenceTime: hrs(20) },
      { id: "dev-nba-2", homeTeam: "Oklahoma City Thunder", awayTeam: "Denver Nuggets", commenceTime: hrs(44) },
      { id: "dev-nba-3", homeTeam: "Phoenix Suns", awayTeam: "San Antonio Spurs", commenceTime: hrs(67) },
      { id: "dev-nba-4", homeTeam: "Los Angeles Lakers", awayTeam: "Golden State Warriors", commenceTime: hrs(91) },
    ];
  }
  return [
    { id: "dev-afl-1", homeTeam: "Adelaide Crows", awayTeam: "Geelong Cats", commenceTime: hrs(23) },
    { id: "dev-afl-2", homeTeam: "Hawthorn Hawks", awayTeam: "Western Bulldogs", commenceTime: hrs(47) },
    { id: "dev-afl-3", homeTeam: "North Melbourne", awayTeam: "Fremantle", commenceTime: hrs(65) },
    { id: "dev-afl-4", homeTeam: "Carlton", awayTeam: "Collingwood", commenceTime: hrs(89) },
    { id: "dev-afl-5", homeTeam: "Sydney Swans", awayTeam: "Brisbane Lions", commenceTime: hrs(113) },
  ];
}

// Square guernsey-style tile used on the MultiPick legs (preview B style).
// Each team gets primary colour + diagonal accent + 3-letter monogram.
const TEAM_TILES = {
  // AFL
  "adelaide": { primary: "#002b5c", accent: "#e21937", abbr: "ADL" },
  "brisbane": { primary: "#A6192E", accent: "#FCB514", abbr: "BRI" },
  "carlton": { primary: "#0D2240", accent: "#FFFFFF", abbr: "CAR" },
  "collingwood": { primary: "#000000", accent: "#FFFFFF", abbr: "COL" },
  "essendon": { primary: "#CC2031", accent: "#000000", abbr: "ESS" },
  "fremantle": { primary: "#2A1A5E", accent: "#FFFFFF", abbr: "FRE" },
  "geelong": { primary: "#003B7E", accent: "#FFFFFF", abbr: "GEE" },
  "gold coast": { primary: "#CC2128", accent: "#F2C100", abbr: "GCS" },
  "gws": { primary: "#37474F", accent: "#F57F17", abbr: "GWS" },
  "hawthorn": { primary: "#4A2410", accent: "#FBBF24", abbr: "HAW" },
  "melbourne": { primary: "#0a2342", accent: "#C8102E", abbr: "MEL" },
  "north melbourne": { primary: "#013088", accent: "#FFFFFF", abbr: "NTH" },
  "port adelaide": { primary: "#00A6A1", accent: "#000000", abbr: "POR" },
  "richmond": { primary: "#1a1a1a", accent: "#FFD500", abbr: "RIC" },
  "st kilda": { primary: "#000000", accent: "#ED1C24", abbr: "STK" },
  "sydney": { primary: "#ED1C24", accent: "#FFFFFF", abbr: "SYD" },
  "west coast": { primary: "#003087", accent: "#F2A900", abbr: "WCE" },
  "western bulldogs": { primary: "#014182", accent: "#E03A3E", abbr: "WBD" },
  // NBA
  "thunder": { primary: "#007AC1", accent: "#EF6C00", abbr: "OKC" },
  "oklahoma city": { primary: "#007AC1", accent: "#EF6C00", abbr: "OKC" },
  "spurs": { primary: "#1a1a1a", accent: "#C4CED4", abbr: "SAS" },
  "san antonio": { primary: "#1a1a1a", accent: "#C4CED4", abbr: "SAS" },
  "lakers": { primary: "#552583", accent: "#FDB927", abbr: "LAL" },
  "celtics": { primary: "#007A33", accent: "#FFFFFF", abbr: "BOS" },
  "warriors": { primary: "#1D428A", accent: "#FFC72C", abbr: "GSW" },
  "heat": { primary: "#98002E", accent: "#F9A01B", abbr: "MIA" },
  "knicks": { primary: "#006BB6", accent: "#F58426", abbr: "NYK" },
  "pistons": { primary: "#C8102E", accent: "#1d428a", abbr: "DET" },
};

function tileFor(team) {
  if (!team) return null;
  const key = String(team).toLowerCase().trim();
  const names = Object.keys(TEAM_TILES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (key === name || key.includes(name)) return TEAM_TILES[name];
  }
  return null;
}

function TeamTile({ team, className = "" }) {
  const t = tileFor(team);
  if (!t) {
    // Fallback: muted tile with first 3 chars of the team name in white
    const fallback = String(team || "?").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "?";
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label={team}>
        <rect width="32" height="32" rx="6" fill="#1f1f24" />
        <text x="16" y="22" textAnchor="middle" fill="#f5f5f7" fontSize="9" fontWeight="700" fontFamily="Inter, sans-serif" letterSpacing="0.5">{fallback}</text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label={team}>
      <rect width="32" height="32" rx="6" fill={t.primary} />
      <path d="M0,20 L32,9 L32,32 L0,32 Z" fill={t.accent} />
      <text x="16" y="22" textAnchor="middle" fill={t.primary === "#FFFFFF" || t.primary.toUpperCase() === "#FFFFFF" ? t.accent : "#ffffff"} fontSize="9" fontWeight="700" fontFamily="Inter, sans-serif" letterSpacing="0.5">{t.abbr}</text>
    </svg>
  );
}

function Card({ children, className = "" }) {
  // 2026 refresh: dark surface, hairline border, no glow. Replaces the old
  // cream cards. Old version preserved in App.legacy.jsx if we ever revert.
  return <div className={"rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] " + className}>{children}</div>;
}

function BankrollCurveCard({ data }) {
  const positive = "#2E7D5B";
  const negative = "#A94442";
  const balances = data.map((point) => point.balance);
  const current = balances.length ? balances[balances.length - 1] : 0;
  const peak = balances.length ? Math.max(0, ...balances) : 0;
  const drawdown = current - peak;
  const lineColor = current >= 0 ? positive : negative;

  return (
    <Card>
      <div className="p-5 md:p-6">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
          <div>
            <h2 className="text-lg font-semibold md:text-xl">Cumulative profit</h2>
            <p className="text-sm text-slate-500">Your running total over time — the trajectory at a glance.</p>
          </div>
          <div className="flex gap-5 text-right">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Now</p>
              <p className={"text-lg font-bold " + (current >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(current)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">Peak</p>
              <p className="text-lg font-bold text-[#11203B]">{formatCurrency(peak)}</p>
            </div>
          </div>
        </div>
        {data.length ? (
          <div className="mt-4 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
                <defs>
                  <linearGradient id="bankrollGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.55} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0.06} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={formatCompactCurrency} />
                <Tooltip content={<ChartTooltip />} />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Area type="monotone" dataKey="balance" stroke={lineColor} fill="url(#bankrollGradient)" strokeWidth={3} />
                <Line type="monotone" dataKey="peak" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="mt-6 text-sm text-slate-500">Add some bets to see your balance trend.</p>
        )}
        {data.length && drawdown < 0 ? (
          <p className="mt-3 text-xs text-slate-500">Currently {formatCurrency(Math.abs(drawdown))} below your peak.</p>
        ) : null}
      </div>
    </Card>
  );
}

function BreakdownRow({ row }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 py-2 text-sm first:border-t-0">
      <span className="font-medium text-[#11203B]">{row.key}</span>
      <div className="flex items-center gap-4">
        <span className="hidden w-14 text-right text-xs text-slate-500 sm:inline">{row.completed ? `${Math.round(row.winRate)}% win` : "—"}</span>
        <span className="w-12 text-right text-xs text-slate-500">{row.roi != null ? `${row.roi >= 0 ? "+" : ""}${row.roi.toFixed(0)}%` : "—"}</span>
        <span className={"w-20 text-right font-semibold " + (row.profit >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(row.profit)}</span>
      </div>
    </div>
  );
}

function BreakdownsCard({ bySport, byOdds, byType }) {
  return (
    <Card>
      <div className="p-5 md:p-6">
        <h2 className="text-lg font-semibold md:text-xl">Where your money goes</h2>
        <p className="text-sm text-slate-500">Profit, ROI and win rate across all your bets.</p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By sport</p>
            {bySport.length ? bySport.map((row) => <BreakdownRow key={row.key} row={row} />) : <p className="text-sm text-slate-500">No bets yet.</p>}
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By odds range</p>
            {byOdds.length ? byOdds.map((row) => <BreakdownRow key={row.key} row={row} />) : <p className="text-sm text-slate-500">No bets yet.</p>}
          </div>
        </div>
        {byType && byType.length ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By bet type</p>
            <div className="md:grid md:grid-cols-2 md:gap-x-6">
              {byType.map((row) => <BreakdownRow key={row.key} row={row} />)}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function PendingBetsCard({ bets, onSettle, onDelete, onEdit }) {
  return (
    <Card>
      <div className="p-5 md:p-6">
        <h2 className="text-lg font-semibold md:text-xl">Pending bets</h2>
        <p className="text-sm text-slate-500">Saved but not settled yet — mark them once the games finish.</p>
        <div className="mt-4 space-y-3">
          {bets.map((bet) => (
            <div key={bet.id} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-[#11203B]">{bet.betType || "Bet"} · {bet.sport || "Other"} @ ${formatOdds(bet.odds)}</p>
                  <p className="text-xs text-slate-500">{bet.date} · {formatCurrency(bet.stake)} stake{bet.source === "grid_build" ? " · from MultiPick" : ""}</p>
                </div>
                <p className="text-sm font-medium text-[#11203B]">Returns {formatCurrency(Number(bet.stake || 0) * Number(bet.odds || 0))}</p>
              </div>
              {Array.isArray(bet.legs) && bet.legs.length ? (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {bet.legs.map((leg, index) => <li key={index}>• {leg.name || leg.player}{leg.odds ? ` @ $${formatOdds(leg.odds)}` : ""}</li>)}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => onSettle(bet.id, "win")} className="bg-[#2E7D5B] hover:bg-[#27684c]">Won</Button>
                <Button onClick={() => onSettle(bet.id, "loss")} className="bg-[#A94442] hover:bg-[#8f3a38]">Lost</Button>
                {onEdit ? <Button variant="outline" onClick={() => onEdit(bet)}>Edit</Button> : null}
                <Button variant="ghost" onClick={() => onDelete(bet.id)}>Delete</Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function GridBuildScoreCard({ stats }) {
  return (
    <Card>
      <div className="p-5 md:p-6">
        <h2 className="text-lg font-semibold md:text-xl">MultiPick performance</h2>
        <p className="text-sm text-slate-500">How the multis you saved from MultiPick have actually gone.</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Saved</p><p className="mt-1 text-xl font-bold text-[#11203B]">{stats.count}</p></div>
          <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Won</p><p className="mt-1 text-xl font-bold text-[#11203B]">{stats.wins}/{stats.completed}</p></div>
          <div className={"rounded-2xl p-4 " + (stats.profit >= 0 ? "bg-[#DDEFE5]" : "bg-[#F3DDD7]")}><p className="text-xs uppercase tracking-wide text-slate-500">Profit</p><p className={"mt-1 text-xl font-bold " + (stats.profit >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(stats.profit)}</p></div>
          <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-xs uppercase tracking-wide text-slate-500">ROI</p><p className="mt-1 text-xl font-bold text-[#11203B]">{stats.roi != null ? stats.roi.toFixed(0) + "%" : "—"}</p></div>
        </div>
      </div>
    </Card>
  );
}

function Button({ children, className = "", variant = "primary", ...props }) {
  // 2026 refresh: primary = lime-accent CTA, outline = ghost-bordered, ghost = bare.
  const base = "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "outline"
      ? "border border-[var(--border-new)] bg-[var(--surface-new)] text-[var(--text-new)] hover:border-[var(--border-strong-new)]"
      : variant === "ghost"
      ? "bg-transparent text-[var(--text-2-new)] hover:text-[var(--text-new)] hover:bg-[var(--surface-2-new)]"
      : "bg-[var(--accent-new)] text-[var(--bg-new)] font-semibold hover:opacity-90";

  return (
    <button className={base + " " + styles + " " + className} {...props}>
      {children}
    </button>
  );
}

function Input({ className = "", ...props }) {
  return (
    <input
      className={
        "w-full rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-3.5 py-2.5 text-sm text-[var(--text-new)] outline-none transition-colors placeholder:text-[var(--text-3-new)] focus:border-[var(--border-strong-new)] disabled:opacity-50 " +
        className
      }
      {...props}
    />
  );
}

function StatCard({ title, value, helper }) {
  return (
    <Card>
      <div className="p-5">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-3-new)]">{title}</p>
        <p className="mt-1.5 mono-nums text-2xl font-semibold tracking-tight text-[var(--text-new)]">{value}</p>
        {helper ? <p className="mt-1 text-xs text-[var(--text-3-new)]">{helper}</p> : null}
      </div>
    </Card>
  );
}

function ColoredStatCard({ title, value, helper, tone = "neutral" }) {
  // 2026 refresh: P/L tones reuse the new positive/danger tokens with a soft
  // background. Subtle, not blocky.
  const containerClass =
    tone === "green"
      ? "rounded-2xl border border-transparent bg-[var(--positive-soft-new)]"
      : tone === "red"
      ? "rounded-2xl border border-transparent bg-[var(--danger-soft-new)]"
      : "rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)]";

  const labelClass =
    tone === "green"
      ? "text-[var(--positive-new)]"
      : tone === "red"
      ? "text-[var(--danger-new)]"
      : "text-[var(--text-3-new)]";

  const valueClass =
    tone === "green"
      ? "text-[var(--positive-new)]"
      : tone === "red"
      ? "text-[var(--danger-new)]"
      : "text-[var(--text-new)]";

  return (
    <div className={containerClass}>
      <div className="p-5">
        <p className={`text-[11px] font-medium uppercase tracking-[0.06em] ${labelClass}`}>{title}</p>
        <p className={`mt-1.5 mono-nums text-2xl font-semibold tracking-tight ${valueClass}`}>{value}</p>
        {helper ? <p className={`mt-1 text-xs ${labelClass}`} style={{ opacity: 0.75 }}>{helper}</p> : null}
      </div>
    </div>
  );
}

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, firstName, setFirstName, loading, message, onSubmit, onResetPassword }) {
  return (
    <div className="min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Online version</p>
            <h1 className="brand-wordmark mt-1 flex items-baseline text-3xl font-bold tracking-[-0.045em]"><span>Pickd</span><span className="text-[var(--accent-new)]">.</span></h1>
            <p className="mt-2 text-sm text-slate-600">Create an account or log in to save your bets online and access them from any device.</p>
            {authMode === "reset" ? <p className="mt-2 text-sm text-slate-600">Enter your email and we will send you a password reset link.</p> : null}

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              {authMode === "signup" ? (
                <label className="space-y-1 text-sm font-medium">
                  First name
                  <Input type="text" value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="What should we call you?" autoComplete="given-name" />
                </label>
              ) : null}

              <label className="space-y-1 text-sm font-medium">
                Email
                <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
              </label>

              {authMode !== "reset" ? (
                <label className="space-y-1 text-sm font-medium">
                  Password
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimum 6 characters" required />
                </label>
              ) : null}

              {message ? <div className="rounded-xl bg-[#E8E2D4] p-3 text-sm text-slate-700">{message}</div> : null}

              <Button type="submit" className="mt-3 w-full" disabled={loading}>
                {loading ? "Please wait..." : authMode === "login" ? "Log in" : authMode === "signup" ? "Sign up" : "Send reset link"}
              </Button>
            </form>

            {authMode === "login" ? <button type="button" onClick={onResetPassword} className="mt-3 w-full text-center text-sm font-medium text-[#11203B] underline">Forgot password?</button> : null}

            <div className="mt-4 text-center text-sm text-slate-600">
              {authMode === "login" ? "Need an account? " : authMode === "signup" ? "Already have an account? " : "Remembered your password? "}
              <button type="button" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")} className="font-medium text-[#11203B] underline">
                {authMode === "login" ? "Sign up" : "Log in"}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PasswordRecoveryScreen({ newPassword, setNewPassword, loading, message, onSubmit }) {
  return (
    <div className="min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Password reset</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Set a new password</h1>
            <p className="mt-2 text-sm text-slate-600">Enter a new password for your Pickd account.</p>
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="space-y-1 text-sm font-medium">
                New password
                <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Minimum 6 characters" required />
              </label>
              {message ? <div className="rounded-xl bg-[#E8E2D4] p-3 text-sm text-slate-700">{message}</div> : null}
              <Button type="submit" className="mt-3 w-full" disabled={loading}>{loading ? "Updating..." : "Update password"}</Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Shared top nav — Layout B editorial style. Appears on Dashboard, Tracker,
// MultiPick, and Settings pages on desktop. Mobile uses MobileBottomNav.
function TopNav({ activePage, setActivePage, handleLogout }) {
  const tabClass = (key) =>
    "text-[12px] font-medium uppercase tracking-[0.06em] transition-colors " +
    (activePage === key ? "text-[var(--text-new)]" : "text-[var(--text-3-new)] hover:text-[var(--text-2-new)]");
  return (
    <nav className="mb-2 flex flex-col gap-3 border-b border-[var(--border-new)] pb-4 md:flex-row md:items-center md:justify-between md:pb-5">
      {/* Brand wordmark — "Pickd." with a lime accent dot. The period reads
          as a confirmed pick / decision made; uses Inter Tight at tight
          letter-spacing for a confident, editorial wordmark. */}
      <button
        type="button"
        onClick={() => setActivePage && setActivePage("app")}
        className="brand-wordmark flex items-baseline leading-none"
        aria-label="Pickd home"
      >
        <span className="text-[22px] font-bold tracking-[-0.045em] text-[var(--text-new)]">Pickd</span>
        <span className="text-[22px] font-bold tracking-[-0.045em] text-[var(--accent-new)]">.</span>
      </button>
      <div className="-mx-2 flex items-center gap-4 overflow-x-auto px-2 md:gap-6 md:overflow-visible">
        <button onClick={() => setActivePage("app")} className={tabClass("app") + " whitespace-nowrap"}>Dashboard</button>
        <button onClick={() => setActivePage("tracker")} className={tabClass("tracker") + " whitespace-nowrap"}>Tracker</button>
        <button onClick={() => setActivePage("edge")} className={tabClass("edge") + " inline-flex items-center gap-1.5 whitespace-nowrap"}>
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-new)]" style={{ boxShadow: "0 0 8px var(--accent-new)" }} />MultiPick
        </button>
        <button onClick={() => setActivePage("settings")} className={tabClass("settings") + " whitespace-nowrap"}>Settings</button>
        {handleLogout ? (
          <button onClick={handleLogout} className="whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--text-2-new)]">Log out</button>
        ) : null}
      </div>
    </nav>
  );
}

function Footer({ setActivePage }) {
  return (
    <footer className="border-t border-slate-200 py-6 text-sm text-slate-500">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 md:flex-row md:items-center md:justify-between md:px-8">
        <p>© {new Date().getFullYear()} Pickd. Informational use only.</p>
        <div className="flex flex-wrap gap-4">
          <a href="mailto:aidenchannell0@gmail.com?subject=Bet%20Grid%20Feedback&body=What%20did%20you%20think%20of%20Bet%20Grid%3F%0A%0AWhat%20was%20confusing%3F%0A%0AWhat%20feature%20should%20come%20next%3F%0A%0AWould%20you%20use%20Grid%20Build%20with%20live%20sports%20data%3F" className="font-medium text-[#11203B] hover:underline">Give feedback</a>
          <button onClick={() => setActivePage("disclaimer")} className="hover:text-[#11203B]">Disclaimer</button>
          <button onClick={() => setActivePage("responsible")} className="hover:text-[#11203B]">Responsible Gambling</button>
          <button onClick={() => setActivePage("privacy")} className="hover:text-[#11203B]">Privacy</button>
          <button onClick={() => setActivePage("terms")} className="hover:text-[#11203B]">Terms</button>
        </div>
      </div>
    </footer>
  );
}

function SettingsPage({ setActivePage, bets, exportCsv, exportBackup, clearAllBets, fileInputRef, importBackup, darkMode, setDarkMode, onReplayTour, unitSize, setUnitSize, showUnits, setShowUnits }) {
  return (
    <div className="page-fade-in min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopNav activePage="settings" setActivePage={setActivePage} />
        </div>
        {/* Mobile-friendly settings — larger tap targets (py-3 minimum),
            generous section padding, hairline dividers between sections
            instead of stacked card-in-card. Editorial header matches the
            rest of the site. */}
        <div className="mx-auto max-w-3xl">
          <div className="border-b border-[var(--border-new)] pb-7 md:pb-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">PICKD · Account</p>
            <h1 className="mt-3.5 text-[36px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[44px]">Settings.</h1>
            <p className="mt-3 max-w-[480px] text-[14px] leading-relaxed text-[var(--text-2-new)]">Manage exports, backups and account-level bet data actions.</p>
          </div>

          <div className="divide-y divide-[var(--border-new)]">
            {/* Appearance */}
            <section className="py-7 md:py-9">
              <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">01 — Appearance</p>
              <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Display mode</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">Pickd defaults to dark. Switch to light if you prefer warmer surfaces.</p>
              <div className="mt-5 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setDarkMode(false)}
                  className={"rounded-xl px-4 py-3 text-[14px] font-medium transition active:opacity-80 " + (!darkMode ? "bg-[var(--text-new)] text-[var(--bg-new)]" : "border border-[var(--border-new)] bg-[var(--surface-new)] text-[var(--text-2-new)]")}
                >
                  Light
                </button>
                <button
                  type="button"
                  onClick={() => setDarkMode(true)}
                  className={"rounded-xl px-4 py-3 text-[14px] font-medium transition active:opacity-80 " + (darkMode ? "bg-[var(--text-new)] text-[var(--bg-new)]" : "border border-[var(--border-new)] bg-[var(--surface-new)] text-[var(--text-2-new)]")}
                >
                  Dark
                </button>
              </div>
            </section>

            {/* Units */}
            <section className="py-7 md:py-9">
              <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">02 — Units</p>
              <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Track in units</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">Show profit/loss and staked totals as betting units instead of dollars. Your bets are still stored in dollars — this only changes how results are displayed, so you can change the unit size anytime without affecting your history.</p>
              <div className="mt-5 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowUnits(false)}
                  className={"rounded-xl px-4 py-3 text-[14px] font-medium transition active:opacity-80 " + (!showUnits ? "bg-[var(--text-new)] text-[var(--bg-new)]" : "border border-[var(--border-new)] bg-[var(--surface-new)] text-[var(--text-2-new)]")}
                >
                  Dollars
                </button>
                <button
                  type="button"
                  onClick={() => setShowUnits(true)}
                  className={"rounded-xl px-4 py-3 text-[14px] font-medium transition active:opacity-80 " + (showUnits ? "bg-[var(--text-new)] text-[var(--bg-new)]" : "border border-[var(--border-new)] bg-[var(--surface-new)] text-[var(--text-2-new)]")}
                >
                  Units
                </button>
              </div>
              <div className="mt-3.5 flex items-center justify-between gap-4 rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)] px-4 py-3">
                <span className="text-[13px] text-[var(--text-2-new)] md:text-[14px]">1 unit equals</span>
                <span className="inline-flex items-center gap-0.5">
                  <span className="text-[14px] text-[var(--text-3-new)]">$</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="decimal"
                    value={unitSize}
                    onChange={(e) => setUnitSize(Math.max(0, Number(e.target.value) || 0))}
                    className="mono-nums w-20 bg-transparent text-right text-[15px] font-semibold text-[var(--text-new)] outline-none"
                    aria-label="Dollar value of one unit"
                  />
                </span>
              </div>
            </section>

            {/* Export */}
            <section className="py-7 md:py-9">
              <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">03 — Export</p>
              <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Download your data</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">CSV for spreadsheets, JSON for personal backups. Your bet history is portable — never locked in.</p>
              <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
                <Button onClick={exportCsv} variant="outline" disabled={!bets.length} className="w-full py-3 sm:w-auto sm:flex-1">Export CSV</Button>
                <Button onClick={exportBackup} variant="outline" disabled={!bets.length} className="w-full py-3 sm:w-auto sm:flex-1">Export JSON backup</Button>
              </div>
            </section>

            {/* Import */}
            <section className="py-7 md:py-9">
              <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">04 — Import</p>
              <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Restore a backup</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">Import a Pickd JSON backup. Imported bets get added to your online account.</p>
              <div className="mt-5">
                <Button onClick={() => fileInputRef.current && fileInputRef.current.click()} variant="outline" className="w-full py-3 sm:w-auto">Choose backup file</Button>
                <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importBackup} className="hidden" />
              </div>
            </section>

            {/* Help & tour */}
            {onReplayTour ? (
              <section className="border-b border-[var(--border-new)] py-7 md:py-9">
                <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">05 — Help</p>
                <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Replay the tour</h2>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">Walk through the main features again — MultiPick, the tracker, and how the model track record works.</p>
                <div className="mt-5">
                  <Button onClick={onReplayTour} variant="outline" className="w-full py-3 sm:w-auto">Replay tutorial</Button>
                </div>
              </section>
            ) : null}

            {/* Danger zone */}
            <section className="py-7 md:py-9">
              <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--danger-new)]">06 — Danger zone</p>
              <h2 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[22px]">Delete all bets</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)] md:text-[14px]">Removes every bet entry from this account. Your account itself stays — but the bet history is gone for good. Export a backup first if you want a copy.</p>
              <div className="mt-5">
                <Button onClick={clearAllBets} variant="outline" disabled={!bets.length} className="w-full border-[var(--danger-new)] py-3 text-[var(--danger-new)] hover:bg-[var(--danger-soft-new)] sm:w-auto">Delete all bets</Button>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
      <MobileBottomNav activePage="settings" setActivePage={setActivePage} />
    </div>
  );
}

function EdgeRiskMeter({ score }) {
  // 2026 refresh: gradient bar (positive → warning → danger) with mono numerals.
  const riskWidth = Math.max(10, Math.min(100, score * 10)) + "%";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium text-[var(--text-2-new)]">Overall risk score</span>
        <span className="mono-nums font-semibold text-[var(--text-new)]">{score}<span className="text-[var(--text-3-new)] font-normal">/10</span></span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-new)]">
        <div className="h-full rounded-full risk-gradient-fill" style={{ width: riskWidth }} />
      </div>
    </div>
  );
}

function EdgeSelectField({ label, value, options, onChange }) {
  return (
    <label className="space-y-1.5 text-sm font-medium text-[var(--text-2-new)]">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--text-3-new)]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-3.5 py-2.5 text-sm text-[var(--text-new)] outline-none transition-colors focus:border-[var(--border-strong-new)]">
        {options.map((option) => {
          const optionValue = typeof option === "object" ? option.value : option;
          const optionLabel = typeof option === "object" ? option.label : option;
          return <option key={optionValue} value={optionValue}>{optionLabel}</option>;
        })}
      </select>
    </label>
  );
}

// One leg in the MultiPick output. Compact by default (number, crest, player,
// avg + cleared, confidence, odds); tap the row to expand the full form — the
// per-game dot pattern, freshness, matchup, details grid, recent trend and the
// "why included" note. Replaces the always-expanded row + EdgeDetailToggle.
function EdgeLegRow({ leg, index, sportContext }) {
  const [expanded, setExpanded] = useState(false);

  const matchupPct = leg.matchupFactor && leg.matchupFactor !== 1 ? Math.round((leg.matchupFactor - 1) * 100) : null;
  const ageDays = leg.formAsOf ? Math.floor((Date.now() - new Date(leg.formAsOf + "T00:00:00").getTime()) / 86400000) : null;
  const isAFLContext = !sportContext || /afl/i.test(String(sportContext));
  const freshness = (() => {
    if (ageDays == null) return null;
    const tone = ageDays <= 3 ? "fresh" : ageDays <= 14 ? "ageing" : "stale";
    if (isAFLContext) {
      const roundsAgo = Math.floor(ageDays / 7);
      const label = roundsAgo === 0 ? "Form this round" : roundsAgo === 1 ? "Form last round" : `Form ${roundsAgo} rounds ago`;
      return { label, tone };
    }
    return { label: ageDays <= 3 ? `Form ${ageDays}d fresh` : `Form ${ageDays}d old`, tone };
  })();

  // hit count / total — from per-game values when present, else parsed from reason
  let hitN = 0, totalN = 10;
  if (typeof leg.reason === "string") {
    const m = leg.reason.match(/(\d+)\s*[/]\s*(\d+)/);
    if (m) { hitN = parseInt(m[1], 10); totalN = parseInt(m[2], 10); }
  }
  let avgN = null;
  if (typeof leg.reason === "string") {
    const am = leg.reason.match(/averaging\s+([0-9.]+)/i);
    if (am) avgN = parseFloat(am[1]);
  }
  // Split the player from the line ("Blake Hardwick" + "12+ disposals") so the
  // line gets its own row and is never truncated away on mobile. leg.name is
  // "<player> <line>"; prefer the explicit leg.player, else the legacy em-dash.
  let playerName = leg.player || leg.name || "";
  let lineText = "";
  if (leg.player && typeof leg.name === "string" && leg.name.toLowerCase().startsWith(leg.player.toLowerCase())) {
    lineText = leg.name.slice(leg.player.length).trim();
  } else if (typeof leg.name === "string" && leg.name.indexOf("—") >= 0) {
    const dashIdx = leg.name.indexOf("—");
    lineText = leg.name.slice(dashIdx + 1).trim();
    playerName = leg.name.slice(0, dashIdx).trim();
  }
  const lineNum = (() => {
    if (typeof leg.line === "number") return leg.line;
    const n = parseFloat(String(leg.line || lineText || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  })();
  let hitPattern = null;
  if (Array.isArray(leg.last10Values) && leg.last10Values.length > 0 && lineNum != null) {
    hitPattern = [...leg.last10Values].reverse().map((v) => Number(v) >= lineNum);
    totalN = hitPattern.length;
    hitN = hitPattern.filter(Boolean).length;
  }

  const toneColor = (t) => t === "fresh" ? "var(--positive-new)" : t === "ageing" ? "var(--warning-new)" : "var(--danger-new)";
  // Cushion = how comfortably the player clears the line on recent form (margin
  // + consistency). Green when there's room, amber/red when he hugs the line.
  const cushionColor = (g) =>
    g === "Comfortable" ? "var(--positive-new)"
    : g === "Solid" ? "var(--positive-new)"
    : g === "Slim" ? "var(--warning-new)"
    : "var(--danger-new)";

  // Guard the crest to the game's actual teams: if a leg's team tag isn't one of
  // the two clubs in this game (a bad stats-name match), show a neutral crest
  // rather than a wrong club (e.g. a Sydney crest in a North v Freo multi).
  const crestTeam = (() => {
    const legKey = teamKey(leg.team);
    if (!legKey) return leg.team; // unresolved → TeamCrest falls back to a monogram
    const gameTeams = String(leg.game || "").split(/\bvs\b/i);
    if (gameTeams.length === 2 && !gameTeams.some((t) => teamKey(t) === legKey)) return null;
    return leg.team;
  })();

  return (
    <div className="reveal-part" style={{ animationDelay: `${0.12 + index * 0.08}s` }}>
      {/* COMPACT ROW — whole row taps to expand */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="group grid w-full grid-cols-[22px_36px_1fr_auto] items-center gap-x-4 rounded-lg py-4 text-left transition-colors hover:bg-[var(--surface-new)]/40 active:bg-[var(--surface-new)] md:grid-cols-[22px_40px_1fr_84px_auto]"
      >
        <div className="mono-nums text-[12px] text-[var(--text-3-new)] tracking-[0.05em]">{String(index + 1).padStart(2, "0")}</div>
        <TeamCrest team={crestTeam} className="h-9 w-9 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-[14px] md:text-[15px] font-medium tracking-[-0.01em] text-[var(--text-new)]">
            {playerName}
            {leg.position ? (
              <span className="ml-2 inline-flex items-center rounded bg-[var(--surface-new)] px-1.5 py-0.5 align-middle text-[9px] font-semibold tracking-[0.08em] text-[var(--text-3-new)]">{leg.position}</span>
            ) : null}
          </div>
          {lineText ? (
            <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--accent-new)]"><span className="mono-nums">{lineText}</span></div>
          ) : null}
          <div className="mt-0.5 truncate text-[11px] text-[var(--text-3-new)]">
            {avgN != null ? <>Avg <span className="mono-nums text-[var(--text-2-new)]">{avgN}</span></> : null}
            {totalN > 0 ? <>{avgN != null ? " · " : ""}<span className="mono-nums text-[var(--text-2-new)]">{hitN}/{totalN}</span> cleared</> : null}
          </div>
        </div>
        {/* confidence — desktop column */}
        <div className="hidden text-center md:block">
          <div className="mono-nums text-[20px] font-semibold leading-none text-[var(--text-new)]">{leg.confidence}</div>
          <div className="mt-1 text-[9px] uppercase tracking-[0.08em] text-[var(--text-3-new)]">conf</div>
        </div>
        {/* odds + chevron */}
        <div className="flex items-center justify-end gap-3 text-right">
          <div>
            <div className="mono-nums text-[18px] md:text-[20px] font-semibold leading-none text-[var(--text-new)]">${leg.odds ? formatOdds(leg.odds) : "—"}</div>
            <div className="mt-1 flex items-center justify-end gap-2">
              <span className="md:hidden mono-nums text-[11px] font-medium text-[var(--text-2-new)]">{leg.confidence}</span>
              {typeof leg.edgePct === "number" && leg.edgePct > 0 ? (
                <span className="mono-nums rounded bg-[var(--positive-soft-new)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--positive-new)]">+{leg.edgePct}%</span>
              ) : null}
            </div>
          </div>
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--border-new)] text-[var(--text-2-new)] transition-all group-hover:border-[var(--border-strong-new)] group-hover:text-[var(--text-new)]"
            style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M2.5 4.5 L6 8 L9.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </button>

      {/* EXPANDED FORM — everything else */}
      {expanded ? (
        <div className="leg-expand pb-6 md:pl-[62px]">
          {/* per-game dot pattern + cleared */}
          {totalN > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1" title="Last 10 games · rightmost = most recent">
                {Array.from({ length: totalN }).map((_, dIdx) => {
                  const filled = hitPattern ? hitPattern[dIdx] === true : dIdx < hitN;
                  const isLatest = dIdx === totalN - 1;
                  return (
                    <div
                      key={dIdx}
                      title={isLatest ? "Most recent game" : `${totalN - dIdx} games ago`}
                      className={
                        (isLatest ? "h-2 w-2 ring-1 ring-offset-1 ring-offset-[var(--bg-new)] " : "h-1.5 w-1.5 ") +
                        "rounded-full " +
                        (filled ? "bg-[var(--positive-new)]" : "border border-[var(--text-3-new)]/40 bg-transparent") +
                        (isLatest ? " ring-[var(--accent-new)]" : "")
                      }
                      style={isLatest ? { boxShadow: filled ? "0 0 6px rgba(74, 222, 128, 0.55)" : "0 0 6px rgba(212, 242, 58, 0.45)" } : undefined}
                    />
                  );
                })}
              </div>
              <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]"><span className="mono-nums">{hitN} / {totalN}</span> cleared</div>
            </div>
          ) : null}

          {/* freshness + matchup line */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {freshness ? (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: toneColor(freshness.tone) }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: toneColor(freshness.tone) }} />
                {freshness.label}
              </span>
            ) : null}
            {matchupPct !== null && leg.opponent ? (
              <span className="text-[12px] text-[var(--text-2-new)]">
                Matchup <span className={matchupPct >= 0 ? "font-medium text-[var(--positive-new)]" : "font-medium text-[var(--danger-new)]"}><span className="mono-nums">{matchupPct >= 0 ? "+" : ""}{matchupPct}%</span></span> vs {leg.opponent}
              </span>
            ) : null}
            {leg.cushionGrade ? (
              <span
                className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]"
                style={{ color: cushionColor(leg.cushionGrade) }}
                title={`How comfortably he clears the line on recent form${leg.cushionZ != null ? ` (${leg.cushionZ}σ above the line)` : ""}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: cushionColor(leg.cushionGrade) }} />
                Cushion · {leg.cushionGrade}
              </span>
            ) : null}
          </div>

          {/* details grid */}
          {Array.isArray(leg.details) && leg.details.length ? (
            <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3">
              {leg.details.map((item) => (
                <div key={item.label} className="rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] p-3">
                  <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-3-new)]">{item.label}</p>
                  <p className="mt-1 text-[13px] font-semibold text-[var(--text-new)]">{item.value}</p>
                </div>
              ))}
            </div>
          ) : null}

          {/* recent trend — last 5 boxed values */}
          {Array.isArray(leg.last5Values) && leg.last5Values.length ? (
            <div className="mt-4">
              <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-3-new)]">Recent scores · oldest → latest</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {[...leg.last5Values].reverse().map((value, i, arr) => {
                  const isLatest = i === arr.length - 1;
                  return (
                    <span
                      key={i}
                      className={"mono-nums inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[13px] font-semibold " + (isLatest ? "bg-[var(--accent-new)] text-[var(--bg-new)]" : "bg-[var(--surface-new)] text-[var(--text-new)]")}
                    >
                      {value}
                    </span>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* why included */}
          {leg.extraReason ? (
            <div className="mt-4">
              <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-3-new)]">Why MultiPick included it</p>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-2-new)]">{leg.extraReason}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── New-user onboarding tour ──────────────────────────────────────────────
// 5-step modal shown once to new users (gated on localStorage). Each step
// previews a real feature with a mini brand-styled mockup; the first step
// captures a first name so the app can greet the user. onFinish persists the
// name + flag and drops the user on MultiPick. onSkip just flags it seen.
function TourMock({ kind }) {
  if (kind === "welcome") {
    return (
      <div className="text-center">
        <div className="brand-wordmark text-[54px]">Pickd<span className="text-[var(--accent-new)]">.</span></div>
        <div className="mt-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-3-new)]">AI multi builder · bet tracker</div>
      </div>
    );
  }
  if (kind === "multipick") {
    const legs = [
      { c: "linear-gradient(135deg,#f58426,#1d428a)", n: "J. Brunson 15+ pts", cf: "98%", o: "$1.04" },
      { c: "linear-gradient(135deg,#f58426,#1d428a)", n: "Josh Hart 5+ pts", cf: "97%", o: "$1.05" },
      { c: "linear-gradient(135deg,#c8102e,#101010)", n: "M. Bridges 3+ reb", cf: "96%", o: "$1.38" },
    ];
    return (
      <div className="w-full max-w-[400px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-semibold text-[var(--text-new)]">3-leg NBA multi</span>
          <span className="mono-nums text-[18px] font-bold text-[var(--text-new)]">$1.90</span>
        </div>
        <div className="mt-2.5">
          {legs.map((l, k) => (
            <div key={k} className={"flex items-center gap-2.5 py-2 " + (k > 0 ? "border-t border-[var(--border-new)]" : "")}>
              <span className="h-5 w-5 shrink-0 rounded-full" style={{ background: l.c }} />
              <span className="flex-1 text-[12px] font-medium text-[var(--text-2-new)]">{l.n}</span>
              <span className="mono-nums text-[12px] font-semibold text-[var(--positive-new)]">{l.cf}</span>
              <span className="mono-nums w-10 text-right text-[12px] font-semibold text-[var(--text-new)]">{l.o}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "tracker") {
    const cells = [["P / L", "$536", "var(--positive-new)"], ["Win rate", "53.7%", "var(--text-new)"], ["ROI", "+38.6%", "var(--positive-new)"]];
    const bars = [14, 20, 10, 26, 18, 30, 22, 34];
    return (
      <div className="w-full max-w-[400px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4">
        <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-[var(--text-3-new)]">Dashboard</div>
        <div className="mt-2.5 grid grid-cols-3">
          {cells.map(([k, v, col], idx) => (
            <div key={k} className={"px-3.5 " + (idx > 0 ? "border-l border-[var(--border-new)]" : "")}>
              <div className="text-[8px] font-bold uppercase tracking-[0.10em] text-[var(--text-3-new)]">{k}</div>
              <div className="mono-nums mt-1.5 text-[22px] font-semibold tracking-[-0.02em]" style={{ color: col }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-3.5 flex h-[42px] items-end gap-1.5 px-0.5">
          {bars.map((h, k) => (
            <span key={k} className="flex-1 rounded-t" style={{ height: h * 1.2, background: k % 4 === 2 ? "var(--danger-new)" : "var(--positive-new)", opacity: 0.5 + k * 0.06 }} />
          ))}
        </div>
      </div>
    );
  }
  if (kind === "receipts") {
    const cells = [["Actual", "83%", "var(--positive-new)", "30px"], ["Predicted", "87%", "var(--text-new)", "18px"], ["Gap", "±4%", "var(--text-2-new)", "18px"]];
    return (
      <div className="w-full max-w-[400px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4">
        <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-[var(--text-3-new)]">Model track record</div>
        <div className="mt-2 grid grid-cols-3 border-y border-[var(--border-new)] py-3.5">
          {cells.map(([k, v, col, sz], idx) => (
            <div key={k} className={"px-3.5 " + (idx > 0 ? "border-l border-[var(--border-new)]" : "")}>
              <div className="text-[8px] font-bold uppercase tracking-[0.10em] text-[var(--text-3-new)]">{k}</div>
              <div className="mono-nums mt-2 font-semibold leading-none" style={{ color: col, fontSize: sz }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--positive-soft-new)] px-2.5 py-1 text-[10px] font-semibold text-[var(--positive-new)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--positive-new)]" /> Well calibrated
        </div>
      </div>
    );
  }
  // ready
  return (
    <svg viewBox="0 0 96 96" fill="none" className="h-[88px] w-[88px]">
      <circle cx="48" cy="48" r="40" stroke="var(--border-strong-new)" strokeWidth="5" />
      <circle cx="48" cy="48" r="40" stroke="var(--accent-new)" strokeWidth="5" strokeDasharray="251" transform="rotate(-90 48 48)" strokeLinecap="round" />
      <path d="M32 49 L43 60 L65 36" stroke="var(--accent-new)" strokeWidth="5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OnboardingTour({ initialName = "", onFinish, onSkip }) {
  const STEPS = [
    { kind: "welcome", label: "Welcome", title: "Welcome to Pickd.", copy: "Your AI multi builder + bet tracker for AFL and NBA. Take 20 seconds — here's what you can do.", name: true, cta: "Get started" },
    { kind: "multipick", label: "MultiPick", title: "Build form-backed multis.", copy: "Pick a sport, target odds and risk — MultiPick reads real player form and live market lines to assemble the strongest legs. Tap any leg for the full form breakdown." },
    { kind: "tracker", label: "Tracker", title: "Track every bet.", copy: "Log bets manually or snap a betslip screenshot — we read the stake, odds and legs for you. Profit/loss, win rate and ROI update automatically." },
    { kind: "receipts", label: "Receipts", title: "We show our misses.", copy: "Every prediction is logged and checked against the real result. The Model Track Record shows our actual hit rate vs what we predicted — no cherry-picking." },
    { kind: "ready", label: "Ready", title: "You're all set.", copy: "Your free plan includes 3 builds a week. Build your first multi whenever you're ready — and gamble responsibly.", cta: "Build my first multi" },
  ];
  const [i, setI] = useState(0);
  const [name, setName] = useState(initialName);
  const s = STEPS[i];
  const last = i === STEPS.length - 1;
  const title = last && name.trim() ? `You're all set, ${name.trim()}.` : s.title;
  const copy = i === 1 && name.trim() ? `${name.trim()}, ${s.copy.charAt(0).toLowerCase()}${s.copy.slice(1)}` : s.copy;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Welcome tour">
      <div className="w-full max-w-[540px] overflow-hidden rounded-3xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
        <div className="flex h-[236px] items-center justify-center border-b border-[var(--border-new)] p-6" style={{ background: "radial-gradient(circle at 50% 35%, #14160c 0%, #0d0d10 75%)" }}>
          <TourMock kind={s.kind} />
        </div>
        <div className="px-8 pt-7 pb-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent-new)]">{s.label} · {i + 1} of {STEPS.length}</div>
          <h2 className="mt-2.5 text-[26px] font-bold leading-[1.05] tracking-[-0.03em] text-[var(--text-new)]">{title}</h2>
          <p className="mt-3 text-[14px] leading-relaxed text-[var(--text-2-new)]">{copy}</p>
          {s.name ? (
            <div className="mt-4">
              <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">What should we call you?</label>
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="First name" autoComplete="given-name"
                className="mt-2 w-full rounded-xl border border-[var(--border-strong-new)] bg-[var(--bg-new)] px-4 py-3 text-[16px] text-[var(--text-new)] outline-none focus:border-[var(--accent-new)]"
              />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3 px-8 pb-7">
          <div className="flex gap-1.5">
            {STEPS.map((_, k) => (
              <span key={k} className={"h-1.5 rounded-full transition-all " + (k === i ? "w-5 bg-[var(--accent-new)]" : "w-1.5 bg-[var(--border-strong-new)]")} />
            ))}
          </div>
          <div className="flex-1" />
          {!last ? <button type="button" onClick={() => onSkip(name.trim())} className="px-1.5 py-2.5 text-[13px] font-semibold text-[var(--text-3-new)] hover:text-[var(--text-2-new)]">Skip</button> : null}
          {i > 0 ? <button type="button" onClick={() => setI(i - 1)} className="rounded-full border border-[var(--border-strong-new)] px-[18px] py-[11px] text-[13px] font-semibold text-[var(--text-2-new)] hover:text-[var(--text-new)]">Back</button> : null}
          <button type="button" onClick={() => (last ? onFinish(name.trim()) : setI(i + 1))} className="rounded-full bg-[var(--accent-new)] px-[22px] py-3 text-[13px] font-bold text-[var(--bg-new)] hover:opacity-90">{s.cta || "Next"}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// "I used MultiPick" tag for the add-bet form. Tapping it marks the bet's
// source as grid_build so a manually-logged bet still counts toward the
// MultiPick performance scoreboard. Styled as a tappable card that lights
// lime when active.
function MultipickCheckbox({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all " +
        (checked
          ? "border-[var(--accent-new)] bg-[var(--accent-soft-new)]"
          : "border-[var(--border-new)] bg-[var(--surface-new)] hover:border-[var(--border-strong-new)]")
      }
    >
      <span
        className={
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all " +
          (checked ? "border-[var(--accent-new)] bg-[var(--accent-new)]" : "border-[var(--text-3-new)]")
        }
      >
        {checked ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="#0a0a0b" strokeWidth="2.2">
            <path d="M2.5 6.2 L5 8.5 L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--text-new)]">
          I used <span className="font-semibold text-[var(--text-new)]">MultiPick</span> for this bet
        </span>
        <span className="block text-[11px] text-[var(--text-3-new)]">Counts it toward your MultiPick performance stats</span>
      </span>
    </button>
  );
}

// Paywall shown when a free user hits the weekly build limit. Portal-rendered
// over a blurred backdrop, brand-styled, with the Pro benefits + upgrade CTA.
// Checkout consent gate. Users must scroll through the Terms and tick to agree
// before we start a Stripe Checkout session — a "clickwrap" (scroll + an
// affirmative tick) is far more enforceable than a passive "by subscribing you
// agree". Shown whenever an upgrade is initiated; records acceptance locally.
function TermsGateModal({ onAccept, onClose, accepting }) {
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const boxRef = useRef(null);
  // If the terms fit without scrolling (tall screen), there's no scroll event to
  // unlock the checkbox — so check on mount and don't trap the user at checkout.
  useEffect(() => {
    const el = boxRef.current;
    if (el && el.scrollHeight - el.clientHeight < 56) setScrolledEnd(true);
  }, []);
  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 56) setScrolledEnd(true);
  };
  const proceed = () => {
    if (!agreed || accepting) return;
    try {
      localStorage.setItem("pickd-terms-accepted", JSON.stringify({ at: new Date().toISOString(), version: TERMS_CONTENT.updated }));
    } catch { /* ignore storage errors */ }
    onAccept();
  };
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Terms of Use" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-[520px] flex-col overflow-hidden rounded-3xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] shadow-[0_40px_120px_rgba(0,0,0,0.6)]" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-[var(--border-new)] px-6 py-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent-new)]">Before you subscribe</div>
          <h2 className="mt-1.5 text-[20px] font-bold tracking-[-0.02em] text-[var(--text-new)]">{TERMS_CONTENT.title}</h2>
          <p className="mt-1 text-[12px] text-[var(--text-3-new)]">Please read these and scroll to the bottom, then tick to agree.</p>
        </div>
        <div ref={boxRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-[13px] leading-relaxed text-[var(--text-2-new)]">
          {TERMS_CONTENT.updated ? <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">{TERMS_CONTENT.updated}</p> : null}
          {TERMS_CONTENT.intro ? <p className="mt-2">{TERMS_CONTENT.intro}</p> : null}
          {TERMS_CONTENT.sections.map((s) => (
            <div key={s.h} className="mt-4">
              <h3 className="text-[13px] font-semibold text-[var(--text-new)]">{s.h}</h3>
              {s.p.map((par) => <p key={par} className="mt-1.5">{par}</p>)}
            </div>
          ))}
          <p className="mt-5 text-[11px] italic text-[var(--text-3-new)]">— End of Terms —</p>
        </div>
        <div className="border-t border-[var(--border-new)] px-6 py-4">
          <label className={"flex items-start gap-3 text-[13px] " + (scrolledEnd ? "cursor-pointer text-[var(--text-new)]" : "cursor-not-allowed text-[var(--text-3-new)]")}>
            <input type="checkbox" disabled={!scrolledEnd} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-new)]" />
            <span>
              I confirm I am 18+ and I agree to the Terms of Use and Privacy Policy.
              {!scrolledEnd ? <span className="mt-0.5 block text-[11px] text-[var(--text-3-new)]">Scroll to the bottom of the terms to enable this.</span> : null}
            </span>
          </label>
          <button type="button" onClick={proceed} disabled={!agreed || accepting} className="mt-4 w-full rounded-xl bg-[var(--accent-new)] py-3.5 text-[14px] font-bold text-[var(--bg-new)] transition-opacity hover:opacity-90 disabled:opacity-40">
            {accepting ? "Starting checkout…" : "Agree & continue to secure checkout"}
          </button>
          <button type="button" onClick={onClose} className="mt-2 w-full py-2 text-[13px] font-semibold text-[var(--text-3-new)] hover:text-[var(--text-2-new)]">Cancel</button>
          <p className="mt-2 text-center text-[11px] text-[var(--text-3-new)]">18+ · Gamble responsibly · Payments processed securely by Stripe</p>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Paywall({ usage = 3, limit = 3, foundingSpotsLeft = null, onUpgrade, upgrading, onClose }) {
  const founding = typeof foundingSpotsLeft === "number" && foundingSpotsLeft > 0;
  const benefits = [
    "Unlimited multi builds",
    "AFL + NBA player props",
    "Every risk profile, incl. Best Chance",
    "Live calibration + model track record",
    "Cancel anytime",
  ];
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Upgrade to Pro" onClick={onClose}>
      <div className="w-full max-w-[440px] overflow-hidden rounded-3xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] shadow-[0_40px_120px_rgba(0,0,0,0.6)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-[150px] items-center justify-center border-b border-[var(--border-new)]" style={{ background: "radial-gradient(circle at 50% 40%, #14160c 0%, #0d0d10 75%)" }}>
          <div className="text-center">
            <div className="brand-wordmark text-[40px]">Pickd<span className="text-[var(--accent-new)]">.</span> <span className="text-[var(--accent-new)]">Pro</span></div>
            <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--text-3-new)]">Unlimited multi builder</div>
          </div>
        </div>
        <div className="px-7 pt-6 pb-7">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent-new)]">Free limit reached</div>
          <h2 className="mt-2.5 text-[24px] font-bold leading-[1.1] tracking-[-0.03em] text-[var(--text-new)]">You're out of free builds.</h2>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-[var(--text-2-new)]">
            You've used all <span className="mono-nums font-medium text-[var(--text-new)]">{limit}</span> of your free builds this week. They reset Monday — or go unlimited with Pro right now.
          </p>
          <ul className="mt-5 space-y-2.5">
            {benefits.map((b) => (
              <li key={b} className="flex items-center gap-2.5 text-[13.5px] text-[var(--text-2-new)]">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft-new)]">
                  <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="var(--accent-new)" strokeWidth="2.2"><path d="M2.5 6.2 L5 8.5 L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                {b}
              </li>
            ))}
          </ul>
          {founding ? (
            <div className="mt-5 rounded-xl border border-[var(--accent-new)] bg-[var(--accent-soft-new)] px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--accent-new)]">Founding offer · {foundingSpotsLeft} of 20 spots left</div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="mono-nums text-[30px] font-bold tracking-[-0.03em] text-[var(--text-new)]">A$4.99</span>
                <span className="mono-nums text-[15px] font-medium text-[var(--text-3-new)] line-through">A$6.99</span>
                <span className="text-[13px] text-[var(--text-3-new)]">/ week</span>
              </div>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-new)] px-2 py-1 text-[11px] font-extrabold uppercase tracking-[0.10em] text-[var(--bg-new)]">
                🔒 Locked in forever
              </div>
            </div>
          ) : (
            <div className="mt-6 flex items-baseline gap-2">
              <span className="mono-nums text-[30px] font-bold tracking-[-0.03em] text-[var(--text-new)]">A$6.99</span>
              <span className="text-[13px] text-[var(--text-3-new)]">/ week</span>
            </div>
          )}
          <button type="button" onClick={onUpgrade} disabled={upgrading} className="mt-4 w-full rounded-xl bg-[var(--accent-new)] py-3.5 text-[14px] font-bold text-[var(--bg-new)] transition-opacity hover:opacity-90 disabled:opacity-50">
            {upgrading ? "Starting checkout…" : founding ? "Claim founding rate" : "Upgrade to Pro"}
          </button>
          <button type="button" onClick={onClose} className="mt-2 w-full py-2.5 text-[13px] font-semibold text-[var(--text-3-new)] hover:text-[var(--text-2-new)]">Maybe later</button>
          <p className="mt-3 text-center text-[11px] text-[var(--text-3-new)]">{founding ? "$4.99 locked in forever while you stay subscribed · " : "Free builds reset Monday · "}18+ · Gamble responsibly</p>
        </div>
      </div>
    </div>,
    document.body
  );
}

function renderEdgeText(text) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold text-[var(--text-new)]">
          {part.slice(2, -2)}
        </strong>
      );
    }

    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function EdgeMessage({ role, children }) {
  const isEdge = role === "edge";
  const text = String(children || "");
  const sectionLabels = ["Simple view", "Available games", "Example structure", "What I would check", "Risk level", "Important"];

  const parseSections = (message) => {
    const sections = [];
    sectionLabels.forEach((label, index) => {
      const startToken = label + ":";
      const startIndex = message.indexOf(startToken);
      if (startIndex === -1) return;
      const contentStart = startIndex + startToken.length;
      const nextIndexes = sectionLabels
        .slice(index + 1)
        .map((nextLabel) => message.indexOf(nextLabel + ":", contentStart))
        .filter((value) => value !== -1);
      const contentEnd = nextIndexes.length ? Math.min(...nextIndexes) : message.length;
      const content = message.slice(contentStart, contentEnd).trim();
      if (content) {
        sections.push({ label, content });
      }
    });
    return sections;
  };

  const sections = isEdge ? parseSections(text) : [];

  if (!isEdge) {
    // User message — soft accent-tinted bubble, right-aligned.
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[88%] whitespace-pre-line rounded-2xl px-4 py-3 text-sm leading-6 text-[var(--text-new)]"
          style={{ background: "var(--accent-soft-new)", border: "1px solid rgba(212,242,58,0.18)" }}
        >
          {children}
        </div>
      </div>
    );
  }

  if (!sections.length) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] whitespace-pre-line rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] px-4 py-3 text-sm leading-6 text-[var(--text-2-new)]">{renderEdgeText(children)}</div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-3">
        {sections.map((section) => (
          <div key={section.label} className="rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4 text-sm leading-6 text-[var(--text-2-new)]">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">{section.label}</p>
            <p className="whitespace-pre-line">{renderEdgeText(section.content)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function GameAnalysisOutput({ analysis, loading }) {
  if (!analysis) {
    return (
      <Card>
        <div className="flex items-center gap-3 p-6 text-sm text-slate-600">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#11203B]" />
          Analysing the match — pulling odds, recent form and matchup data…
        </div>
      </Card>
    );
  }
  if (analysis.error) {
    return <Card><div className="p-6 text-sm text-slate-600">{analysis.error}</div></Card>;
  }

  const mr = analysis.marketRead;
  const sides = [["home", analysis.homeTeam], ["away", analysis.awayTeam]];

  return (
    <Card>
      <div className="space-y-5 p-5 md:p-6">
        <div>
          <p className="text-sm font-medium text-slate-500">Game analysis</p>
          <h2 className="mt-1 text-2xl font-semibold">{analysis.game}</h2>
          <p className="mt-1 text-xs text-slate-500">A data-backed read of the match — informational only, not betting advice.</p>
        </div>

        {mr && (mr.favourite || mr.totalLine != null || mr.spreadLine != null) ? (
          <div className="rounded-2xl border border-slate-200 bg-[#FAF7EF] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Market read</p>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {mr.favourite ? <div><span className="font-semibold text-[#11203B]">{mr.favourite}</span> favoured <span className="text-slate-500">${formatOdds(mr.favPrice)} · ~{mr.favPct}%</span></div> : null}
              {mr.underdog ? <div><span className="font-medium text-[#11203B]">{mr.underdog}</span> <span className="text-slate-500">${formatOdds(mr.dogPrice)} · ~{mr.dogPct}%</span></div> : null}
              {mr.totalLine != null ? <div className="text-slate-600">Total <span className="font-semibold text-[#11203B]">{mr.totalLine}</span></div> : null}
              {mr.spreadLine != null ? <div className="text-slate-600">Line <span className="font-semibold text-[#11203B]">{mr.spreadFav} -{mr.spreadLine}</span></div> : null}
            </div>
          </div>
        ) : null}

        {analysis.keyPlayers && (analysis.keyPlayers.home?.length || analysis.keyPlayers.away?.length) ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Key players to watch</p>
            <div className="mt-2 grid gap-4 md:grid-cols-2">
              {sides.map(([side, team]) => (
                <div key={side} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-center gap-2">
                    <TeamCrest team={team} className="h-5 w-5" />
                    <p className="text-sm font-semibold text-[#11203B]">{team}</p>
                  </div>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {(analysis.keyPlayers[side] || []).map((l, i) => (
                      <li key={i} className="rounded-lg border border-slate-200 bg-[#FAF7EF] px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-medium text-[#11203B]">{l.player} <span className="font-normal text-slate-500">{l.label}</span></span>
                          <span className="shrink-0 text-xs text-slate-500">${formatOdds(l.odds)}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                          <span>{l.confidence}% conf</span>
                          {l.hr10 ? <span>· cleared {l.hr10}</span> : null}
                          {l.recentAvg != null ? <span>· avg {l.recentAvg}</span> : null}
                          {typeof l.edgePct === "number" ? <span className={l.edgePct > 0 ? "text-[#2E7D5B]" : ""}>· {l.edgePct >= 0 ? "+" : ""}{l.edgePct}% edge</span> : null}
                          {l.matchupPct ? <span className={l.matchupPct > 0 ? "text-[#2E7D5B]" : "text-[#A94442]"}>· vs {l.opponent} {l.matchupPct >= 0 ? "+" : ""}{l.matchupPct}%</span> : null}
                        </div>
                      </li>
                    ))}
                    {!(analysis.keyPlayers[side] || []).length ? <li className="text-xs text-slate-500">No player markets posted yet.</li> : null}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {analysis.valuePlays?.length ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Standout value</p>
            <ul className="mt-2 space-y-1.5">
              {analysis.valuePlays.map((l, i) => (
                <li key={i} className="rounded-xl border border-slate-200 bg-[#FAF7EF] px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-[#11203B]">{l.player} <span className="text-slate-500">{l.label}</span></span>
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      <span className="rounded-full bg-[#2E7D5B]/15 px-2 py-0.5 font-semibold text-[#2E7D5B]">+{l.edgePct}% value</span>
                      <span className="text-slate-500">${formatOdds(l.odds)}</span>
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span>{l.confidence}% conf</span>
                    {l.hr10 ? <span>· cleared {l.hr10}</span> : null}
                    {l.recentAvg != null ? <span>· avg {l.recentAvg}</span> : null}
                    {l.matchupPct ? <span className={l.matchupPct > 0 ? "text-[#2E7D5B]" : "text-[#A94442]"}>· vs {l.opponent} {l.matchupPct >= 0 ? "+" : ""}{l.matchupPct}%</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {analysis.matchupAngles?.length ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Matchup angles</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              {analysis.matchupAngles.map((a, i) => <li key={i}>• {a}</li>)}
            </ul>
          </div>
        ) : null}

        {analysis.summary ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Summary</p>
            <div className="mt-2"><EdgeMessage role="edge">{analysis.summary}</EdgeMessage></div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ── MultiPick build animation ────────────────────────────────────────────
// Canvas-rendered hybrid sphere shown in the output column while a build is
// running: a glowing core with orbital rings (the "engine") inside a rotating
// synapse shell (~220 nodes) whose connections fire as the core sends signals
// outward. Reads as deep statistical reasoning rather than a generic spinner.
// Self-contained: geometry + rAF live entirely in the effect, cleaned up on
// unmount; respects prefers-reduced-motion (renders one static frame).
const BUILD_PHASES = [
  "Pulling live odds",
  "De-vigging market lines",
  "Weighting recent form",
  "Computing matchup factors",
  "Searching combinations",
  "Optimising combined edge",
];
const _lerp = (a, b, t) => a + (b - a) * t;
const _mix = (c1, c2, t) => [_lerp(c1[0], c2[0], t), _lerp(c1[1], c2[1], t), _lerp(c1[2], c2[2], t)];
function _fibSphere(n) {
  const p = [], phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2, rad = Math.sqrt(1 - y * y), th = phi * i;
    p.push({ x: Math.cos(th) * rad, y, z: Math.sin(th) * rad });
  }
  return p;
}
function _rot(p, ay, ax) {
  const cy = Math.cos(ay), sy = Math.sin(ay);
  let x = p.x * cy - p.z * sy, z = p.x * sy + p.z * cy, y = p.y;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  return { x, y: y * cx - z * sx, z: y * sx + z * cx };
}
const _FOV = 3.2;
function _proj(p, R, cx, cy) {
  const s = _FOV / (_FOV - p.z);
  return { sx: cx + p.x * R * s, sy: cy + p.y * R * s, depth: (p.z + 1) / 2, s };
}

function BuildingAnimation({ height = 380, showStatus = true, showBeam = true, className = "mt-6", bare = false, minimal = false }) {
  const canvasRef = useRef(null);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % BUILD_PHASES.length), 1700);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const ACC = [205, 251, 80];
    const N = minimal ? 110 : 220;
    const pts = _fibSphere(N);
    const neigh = [];
    const act = new Array(N).fill(0);
    let flares = [];
    const TH = 0.9;
    for (let i = 0; i < N; i++) {
      const a = pts[i], list = [];
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const d = a.x * pts[j].x + a.y * pts[j].y + a.z * pts[j].z;
        if (d > TH) list.push(j);
      }
      list.sort((m, n) => (a.x * pts[n].x + a.y * pts[n].y + a.z * pts[n].z) - (a.x * pts[m].x + a.y * pts[m].y + a.z * pts[m].z));
      neigh.push(list.slice(0, 4));
    }
    // Minimal mode: drop the orbital rings (the busy bit) for a clean,
    // slowly-rotating point-cloud sphere — used as the empty-state decoration.
    const rings = (minimal ? [] : [
      { tilt: 0.3, yaw: 0, n: 24, sp: 0.0009, r: 0.50 },
      { tilt: 1.2, yaw: 0.8, n: 20, sp: -0.0012, r: 0.58 },
      { tilt: -0.7, yaw: 1.7, n: 16, sp: 0.0014, r: 0.44 },
    ]).map((d) => {
      const parts = [];
      for (let i = 0; i < d.n; i++) parts.push((i / d.n) * Math.PI * 2);
      return { ...d, parts, hot: (Math.random() * d.n) | 0 };
    });

    let W = 0, H = 0, raf = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = W * DPR; canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (t) => {
      if (!W || !H) return;
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36;
      const ay = t * 0.00022, ax = Math.sin(t * 0.0004) * 0.32, gy = t * 0.00018;
      let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
      g.addColorStop(0, "rgba(205,251,80,0.06)"); g.addColorStop(0.5, "rgba(205,251,80,0.02)"); g.addColorStop(1, "rgba(205,251,80,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (!reduce && Math.random() < (minimal ? 0.015 : 0.022) && flares.length < 3) {
        const seed = (Math.random() * N) | 0; act[seed] = 1;
        for (const j of neigh[seed]) act[j] = Math.max(act[j], 0.4);
        // Core→shell beams only in full mode; minimal keeps just the gentle
        // shell firing (lit dots + their connections), no center beams.
        if (!minimal) flares.push({ node: seed, life: 1 });
      }
      const proj = pts.map((p) => { const r = _rot(p, ay, ax); return { r, pr: _proj(r, R, cx, cy) }; });
      const order = [...Array(N).keys()].sort((a, b) => proj[a].r.z - proj[b].r.z);
      ctx.lineWidth = 1;
      for (const i of order) for (const j of neigh[i]) {
        if (j < i) continue;
        const A = proj[i].pr, B = proj[j].pr, dep = (A.depth + B.depth) / 2, a = Math.max(act[i], act[j]);
        const alpha = 0.045 * dep + a * 0.38;
        if (alpha < 0.02) continue;
        const c = _mix([90, 90, 100], ACC, Math.min(1, a * 1.2));
        ctx.strokeStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
        ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
      }
      for (const f of flares) {
        const pr = proj[f.node].pr;
        const grad = ctx.createLinearGradient(cx, cy, pr.sx, pr.sy);
        grad.addColorStop(0, `rgba(205,251,80,${0.05 * f.life})`); grad.addColorStop(1, `rgba(205,251,80,${0.55 * f.life})`);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(pr.sx, pr.sy); ctx.stroke();
        f.life *= 0.945;
      }
      flares = flares.filter((f) => f.life > 0.06); ctx.lineWidth = 1;
      const items = [];
      for (const ring of rings) {
        const ang = t * ring.sp;
        for (let i = 0; i < ring.parts.length; i++) {
          const a = ring.parts[i] + ang;
          let p = { x: Math.cos(a) * ring.r, y: Math.sin(a) * ring.r * 0.30, z: Math.sin(a) * ring.r };
          p = _rot(p, ring.yaw + gy, ring.tilt);
          items.push({ z: p.z, kind: "ring", pr: _proj(p, R, cx, cy), hot: i === ring.hot });
        }
      }
      for (let i = 0; i < N; i++) items.push({ z: proj[i].r.z, kind: "shell", pr: proj[i].pr, a: act[i] });
      if (!minimal) items.push({ z: 0, kind: "core" });
      items.sort((u, v) => u.z - v.z);
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.0022);
      for (const it of items) {
        if (it.kind === "core") {
          ctx.shadowBlur = 22 + pulse * 10; ctx.shadowColor = "rgba(205,251,80,0.9)";
          ctx.fillStyle = "rgba(205,251,80,0.88)"; ctx.beginPath(); ctx.arc(cx, cy, 5.5 + pulse * 1.6, 0, 7); ctx.fill();
          ctx.shadowBlur = 0;
        } else if (it.kind === "ring") {
          const pr = it.pr, c = it.hot ? ACC : _mix([120, 120, 134], ACC, 0.3);
          const rad = (0.8 + 1.8 * pr.depth) * pr.s * (it.hot ? 1.4 : 1);
          if (it.hot) { ctx.shadowBlur = 9; ctx.shadowColor = "rgba(205,251,80,0.9)"; } else ctx.shadowBlur = 0;
          ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${0.25 + 0.7 * pr.depth})`;
          ctx.beginPath(); ctx.arc(pr.sx, pr.sy, rad, 0, 7); ctx.fill();
        } else {
          const pr = it.pr, a = it.a, base = 0.16 + 0.7 * pr.depth;
          const c = _mix([150, 150, 162], ACC, Math.min(1, a * 1.3));
          const rad = (0.65 + 1.7 * pr.depth) * (1 + a * 1.0) * pr.s;
          if (a > 0.2) { ctx.shadowBlur = 7 * a; ctx.shadowColor = "rgba(205,251,80,0.85)"; } else ctx.shadowBlur = 0;
          ctx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${base})`;
          ctx.beginPath(); ctx.arc(pr.sx, pr.sy, rad, 0, 7); ctx.fill();
        }
      }
      ctx.shadowBlur = 0;
      for (let i = 0; i < N; i++) act[i] *= 0.972;
    };

    const startT = performance.now();
    const loop = (now) => { ctx.clearRect(0, 0, W, H); draw(now - startT); raf = requestAnimationFrame(loop); };
    if (reduce) draw(0);
    else raf = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div
      className={(showBeam ? "beam-border " : "") + "relative overflow-hidden " + (bare ? "" : "rounded-2xl border border-[var(--border-new)] ") + className}
      style={{ height, background: bare ? "transparent" : "radial-gradient(circle at 50% 45%, #101013 0%, var(--bg-new) 72%)" }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {showStatus ? (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-2-new)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-new)]" style={{ animation: "buildBlink 1.4s ease-in-out infinite" }} />
          <span style={{ transition: "opacity .4s" }}>{BUILD_PHASES[phase]}</span>
        </div>
      ) : null}
    </div>
  );
}

function EdgePage({ setActivePage, onSaveMulti, accessToken, gridBuildStats, prefill, onPrefillConsumed, fmtMoney = formatCurrency }) {
  const [mode, setMode] = useState("multi");
  const [sport, setSport] = useState(prefill?.sport || "AFL");
  const [legs, setLegs] = useState(prefill?.legs || "Any");
  const [targetOdds, setTargetOdds] = useState(prefill?.targetOdds || "$2.00");
  const [customTargetOdds, setCustomTargetOdds] = useState("2.20");
  const [customLegs, setCustomLegs] = useState("6");
  const [riskProfile, setRiskProfile] = useState(prefill?.riskProfile || "Best Chance");
  const [bookmaker, setBookmaker] = useState(prefill?.bookmaker || "");
  const [request, setRequest] = useState(prefill?.request || "");
  const [chatInput, setChatInput] = useState("");
  const [edgeLoading, setEdgeLoading] = useState(false);
  // True only while the "Build multi" button is running a fresh build (not a
  // chat refine). Drives the full-screen sphere animation in the output column
  // every time Build is pressed — even when a multi already exists.
  const [buildingMulti, setBuildingMulti] = useState(false);
  const [showRiskExplanation, setShowRiskExplanation] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [lastEdgeContext, setLastEdgeContext] = useState(null);
  const [multiOutput, setMultiOutput] = useState(null);
  const [analysisOutput, setAnalysisOutput] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [betStake, setBetStake] = useState("");
  const [savingBet, setSavingBet] = useState(false);
  const [saveBetMsg, setSaveBetMsg] = useState("");
  const [entitlement, setEntitlement] = useState({ subscribed: false, usage: 0, limit: 3, foundingSpotsLeft: null });
  const [upgrading, setUpgrading] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [calibration, setCalibration] = useState(null);
  // Modal open/closed for the "View calibration detail →" link on the
  // simplified track-record block. Renders the bucket breakdown only
  // when users opt in — keeps the main page clean for casual users.
  const [calibrationDetailOpen, setCalibrationDetailOpen] = useState(false);
  const [propsStatus, setPropsStatus] = useState(null);
  const [propsDismissedRound, setPropsDismissedRound] = useState(() => {
    try { return localStorage.getItem("propsDismissedRound") || ""; } catch { return ""; }
  });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/calibration");
        const data = await response.json();
        if (!cancelled && data?.available) setCalibration(data);
      } catch {
        /* ignore — track-record card just won't show */
      }
    })();
    (async () => {
      try {
        const response = await fetch("/api/props-status");
        const data = await response.json();
        if (!cancelled && data?.available) setPropsStatus(data);
      } catch {
        /* ignore — prop-drop notice just won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissProps = () => {
    const key = propsStatus?.roundKey || "";
    setPropsDismissedRound(key);
    try { localStorage.setItem("propsDismissedRound", key); } catch { /* ignore */ }
  };

  React.useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/entitlement", { headers: { Authorization: `Bearer ${accessToken}` } });
        const data = await response.json();
        if (!cancelled) setEntitlement({ subscribed: !!data.subscribed, usage: data.usage || 0, limit: data.limit || 3, foundingSpotsLeft: data.foundingSpotsLeft ?? null });
      } catch {
        /* ignore — counter just won't show until a build */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const [termsGateOpen, setTermsGateOpen] = useState(false);
  // Clicking any upgrade entry point opens the Terms gate; doCheckout runs only
  // after the user scrolls + ticks agree.
  const startUpgrade = () => { if (!upgrading) setTermsGateOpen(true); };
  const doCheckout = async () => {
    if (upgrading) return;
    setTermsGateOpen(false);
    setUpgrading(true);
    try {
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setUpgrading(false);
        setSaveBetMsg(data.error || "Could not start checkout. Please try again.");
      }
    } catch {
      setUpgrading(false);
      setSaveBetMsg("Could not start checkout. Please try again.");
    }
  };

  const startManageBilling = async () => {
    if (openingPortal) return;
    setOpeningPortal(true);
    try {
      const response = await fetch("/api/create-portal-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setOpeningPortal(false);
        setSaveBetMsg(data.error || "Could not open billing portal. Please try again.");
      }
    } catch {
      setOpeningPortal(false);
      setSaveBetMsg("Could not open billing portal. Please try again.");
    }
  };

  const buildsLeft = Math.max(0, entitlement.limit - entitlement.usage);
  const gatedNow = !entitlement.subscribed && buildsLeft <= 0;

  const addMultiToBets = async () => {
    if (!multiOutput || savingBet || typeof onSaveMulti !== "function") return;
    setSavingBet(true);
    setSaveBetMsg("");
    const result = await onSaveMulti(multiOutput, betStake);
    setSavingBet(false);
    if (result?.error) {
      setSaveBetMsg(result.error);
    } else {
      setSaveBetMsg("Saved to your bets as pending. Settle it on the dashboard after the games.");
      setBetStake("");
    }
  };
  const [games, setGames] = useState([]);
  const [selectedGameId, setSelectedGameId] = useState("");
  // Multi-select games for the mobile builder card (parallels the dashboard card).
  // Desktop keeps the single-select dropdown via selectedGameId.
  const [selectedGameIds, setSelectedGameIds] = useState([]);
  // Games to build from on the deep-linked auto-build. Supports multiple — the
  // dashboard mini-builder can pick several to spread the multi across.
  const buildGameIdsRef = useRef(Array.isArray(prefill?.gameIds) ? prefill.gameIds.filter(Boolean) : (prefill?.gameId ? [prefill.gameId] : []));
  // Pre-select the single Games dropdown only when exactly one was chosen.
  const wantGameIdRef = useRef(buildGameIdsRef.current.length === 1 ? buildGameIdsRef.current[0] : "");
  const gameAppliedRef = useRef(false);
  const chatSectionRef = React.useRef(null);
  const outputPanelRef = React.useRef(null);

  // Load the real upcoming games for the chosen sport so users can pick one
  React.useEffect(() => {
    let cancelled = false;
    setSelectedGameId("");
    setSelectedGameIds([]);
    setGames([]);
    (async () => {
      try {
        const response = await fetch(`/api/odds?sport=${encodeURIComponent(sport)}&markets=h2h`);
        const data = await response.json();
        if (cancelled) return;
        let upcoming = (data.events || [])
          .slice(0, 12)
          .map((event) => ({ id: event.id, label: `${event.homeTeam} vs ${event.awayTeam}`, homeTeam: event.homeTeam, awayTeam: event.awayTeam, commenceTime: event.commenceTime }));
        if (upcoming.length === 0 && import.meta.env.DEV) upcoming = devSampleGames(sport).map((game) => ({ ...game, label: `${game.homeTeam} vs ${game.awayTeam}` }));
        setGames(upcoming);
        // Apply any deep-linked games once the sport's slate is in, exactly once —
        // sets the single dropdown (desktop) and the multi-select (mobile card).
        if (!gameAppliedRef.current && buildGameIdsRef.current.length) {
          const present = buildGameIdsRef.current.filter((id) => upcoming.some((game) => game.id === id));
          if (present.length) {
            gameAppliedRef.current = true;
            setSelectedGameIds(present);
            if (present.length === 1) setSelectedGameId(present[0]);
          }
        }
      } catch {
        if (!cancelled) setGames(import.meta.env.DEV ? devSampleGames(sport).map((game) => ({ ...game, label: `${game.homeTeam} vs ${game.awayTeam}` })) : []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sport]);

  const displayedTargetOdds = targetOdds === "Custom" && customTargetOdds ? "$" + customTargetOdds : targetOdds;
  const displayedLegs = legs === "Custom" && customLegs ? customLegs : legs;

  const exampleLegs = [
    {
      name: "Player A 25+ disposals",
      confidence: "78%",
      reason: "Example data: cleared 25+ in 7 of the last 8 games, averaging 29.4 disposals across that span.",
      details: [
        { label: "Last 8 hit rate", value: "7/8" },
        { label: "Last 8 average", value: "29.4" },
        { label: "Season average", value: "27.8" },
        { label: "Lowest in last 8", value: "23" },
        { label: "Highest in last 8", value: "36" },
        { label: "Role note", value: "Primary mid" },
      ],
      trend: "Recent disposal counts: 31, 28, 34, 26, 30, 23, 36, 27. He has only missed the 25+ line once in this sample.",
      extraReason: "This leg is included because the recent hit rate is strong, the average sits above the line, and the player role supports repeat disposal volume.",
    },
    {
      name: "Player B 25+ disposals",
      confidence: "74%",
      reason: "Example data: cleared 25+ in 8 of the last 10 games, averaging 28.1 disposals across that span.",
      details: [
        { label: "Last 10 hit rate", value: "8/10" },
        { label: "Last 10 average", value: "28.1" },
        { label: "Season average", value: "26.9" },
        { label: "Lowest in last 10", value: "21" },
        { label: "Highest in last 10", value: "35" },
        { label: "Role note", value: "Inside/outside mid" },
      ],
      trend: "Recent disposal counts: 29, 31, 27, 24, 30, 28, 35, 21, 26, 30. The two misses were close to the line rather than major role drops.",
      extraReason: "This leg is included because the player has shown a stable disposal floor and has cleared the selected line in most recent matches.",
    },
    {
      name: "Player C 20+ disposals",
      confidence: "71%",
      reason: "Example data: cleared 20+ in 6 of the last 8 games, with a stable midfield role in recent matches.",
      details: [
        { label: "Last 8 hit rate", value: "6/8" },
        { label: "Last 8 average", value: "23.6" },
        { label: "Season average", value: "22.4" },
        { label: "Lowest in last 8", value: "17" },
        { label: "Highest in last 8", value: "30" },
        { label: "Role note", value: "Mid rotation" },
      ],
      trend: "Recent disposal counts: 24, 22, 19, 26, 30, 17, 25, 23. This is a lower line, but the role is slightly less secure than the first two legs.",
      extraReason: "This leg is included because the lower line helps keep the overall multi near the target odds while still being supported by recent form.",
    },
  ];

  const resetEdgeChat = () => {
    setLastEdgeContext(null);
    setChatMessages([
      {
        role: "edge",
        text: "Simple view:\n\nNew MultiPick chat started. Ask me for an example multi, a game analysis structure, or what data I would check before building a selection.\n\nExample structure:\n\nYou can ask things like: Build a 3-leg AFL example around $2.00 using disposals only.\n\nWhat I would check:\n\nI will explain the key data needed without pretending live stats are connected yet.\n\nRisk level:\n\nI can explain the risk on a 1 to 10 scale.\n\nImportant:\n\nThis is informational only, not betting advice.",
      },
    ]);
    setChatInput("");
  };

  const clearEdgeChat = () => {
    setChatMessages([]);
    setChatInput("");
    setLastEdgeContext(null);
  };

  const useExamplePrompt = (prompt) => {
    setChatInput(prompt);
  };

  const previewAnalysis = async () => {
    if (edgeLoading) return;
    const selectedGame = games.find((game) => game.id === selectedGameId);
    setEdgeLoading(true);
    setAnalyzing(true);
    setAnalysisOutput(null);
    setTimeout(() => outputPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    try {
      const response = await fetch("/api/edge", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify({
          message: `Give me a full analysis of ${selectedGame ? selectedGame.label : "the selected AFL game"}.`,
          context: { mode: "analysis", analysisRequest: true, sport, gameId: selectedGameId },
        }),
      });
      const data = await response.json();
      if (data?.analysis) {
        setMultiOutput(null);
        setAnalysisOutput({ ...data.analysis, summary: data.reply });
      } else {
        setAnalysisOutput({ error: data?.reply || "Could not analyse this game right now." });
      }
    } catch {
      setAnalysisOutput({ error: "Could not analyse this game right now." });
    } finally {
      setEdgeLoading(false);
      setAnalyzing(false);
    }
  };

  const previewMulti = (opts) => {
    if (edgeLoading) return;
    // Hard-stop free users at the weekly limit before spending a request, and
    // show the paywall. Server enforces this too (defence in depth), but this
    // gives instant feedback and the upgrade prompt.
    if (gatedNow) { setShowPaywall(true); return; }
    setAnalysisOutput(null);
    // gameIds override (from the dashboard multi-select handoff) lets one build
    // span several games; manual builds fall back to the single dropdown.
    const gameIdsOverride = Array.isArray(opts?.gameIds) ? opts.gameIds.filter(Boolean) : null;
    const requestPart = request.trim() ? `. Focus: ${request.trim()}` : "";
    const riskPart = riskProfile !== "Balanced" ? ` with a ${riskProfile} risk profile` : "";
    const selectedGame = games.find((game) => game.id === selectedGameId);
    const gameLabels = gameIdsOverride && gameIdsOverride.length
      ? games.filter((game) => gameIdsOverride.includes(game.id)).map((game) => game.label)
      : (selectedGame ? [selectedGame.label] : []);
    const gamePart = gameLabels.length === 1 ? ` for the ${gameLabels[0]} game`
      : gameLabels.length > 1 ? ` spread across ${gameLabels.join(", ")}` : "";
    const prompt = `Build a ${displayedLegs}-leg ${sport} example multi${gamePart} targeting ${displayedTargetOdds}${riskPart}${requestPart}. Use real player form and current odds to pick the best legs mathematically. Show each leg's hit rate and recent average.`;
    sendChatMessage(prompt, { isBuild: true, gameIds: gameIdsOverride });
    setTimeout(() => {
      outputPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  };

  // Deep-link build: when the dashboard mini-builder hands off a prefill, fire
  // exactly one build — but wait until the requested game has been applied (so
  // the build targets it). A fallback timer still fires a sport-wide build if
  // the games never resolve (e.g. odds API hiccup), so the user never stalls.
  const autoBuiltRef = useRef(false);
  const fireAutoBuild = () => {
    if (autoBuiltRef.current) return;
    autoBuiltRef.current = true;
    onPrefillConsumed?.();
    previewMulti({ gameIds: buildGameIdsRef.current });
  };
  useEffect(() => {
    if (autoBuiltRef.current || !prefill?.autoBuild) return;
    const needsGame = !!wantGameIdRef.current;
    if (needsGame && selectedGameId !== wantGameIdRef.current) return;
    const timer = setTimeout(fireAutoBuild, 0);
    return () => clearTimeout(timer);
  }, [prefill, selectedGameId, games]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!prefill?.autoBuild) return;
    const fallback = setTimeout(fireAutoBuild, 4500);
    return () => clearTimeout(fallback);
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendChatMessage = async (messageOverride = null, opts = {}) => {
    const trimmed = (messageOverride || chatInput).trim();
    if (!trimmed || edgeLoading) return;

    setChatMessages((current) => [...current, { role: "user", text: trimmed }]);
    if (!messageOverride) setChatInput("");
    setEdgeLoading(true);
    // Fresh "Build multi" runs show the sphere animation (even over an existing
    // multi); chat refines keep the slim inline spinner instead.
    if (opts.isBuild) setBuildingMulti(true);

    try {
      const response = await fetch("/api/edge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          message: trimmed,
          context: {
            mode,
            sport,
            legs: displayedLegs,
            targetOdds: displayedTargetOdds,
            riskProfile,
            bookmaker,
            request,
            gameId: selectedGameId,
            gameIds: opts.gameIds && opts.gameIds.length ? opts.gameIds : (selectedGameId ? [selectedGameId] : undefined),
            previousEdgeContext: lastEdgeContext,
            currentMulti: multiOutput,
          },
        }),
      });

      const data = await response.json();
      if (data?.edgeContext) {
        setLastEdgeContext(data.edgeContext);
      }
      if (typeof data?.usage === "number") {
        setEntitlement((current) => ({
          subscribed: data.subscribed ?? current.subscribed,
          usage: data.usage,
          limit: data.limit ?? current.limit,
          foundingSpotsLeft: current.foundingSpotsLeft,
        }));
      }
      // Server says the free limit is hit — surface the paywall instead of just
      // a chat line (and don't leave a dangling "Building…" state).
      if (data?.gated) {
        setShowPaywall(true);
        return;
      }
      if (data?.multi) {
        setMultiOutput(data.multi);
      }
      if (!response.ok) throw new Error(data.error || "MultiPick request failed");
      setChatMessages((current) => [...current, { role: "edge", text: data.reply }]);
    } catch (error) {
      setChatMessages((current) => [
        ...current,
        {
          role: "edge",
          text: "Simple view:\n\nMultiPick could not respond right now.\n\nExample structure:\n\nThis usually means the backend API, OpenAI key, or deployment needs to be checked.\n\nWhat I would check:\n\nConfirm the Vercel function is deployed and the OPENAI_API_KEY is set correctly.\n\nRisk level:\n\nTechnical issue only.\n\nImportant:\n\nTry again shortly after checking the setup.",
        },
      ]);
    } finally {
      setEdgeLoading(false);
      if (opts.isBuild) setBuildingMulti(false);
    }
  };

  return (
    <div className="page-fade-in min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopNav activePage="edge" setActivePage={setActivePage} />

          {showPaywall ? <Paywall usage={entitlement.usage} limit={entitlement.limit} foundingSpotsLeft={entitlement.foundingSpotsLeft} onUpgrade={startUpgrade} upgrading={upgrading} onClose={() => setShowPaywall(false)} /> : null}
          {termsGateOpen ? <TermsGateModal onAccept={doCheckout} onClose={() => setTermsGateOpen(false)} accepting={upgrading} /> : null}
          {propsStatus && propsStatus.propsAvailable && propsStatus.roundKey !== propsDismissedRound ? (
            <div className="flex items-center gap-3 rounded-2xl border border-[#2E7D5B]/40 bg-[#2E7D5B]/10 px-4 py-3 text-sm">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#2E7D5B]" />
              <span className="font-medium text-[#11203B]">Player props are live{propsStatus.game ? ` for ${propsStatus.game}` : ""} — build your multi now.</span>
              <button type="button" onClick={dismissProps} className="ml-auto shrink-0 text-xs font-medium text-slate-500 underline hover:text-slate-700">Dismiss</button>
            </div>
          ) : propsStatus && propsStatus.propsAvailable === false && propsStatus.reason === "not_posted_yet" ? (
            <div className="rounded-2xl border border-slate-300 bg-[#FAF7EF] px-4 py-3 text-sm text-slate-600">
              Player props for the next game aren’t posted yet — they usually drop closer to game time. Check back soon.
            </div>
          ) : null}
          <header className="grid gap-10 border-b border-[var(--border-new)] pb-9 lg:grid-cols-[1.4fr_1fr] lg:items-end">
            <div>
              <button onClick={() => setActivePage("app")} className="mb-3 text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)] hover:text-[var(--text-2-new)]">← Back to dashboard</button>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">AI multi builder · Beta preview</p>
              <h1 className="mt-3.5 text-[40px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[52px]">
                MultiPick.<br />Form-backed multis.
              </h1>
              <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[var(--text-2-new)]">A smarter way to build structured example multis using market lines, recent trends and risk scoring.</p>
              {/* Subscription state — small inline pill below the subtitle, not
                  a big bordered card. Free-tier users see a tiny 'X of N
                  builds left' link; Pro users see a thin 'Manage subscription'
                  link. The marketing/disclaimer cards moved out of the header —
                  the 'What is MultiPick' explainer + Important disclaimer now
                  live in the Disclaimer page; users land on the controls and
                  output immediately, not on copy. */}
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--text-3-new)]">
                {entitlement.subscribed ? (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--positive-soft-new)] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--positive-new)]">Pro · unlimited</span>
                    <button
                      type="button"
                      onClick={startManageBilling}
                      disabled={openingPortal}
                      className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--text-2-new)] disabled:opacity-50"
                    >
                      {openingPortal ? "Opening…" : "Manage subscription"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-[11px] uppercase tracking-[0.06em]">
                      {gatedNow ? "Out of free builds" : `${buildsLeft} of ${entitlement.limit} free builds left`}
                    </span>
                    <button type="button" onClick={startUpgrade} disabled={upgrading} className="rounded-full bg-[var(--accent-new)] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--bg-new)] transition-opacity hover:opacity-90 disabled:opacity-50">
                      {upgrading ? "Starting…" : "Go Pro"}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="hidden">
              {/* Original right-rail warning + 'Live AFL data' badge removed —
                  the Disclaimer/Important copy now lives on the Disclaimer
                  page only, and the AFL-data badge was just decoration. */}
            </div>
          </header>

          {/* Model track record — Option B: simplified 3-cell strip (actual /
              predicted / typical gap), well-calibrated pill, "view detail"
              link. The link opens a modal with the bucket-by-bucket breakdown
              for users who want the math. Keeps the casual-user view clean. */}
          {calibration && calibration.resolved >= 10 && calibration.overall ? (() => {
            const overall = calibration.overall;
            const gap = Math.abs(Number(overall.predicted || 0) - Number(overall.actual || 0));
            const wellCalibrated = gap <= 5;
            return (
              <section className="mb-8 border-b border-[var(--border-new)] pb-8">
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Model track record</p>
                <h2 className="brand-wordmark mt-2 text-[22px] font-semibold tracking-[-0.025em] text-[var(--text-new)] md:text-[26px]">
                  MultiPick's last <span className="mono-nums">{overall.n}</span> picks<span className="text-[var(--accent-new)]">.</span>
                </h2>
                <div className="mt-6 grid grid-cols-3 border-y border-[var(--border-new)] py-6">
                  <div className="pr-4 md:pr-7">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Actual hit rate</div>
                    <div className="mono-nums mt-3 text-[40px] font-semibold leading-none tracking-[-0.04em] text-[var(--positive-new)] md:text-[56px]">{overall.actual}%</div>
                    <div className="mt-3 text-[10px] text-[var(--text-3-new)] md:text-[11px]">
                      <span className="mono-nums">{Math.round((overall.n * overall.actual) / 100)}</span> of <span className="mono-nums">{overall.n}</span> legs hit their line
                    </div>
                  </div>
                  <div className="border-l border-[var(--border-new)] px-4 md:px-7">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">What we predicted</div>
                    <div className="mono-nums mt-3 text-[24px] font-semibold leading-none tracking-[-0.03em] text-[var(--text-new)] md:text-[30px]">{overall.predicted}%</div>
                    <div className="mt-3 text-[10px] text-[var(--text-3-new)] md:text-[11px]">Average confidence rating</div>
                  </div>
                  <div className="border-l border-[var(--border-new)] pl-4 md:pl-7">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Typical gap</div>
                    <div className="mono-nums mt-3 text-[24px] font-semibold leading-none tracking-[-0.03em] text-[var(--text-2-new)] md:text-[30px]">±{gap}%</div>
                    <div className="mt-3 text-[10px] text-[var(--text-3-new)] md:text-[11px]">Distance between prediction and reality</div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {wellCalibrated ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--positive-soft-new)] px-3 py-1.5 text-[11px] font-medium text-[var(--positive-new)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--positive-new)]" /> Well calibrated
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--warning-soft-new)] px-3 py-1.5 text-[11px] font-medium text-[var(--warning-new)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning-new)]" /> Calibrating
                    </span>
                  )}
                  <span className="text-[11px] text-[var(--text-3-new)]">Last 30 days · weekly refresh</span>
                  <button
                    type="button"
                    onClick={() => setCalibrationDetailOpen(true)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--border-new)] bg-[var(--surface-new)] px-3.5 py-1.5 text-[11px] font-medium text-[var(--text-2-new)] transition-colors hover:border-[var(--border-strong-new)] hover:text-[var(--text-new)]"
                  >
                    View calibration detail <span className="text-[var(--text-3-new)]">→</span>
                  </button>
                </div>
              </section>
            );
          })() : null}

          {/* Calibration detail modal — opens when user clicks the link above.
              Plain-English explanation + bucket-by-bucket table with hairline
              rows. Renders via portal at document.body so it overlays
              everything cleanly. */}
          {calibration && calibrationDetailOpen ? createPortal(
            (
              <div
                className="stat-modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md sm:p-6 md:p-10"
                onClick={() => setCalibrationDetailOpen(false)}
                role="dialog"
                aria-modal="true"
                aria-label="Calibration detail"
              >
                <div
                  className="stat-modal-card relative flex max-h-[92vh] w-full max-w-[760px] flex-col overflow-hidden rounded-3xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] shadow-[0_30px_90px_rgba(0,0,0,0.7)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Header */}
                  <div className="flex items-start justify-between gap-6 border-b border-[var(--border-new)] px-7 pt-7 pb-5 md:px-9 md:pt-9 md:pb-6">
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Model track record · detail</div>
                      <div className="brand-wordmark mt-2 text-[22px] font-semibold tracking-[-0.025em] text-[var(--text-new)] md:text-[26px]">How our ratings have held up</div>
                      <div className="mt-2 max-w-[480px] text-[12.5px] leading-relaxed text-[var(--text-2-new)]">
                        When MultiPick says a leg has X% chance of hitting, how often does it actually hit? Closer numbers = more trustworthy ratings.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCalibrationDetailOpen(false)}
                      aria-label="Close"
                      className="shrink-0 rounded-full border border-[var(--border-new)] bg-[var(--surface-2-new)] px-3.5 py-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-2-new)] transition-colors hover:border-[var(--border-strong-new)] hover:text-[var(--text-new)]"
                    >
                      Close ✕
                    </button>
                  </div>

                  {/* Scrollable body */}
                  <div className="flex-1 overflow-y-auto px-7 py-6 md:px-9 md:py-7">
                    <div className="mb-6 rounded-xl border border-[var(--accent-new)]/20 bg-[var(--accent-soft-new)] p-4 text-[12.5px] leading-relaxed text-[var(--text-2-new)]">
                      <span className="font-semibold text-[var(--text-new)]">Quick read:</span> each row groups legs by what MultiPick predicted. The bar shows the actual hit rate; the small marker shows what we said. When they line up, the model's confidence numbers can be trusted at face value.
                    </div>

                    {/* Bucket table — hairline rows */}
                    <div className="grid grid-cols-[110px_1fr_70px_50px] items-center gap-4 pb-3 text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">
                      <div>Confidence band</div>
                      <div>Actual hit rate · | = our prediction</div>
                      <div className="text-right">Hit</div>
                      <div className="text-right">N</div>
                    </div>
                    {calibration.buckets.map((bucket) => {
                      const predictedPct = bucket.predicted != null ? bucket.predicted : (() => {
                        // Fall back to the bucket midpoint if predicted isn't on the row
                        const m = String(bucket.label || "").match(/(\d+)\s*-\s*(\d+)/);
                        return m ? (Number(m[1]) + Number(m[2])) / 2 : 50;
                      })();
                      const gapPP = Math.abs(predictedPct - bucket.actual);
                      const tone = gapPP <= 5 ? "ok" : "off";
                      return (
                        <div key={bucket.label} className="grid grid-cols-[110px_1fr_70px_50px] items-center gap-4 border-t border-[var(--border-new)] py-3.5">
                          <div className="text-[13px] text-[var(--text-2-new)]">Rated {bucket.label}</div>
                          <div className="relative h-1.5 rounded-full bg-[var(--surface-2-new)]">
                            <div
                              className={"absolute inset-y-0 left-0 rounded-full " + (tone === "ok" ? "bg-[var(--positive-new)]" : "bg-[var(--warning-new)]")}
                              style={{ width: `${Math.min(100, Math.max(2, bucket.actual))}%` }}
                            />
                            <div className="absolute -top-1 -bottom-1 w-[1.5px] bg-[var(--text-2-new)]" style={{ left: `${Math.min(100, predictedPct)}%` }} />
                          </div>
                          <div className={"mono-nums text-right text-[13px] font-semibold " + (tone === "ok" ? "text-[var(--positive-new)]" : "text-[var(--warning-new)]")}>{bucket.actual}%</div>
                          <div className="mono-nums text-right text-[11px] text-[var(--text-3-new)]">{bucket.n}</div>
                        </div>
                      );
                    })}

                    <p className="mt-6 text-[11.5px] leading-relaxed text-[var(--text-3-new)]">
                      <span className="font-semibold text-[var(--text-2-new)]">How to read this:</span> bars close to the marker = well-calibrated. Bands sit amber when the model's confidence is more than 5 percentage points off the actual hit rate — we surface it honestly so the calibration block stays trustworthy.
                    </p>
                  </div>
                </div>
              </div>
            ),
            document.body
          ) : null}

          <section className="grid items-start gap-12 lg:grid-cols-[460px_1fr]">
            <div className="min-w-0 space-y-5">
              {/* Controls — bare-underline editorial. No Card wrapper, no
                  cream backgrounds. Mode pill at top, fields stack below. */}
              <div className="grid grid-cols-2 rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] p-1 text-[12px] font-medium">
                <button onClick={() => setMode("multi")} className={"rounded px-3 py-2 transition-colors " + (mode === "multi" ? "bg-[var(--text-new)] text-[var(--bg-new)] font-semibold" : "text-[var(--text-3-new)] hover:text-[var(--text-2-new)]")}>Example Multi</button>
                <button onClick={() => setMode("analysis")} className={"rounded px-3 py-2 transition-colors " + (mode === "analysis" ? "bg-[var(--text-new)] text-[var(--bg-new)] font-semibold" : "text-[var(--text-3-new)] hover:text-[var(--text-2-new)]")}>Game Analysis</button>
              </div>

                {mode === "multi" ? (
                    /* Card-style builder — games scroller (multi-select) + compact
                       controls, matching the dashboard mini-builder, on all sizes. */
                    <div className="max-w-[460px] space-y-3.5">
                      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 snap-x [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                        {!games.length ? (
                          <div className="w-full rounded-xl border border-dashed border-[var(--border-new)] px-3 py-4 text-center text-[12px] text-[var(--text-3-new)]">No upcoming {sport} games right now — build across the slate below.</div>
                        ) : games.map((game) => {
                          const selected = selectedGameIds.includes(game.id);
                          return (
                            <button
                              key={game.id}
                              type="button"
                              onClick={() => setSelectedGameIds((prev) => prev.includes(game.id) ? prev.filter((id) => id !== game.id) : [...prev, game.id])}
                              className={"relative snap-start shrink-0 w-[150px] rounded-xl border p-2.5 text-center transition-colors " + (selected ? "border-[var(--accent-new)] bg-[var(--accent-soft-new)]" : "border-[var(--border-new)] bg-[var(--surface-new)] hover:border-[var(--border-strong-new)]")}
                            >
                              {selected ? <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent-new)] text-[10px] font-bold leading-none text-[var(--bg-new)]">✓</span> : null}
                              <div className="mb-2 flex justify-center"><span className="rounded-full bg-[var(--surface-2-new)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-[var(--text-2-new)]">{timeUntilGame(game.commenceTime)}</span></div>
                              <div className="flex items-center justify-center gap-1.5">
                                <div className="flex flex-1 flex-col items-center gap-1"><TeamCrest team={game.homeTeam} className="h-7 w-7" /><span className="text-[10px] font-semibold text-[var(--text-new)]">{teamShort(game.homeTeam)}</span></div>
                                <span className="text-[10px] font-bold text-[var(--text-3-new)]">VS</span>
                                <div className="flex flex-1 flex-col items-center gap-1"><TeamCrest team={game.awayTeam} className="h-7 w-7" /><span className="text-[10px] font-semibold text-[var(--text-new)]">{teamShort(game.awayTeam)}</span></div>
                              </div>
                              <div className="mt-2 text-[9.5px] text-[var(--text-3-new)]">{gameKickoff(game.commenceTime)}</div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {[
                          { label: "Sport", value: sport, set: setSport, options: ["AFL", "NBA"] },
                          { label: "Legs", value: legs, set: setLegs, options: ["Any", "2", "3", "4", "5"] },
                          { label: "Odds", value: targetOdds, set: setTargetOdds, options: ["$1.50", "$2.00", "$3.00", "$5.00", "Custom"] },
                          { label: "Risk", value: riskProfile, set: setRiskProfile, options: ["Safer", "Balanced", "Aggressive", "Best Chance"] },
                        ].map((ctrl) => (
                          <label key={ctrl.label} className="flex flex-col gap-1">
                            <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">{ctrl.label}</span>
                            <select value={ctrl.value} onChange={(event) => ctrl.set(event.target.value)} className="cursor-pointer rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none focus:border-[var(--text-new)]">
                              {ctrl.options.map((option) => <option key={option} value={option}>{option}</option>)}
                            </select>
                          </label>
                        ))}
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">Bookmaker</span>
                        <select value={bookmaker} onChange={(event) => setBookmaker(event.target.value)} className="cursor-pointer rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none focus:border-[var(--text-new)]">
                          <option value="">Best available</option>
                          <option value="sportsbet">Sportsbet</option>
                          <option value="tab">TAB</option>
                          <option value="ladbrokes_au">Ladbrokes</option>
                          <option value="neds">Neds</option>
                          <option value="pointsbetau">PointsBet</option>
                          <option value="unibet">Unibet</option>
                        </select>
                      </label>
                      {targetOdds === "Custom" ? (
                        <label className="flex flex-col gap-1">
                          <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">Custom target odds</span>
                          <input type="number" min="1" step="0.01" inputMode="decimal" value={customTargetOdds} onChange={(event) => setCustomTargetOdds(event.target.value)} placeholder="e.g. 4.50" className="rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none focus:border-[var(--text-new)] placeholder:text-[var(--text-3-new)]" />
                        </label>
                      ) : null}
                      <label className="flex flex-col gap-1">
                        <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">Optional request</span>
                        <input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Disposals only, no same-game legs" className="rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none focus:border-[var(--text-new)] placeholder:text-[var(--text-3-new)]" />
                      </label>
                      <button
                        onClick={() => previewMulti({ gameIds: selectedGameIds })}
                        disabled={edgeLoading}
                        className="w-full rounded-md bg-[var(--accent-new)] py-3.5 text-[13px] font-bold uppercase tracking-[0.06em] text-[var(--bg-new)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {edgeLoading ? "Building…" : selectedGameIds.length >= 2 ? `Build · ${selectedGameIds.length} games` : "Build multi"}
                      </button>
                    </div>
                ) : (
                  <div className="mt-6 space-y-5">
                    <EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NBA"]} />
                    <EdgeSelectField label="Game" value={selectedGameId} onChange={setSelectedGameId} options={[{ label: games.length ? "Select upcoming game" : "Loading games…", value: "" }, ...games.map((game) => ({ label: game.label, value: game.id }))]} />
                    <label className="space-y-1 text-sm font-medium">Focus area<Input value="Form, market read, key players & value" readOnly /></label>
                    <div className="pt-2"><Button onClick={previewAnalysis} disabled={edgeLoading || !selectedGameId} className="w-full rounded-2xl py-3 text-base">{edgeLoading ? "Analysing..." : "Preview game analysis"}</Button></div>
                  </div>
                )}

            {/* MultiPick performance block — sits below the controls on the
                left rail. Shows lifetime stats for multis built with the AI
                (multis picked, won/loss split, P/L, ROI). Editorial Layout B
                styling: tiny eyebrow + 2-up hairline grid + mono numerals. */}
            {gridBuildStats && gridBuildStats.count > 0 ? (
              <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-5">
                <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">MultiPick performance</p>
                <p className="mt-1 text-[13px] text-[var(--text-2-new)]">How your saved AI multis have actually gone.</p>
                <div className="mt-4 grid grid-cols-2 gap-y-4">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Multis picked</div>
                    <div className="mt-1 mono-nums text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{gridBuildStats.count}</div>
                  </div>
                  <div className="border-l border-[var(--border-new)] pl-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Won / Lost</div>
                    <div className="mt-1 mono-nums text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">
                      <span className="text-[var(--positive-new)]">{gridBuildStats.wins}</span>
                      <span className="text-[var(--text-3-new)]"> / </span>
                      <span className="text-[var(--danger-new)]">{Math.max(0, gridBuildStats.completed - gridBuildStats.wins)}</span>
                    </div>
                  </div>
                  <div className="border-t border-[var(--border-new)] pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Profit / loss</div>
                    <div className={"mt-1 mono-nums text-[22px] font-semibold tracking-[-0.02em] leading-none " + (gridBuildStats.profit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{fmtMoney(gridBuildStats.profit)}</div>
                  </div>
                  <div className="border-l border-t border-[var(--border-new)] pl-4 pt-4">
                    <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">ROI</div>
                    <div className={"mt-1 mono-nums text-[22px] font-semibold tracking-[-0.02em] leading-none " + (gridBuildStats.roi == null ? "text-[var(--text-3-new)]" : gridBuildStats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>
                      {gridBuildStats.roi == null ? "—" : `${gridBuildStats.roi >= 0 ? "+" : ""}${gridBuildStats.roi.toFixed(1)}%`}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--border-new)] bg-[var(--surface-new)] p-5">
                <p className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">MultiPick performance</p>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)]">Save your first MultiPick build to your bet tracker and the performance numbers will appear here once they settle.</p>
              </div>
            )}
            </div>

            <div className="min-w-0 space-y-6" ref={outputPanelRef}>
              {analysisOutput || analyzing ? (
                <GameAnalysisOutput analysis={analysisOutput} loading={analyzing} />
              ) : (
              /* NEW 2026 minimalist build-output card — replaces the old Card.
                 Tokens are in index.css under "2026 minimalist refresh".
                 Old version preserved in src/App.legacy.jsx. */
              <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--bg-new)] overflow-hidden">
                <div className="p-4 md:p-8">
                  {/* Editorial header — eyebrow on the left, meta on the
                      right, like the preview. */}
                  <div className="flex items-start justify-between gap-4 border-b border-[var(--border-new)] pb-5">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.10em] font-medium text-[var(--text-3-new)]">MultiPick output</p>
                      <h2 className="mt-2 text-[22px] md:text-[26px] font-medium tracking-[-0.02em] text-[var(--text-new)]">
                        {buildingMulti
                          ? <>Building your {sport} multi<span className="text-[var(--accent-new)]">.</span></>
                          : multiOutput
                          ? <>{multiOutput.legCount}-leg {multiOutput.sport} multi {multiOutput.game ? <span className="text-[var(--text-2-new)]"> · {multiOutput.game}</span> : null}</>
                          : <>Example {displayedLegs}-leg {sport} multi</>}
                      </h2>
                    </div>
                    {multiOutput ? (
                      <p className="text-right text-xs text-[var(--text-3-new)] whitespace-nowrap">
                        Built {multiOutput.builtAgo || "just now"}
                        {multiOutput.bookmakerLabel ? <> · {multiOutput.bookmakerLabel}</> : null}
                      </p>
                    ) : null}
                  </div>
                  {buildingMulti ? (
                    <BuildingAnimation />
                  ) : (
                  <div className="multi-reveal">
                  <p className="mt-4 text-sm text-[var(--text-2-new)]" style={{ display: "none" }}>
                    {multiOutput
                      ? <>Real form × current odds. Refine in chat below.</>
                      : <>The example is illustrative. Click <span className="text-[var(--text-new)] font-medium">Build multi</span> to build from real {sport} stats and current market lines.</>}
                  </p>

                  {/* Plain-English read (Style C) — colour-coded pills that
                      translate the stat strip below into a glance. Real builds only. */}
                  {multiOutput && plainMultiPills(multiOutput).length ? (
                    <div className="reveal-part mt-6 flex flex-wrap gap-2.5" style={{ animationDelay: "0.02s" }}>
                      {plainMultiPills(multiOutput).map((pill) => (
                        <div
                          key={pill.label}
                          className={"rounded-xl border border-[var(--border-new)] px-3.5 py-2.5 " + (pill.tone === "green" ? "bg-[var(--positive-soft-new)]" : pill.tone === "amber" ? "bg-[var(--warning-soft-new)]" : "bg-[var(--surface-new)]")}
                        >
                          <div className="text-[8.5px] font-semibold uppercase tracking-[0.1em] text-[var(--text-3-new)]">{pill.label}</div>
                          <div className={"brand-wordmark mt-1 text-[14px] font-bold tracking-[-0.01em] " + (pill.tone === "green" ? "text-[var(--positive-new)]" : pill.tone === "amber" ? "text-[var(--warning-new)]" : "text-[var(--text-new)]")}>{pill.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Editorial stat strip — Layout B. Hairline borders only,
                      massive 44px mono numerals on Combined, 28px on others. */}
                  <div className="reveal-part mt-7 grid grid-cols-2 md:grid-cols-4 gap-y-7 gap-x-0 border-b border-[var(--border-new)] py-7 md:py-9" style={{ animationDelay: "0.05s" }}>
                    <div className="md:pr-7 md:border-r md:border-[var(--border-new)]">
                      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)] font-medium">Combined</div>
                      <div className="mt-3.5 mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">${multiOutput ? formatOdds(multiOutput.combinedOdds) : displayedTargetOdds.replace("$", "")}</div>
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{(() => {
                        if (!multiOutput) return "Target";
                        // parseFloat returns NaN for un-parseable strings, which is falsy
                        // when used with !target, so no need for a separate gate. Previously
                        // we had `parseOddsValue ? parseFloat(...) : null` referencing an
                        // undefined symbol — ReferenceError crashed the page on Build multi.
                        const target = parseFloat(String(displayedTargetOdds).replace(/[^0-9.]/g, ""));
                        const combined = Number(multiOutput.combinedOdds);
                        if (!target || !combined) return `Target ${displayedTargetOdds}`;
                        const closeness = Math.abs((combined - target) / target * 100);
                        return <>Target <span className="mono-nums">{displayedTargetOdds}</span> · within <span className="mono-nums">{closeness.toFixed(1)}%</span></>;
                      })()}</div>
                    </div>
                    <div className="md:px-7 md:border-r md:border-[var(--border-new)]">
                      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)] font-medium">Combined chance</div>
                      <div className="mt-3.5 mono-nums text-[26px] md:text-[28px] font-semibold tracking-[-0.025em] leading-none text-[var(--text-new)]">{multiOutput ? `${multiOutput.combinedProbPct}%` : "—"}</div>
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{multiOutput && multiOutput.correlated && typeof multiOutput.independentProbPct === "number" ? `Adjusted vs ${multiOutput.independentProbPct}% independent` : "Correlation-adjusted"}</div>
                    </div>
                    <div className="md:px-7 md:border-r md:border-[var(--border-new)]">
                      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)] font-medium">Value vs market</div>
                      <div className={"mt-3.5 mono-nums text-[26px] md:text-[28px] font-semibold tracking-[-0.025em] leading-none " + (multiOutput && multiOutput.evPct > 0 ? "text-[var(--accent-new)]" : "text-[var(--text-2-new)]")}>
                        {multiOutput && typeof multiOutput.evPct === "number" ? `${multiOutput.evPct > 0 ? "+" : ""}${multiOutput.evPct}%` : "—"}
                      </div>
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{multiOutput && typeof multiOutput.evPct === "number"
                        ? (multiOutput.evPct > 0
                            ? `${multiOutput.valueLegs} of ${multiOutput.legCount} +edge`
                            : `Below fair value${multiOutput.sameGameNote ? " · same-game discount applied" : ""}`)
                        : "Form vs odds"}</div>
                    </div>
                    <div className="md:pl-7">
                      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)] font-medium">Risk</div>
                      <div className="mt-3.5 mono-nums text-[26px] md:text-[28px] font-semibold tracking-[-0.025em] leading-none text-[var(--warning-new)]">{multiOutput ? multiOutput.risk : 6}<span className="text-sm text-[var(--text-3-new)] font-normal"> / 10</span></div>
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{(multiOutput?.risk ?? 6) <= 3 ? "Conservative" : (multiOutput?.risk ?? 6) <= 6 ? "Balanced exposure" : "Higher variance"}</div>
                    </div>
                  </div>

                  {/* Notes (SGM / odds / bookmaker) — left-bordered slab style */}
                  {multiOutput?.sameGameNote ? (
                    <div className="mt-4 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}>
                      <span className="text-[var(--text-new)] font-medium">Same-game caveat.</span> {multiOutput.sameGameNote}
                    </div>
                  ) : null}
                  {multiOutput?.oddsNote ? (
                    <div className="mt-3 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}>
                      {multiOutput.oddsNote}
                    </div>
                  ) : null}
                  {multiOutput?.profileNote ? (
                    <div className="mt-3 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}
                         dangerouslySetInnerHTML={{ __html: multiOutput.profileNote.replace(/\*\*(.+?)\*\*/g, '<span class="text-[var(--text-new)] font-medium">$1</span>') }} />
                  ) : null}
                  {multiOutput?.bookmakerNote ? (
                    <div className="mt-3 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}>
                      {multiOutput.bookmakerNote}
                    </div>
                  ) : null}
                  {multiOutput?.cushionNote ? (
                    <div className="mt-3 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}>
                      <span className="text-[var(--text-new)] font-medium">Cushion floor.</span> {multiOutput.cushionNote}
                    </div>
                  ) : null}

                  {edgeLoading ? (
                    <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)] px-4 py-3 text-sm text-[var(--text-2-new)]">
                      <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--border-strong-new)] border-t-[var(--text-new)]" />
                      <span>Crunching live odds, recent form and market lines…</span>
                    </div>
                  ) : null}

                  {/* Legs section header — matches preview B exactly */}
                  <div className="mt-9 mb-4 flex items-baseline justify-between border-b border-[var(--border-new)] pb-3">
                    <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Legs</div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Tap a row for full form breakdown</div>
                  </div>

                  {/* Legs — vertical rows with hair-thin dividers */}
                  {/* Legs list — Layout B preview style: NO card backgrounds.
                      Each row is just hairline-divided. Cleaner editorial feel. */}
                  <div className="divide-y divide-[var(--border-new)]">
                    {(multiOutput?.legs || exampleLegs).map((leg, index) => (
                      <EdgeLegRow
                        key={`${leg.name}-${index}`}
                        leg={leg}
                        index={index}
                        sportContext={multiOutput?.sport || sport}
                      />
                    ))}
                  </div>

                  {/* Risk meter slab */}
                  <div className="mt-6 rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] px-5 py-4 flex items-center gap-5">
                    <div className="mono-nums text-[26px] font-semibold tracking-[-0.02em] leading-none text-[var(--warning-new)]">
                      {multiOutput ? multiOutput.risk : 6}<span className="text-sm text-[var(--text-3-new)] font-normal"> / 10</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-new)]">Overall risk score</div>
                      <div className="text-xs text-[var(--text-3-new)]">{(multiOutput?.risk ?? 6) <= 3 ? "Lower variance — fewer/safer legs" : (multiOutput?.risk ?? 6) <= 6 ? "Balanced exposure" : "Higher variance — longer odds or more legs"}</div>
                      <div className="mt-2.5 h-1 bg-[var(--bg-new)] rounded-full overflow-hidden">
                        <div className="h-full rounded-full risk-gradient-fill" style={{ width: `${Math.min(100, ((multiOutput?.risk ?? 6) / 10) * 100)}%` }}></div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowRiskExplanation((c) => !c)}
                      className="text-xs text-[var(--text-2-new)] hover:text-[var(--text-new)] transition-colors whitespace-nowrap"
                    >
                      {showRiskExplanation ? "Hide" : "Why?"}
                    </button>
                  </div>
                  {showRiskExplanation ? (
                    <div className="mt-3 rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4 text-sm leading-6 text-[var(--text-2-new)]">
                      {multiOutput
                        ? multiOutput.riskExplanation
                        : "A 6/10 preview score reflects a balanced multi with multiple legs and player-market variance. The live version will calculate this from odds, markets, leg count and data confidence."}
                    </div>
                  ) : null}

                  {/* Track this multi */}
                  {multiOutput ? (
                    <div className="mt-6 rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-5">
                      <div className="text-sm font-medium text-[var(--text-new)]">Track this multi</div>
                      <div className="mt-1 text-xs text-[var(--text-3-new)]">Save to tracker as a pending bet — settle it on the dashboard after the games.</div>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Stake (e.g. 20)"
                          value={betStake}
                          onChange={(event) => setBetStake(event.target.value)}
                          className="sm:max-w-[160px] mono-nums"
                        />
                        <button
                          type="button"
                          onClick={addMultiToBets}
                          disabled={savingBet}
                          className="rounded-lg bg-[var(--accent-new)] text-[var(--bg-new)] font-semibold text-sm px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
                        >
                          {savingBet ? "Saving…" : "Add to my bets"}
                        </button>
                      </div>
                      {Number(betStake) > 0 && multiOutput.combinedOdds ? (
                        <div className="mt-3 text-xs text-[var(--text-2-new)]">
                          <span className="mono-nums">{formatCurrency(Number(betStake))}</span> returns{" "}
                          <span className="mono-nums font-semibold text-[var(--positive-new)]">{formatCurrency(Number(betStake) * multiOutput.combinedOdds)}</span> at{" "}
                          <span className="mono-nums">${formatOdds(multiOutput.combinedOdds)}</span> ·{" "}
                          <span className="mono-nums">{formatCurrency(Number(betStake) * multiOutput.combinedOdds - Number(betStake))}</span> profit
                        </div>
                      ) : null}
                      {saveBetMsg ? <div className="mt-2 text-xs font-medium text-[var(--text-new)]">{saveBetMsg}</div> : null}
                    </div>
                  ) : null}
                  </div>
                  )}
                </div>
              </div>
              )}
            </div>
          </section>

          <div ref={chatSectionRef}><Card>
            <div className="p-5 md:p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <p className="text-sm font-medium text-slate-500">Chat with MultiPick</p>
                  <h2 className="text-xl font-semibold">Refine the build naturally</h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={resetEdgeChat}>New chat</Button>
                  <Button type="button" variant="ghost" onClick={clearEdgeChat}>Clear chat</Button>
                  <span className="rounded-full bg-[#11203B] px-3 py-2 text-xs font-semibold text-white">{sport === "AFL" ? "Live AFL data" : "Preview mode"}</span>
                </div>
              </div>
              {chatMessages.length === 0 ? (
                <div className="mt-5 rounded-2xl border border-slate-200 bg-[#FAF7EF]/70 p-4">
                  <p className="text-sm font-semibold text-[#11203B]">Try MultiPick</p>
                  <p className="mt-1 text-sm text-slate-600">Choose a starter prompt or type your own question below.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => useExamplePrompt(`Build a ${displayedLegs}-leg ${sport} example multi around ${displayedTargetOdds}. Keep it simple and explain the risk.`)} className="rounded-full border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium text-[#11203B] hover:bg-white/70">Build example multi</button>
                    <button type="button" onClick={() => useExamplePrompt(`Make the ${sport} example ${request || "disposals only"} and explain what data you would check.`)} className="rounded-full border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium text-[#11203B] hover:bg-white/70">Use my request</button>
                    <button type="button" onClick={() => useExamplePrompt(`Explain why this ${sport} build has a 6 out of 10 risk score.`)} className="rounded-full border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium text-[#11203B] hover:bg-white/70">Explain risk score</button>
                    <button type="button" onClick={() => useExamplePrompt(`What data would you check before choosing players for this ${sport} build?`)} className="rounded-full border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium text-[#11203B] hover:bg-white/70">What data to check?</button>
                  </div>
                </div>
              ) : null}
              <div className="mt-5 space-y-3">
                {chatMessages.map((chatMessage, index) => <EdgeMessage key={index} role={chatMessage.role}>{chatMessage.text}</EdgeMessage>)}
              </div>
              {multiOutput ? (
                <div className="mt-5">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Edit this build</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[
                      { label: "Swap the weakest leg", prompt: "Swap the weakest leg for a better option." },
                      { label: "Add a leg", prompt: "Add another leg to the multi." },
                      { label: "Make it safer", prompt: "Make it safer." },
                      { label: "Longer odds", prompt: "Give it longer odds." },
                    ].map((chip) => (
                      <button key={chip.label} type="button" onClick={() => sendChatMessage(chip.prompt)} disabled={edgeLoading} className="rounded-full border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium text-[#11203B] transition hover:bg-white/70 disabled:opacity-50">{chip.label}</button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder={multiOutput ? "Refine your build — e.g. ‘swap leg 2’, ‘make it safer’, ‘around $3’" : "Ask MultiPick a follow-up..."} onKeyDown={(event) => { if (event.key === "Enter") sendChatMessage(); }} disabled={edgeLoading} />
                <Button onClick={() => sendChatMessage()} className="sm:px-6" disabled={edgeLoading}>{edgeLoading ? "Thinking..." : "Send"}</Button>
              </div>
            </div>
          </Card></div>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
      <MobileBottomNav activePage="edge" setActivePage={setActivePage} />
    </div>
  );
}

function LandingPage({ setActivePage, setAuthMode }) {
  const openAuth = (mode) => {
    setAuthMode(mode);
    setActivePage("auth");
  };

  // Live model-track-record numbers from /api/calibration. Public endpoint,
  // no auth required. We hide the section entirely until we have enough
  // resolved predictions to show meaningful numbers — better than a sparse
  // first impression.
  const [calibration, setCalibration] = useState(null);
  const [foundingSpotsLeft, setFoundingSpotsLeft] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/calibration")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.overall?.n >= 10) setCalibration(data);
      })
      .catch(() => {});
    // Founding-offer spots — no auth needed; /api/entitlement returns the count.
    fetch("/api/entitlement")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && typeof data?.foundingSpotsLeft === "number") setFoundingSpotsLeft(data.foundingSpotsLeft);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const founding = typeof foundingSpotsLeft === "number" && foundingSpotsLeft > 0;

  return (
    <div className="page-fade-in min-h-screen bg-[var(--bg-new)] text-[var(--text-new)]">
      <main className="px-5 pb-24 pt-6 sm:px-8 md:px-10 md:pt-8">
        <div className="mx-auto max-w-[1240px]">

          {/* ───────────────────── TOP NAV ─────────────────────
              Minimal — Pickd. wordmark left, Log in / Sign up right.
              No tabs since this is the logged-out marketing surface. */}
          <nav className="flex items-center justify-between border-b border-[var(--border-new)] pb-5">
            <button
              type="button"
              onClick={() => openAuth("signup")}
              className="brand-wordmark flex items-baseline leading-none"
              aria-label="Pickd home"
            >
              <span className="text-[22px] font-bold tracking-[-0.045em] text-[var(--text-new)]">Pickd</span>
              <span className="text-[22px] font-bold tracking-[-0.045em] text-[var(--accent-new)]">.</span>
            </button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => openAuth("login")} className="text-[12px] uppercase tracking-[0.08em]">Log in</Button>
              <Button onClick={() => openAuth("signup")} className="text-[12px] uppercase tracking-[0.08em]">Start free</Button>
            </div>
          </nav>

          {/* ───────────────────── HERO ─────────────────────
              Massive editorial wordmark. Mobile drops to 56px,
              desktop blows up to 128px. Sub-headline + dual CTA. */}
          <header className="relative border-b border-[var(--border-new)] pb-20 pt-16 sm:pt-20 md:pb-28 md:pt-28">
            {/* Subtle accent dot bg ornament */}
            <div className="pointer-events-none absolute right-0 top-12 hidden h-[400px] w-[400px] rounded-full bg-[var(--accent-new)] opacity-[0.04] blur-3xl md:block" />

            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--text-3-new)]">
              <span className="text-[var(--accent-new)]">●</span> AI multi builder · bet tracker · 2026
            </p>
            <h1 className="brand-wordmark mt-5 text-[56px] font-bold leading-[0.92] tracking-[-0.055em] sm:text-[80px] md:text-[112px]">
              <span className="block">Track every bet.</span>
              <span className="block">Read every result<span className="text-[var(--accent-new)]">.</span></span>
            </h1>
            <p className="mt-7 max-w-[540px] text-[15px] leading-[1.6] text-[var(--text-2-new)] md:text-[17px] md:leading-[1.55]">
              Form-backed multis from <span className="text-[var(--text-new)] font-medium">MultiPick</span> · Calibrated math, not vibes · A tracker that actually surfaces what's working. Built for people who'd rather understand their bets than chase tips.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button onClick={() => openAuth("signup")} className="w-full px-5 py-3 text-[14px] sm:w-auto">Start free →</Button>
              <Button variant="ghost" onClick={() => openAuth("login")} className="w-full px-5 py-3 text-[14px] sm:w-auto">I have an account</Button>
              <p className="ml-0 mt-1 text-[12px] text-[var(--text-3-new)] sm:ml-3 sm:mt-0">No card required · 18+ · Gamble responsibly</p>
            </div>

            {/* Quick trust badges */}
            <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--border-new)] pt-7 sm:grid-cols-4 md:gap-x-10">
              {[
                { eyebrow: "Backed by", value: "Real form data" },
                { eyebrow: "Sports", value: "AFL · NBA" },
                { eyebrow: "Not a", value: "Tipping service" },
                { eyebrow: "Built in", value: "Australia" },
              ].map((t) => (
                <div key={t.value}>
                  <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">{t.eyebrow}</div>
                  <div className="mt-1.5 text-[14px] font-medium text-[var(--text-new)] md:text-[15px]">{t.value}</div>
                </div>
              ))}
            </div>
          </header>

          {/* ─────────────── RECEIPTS / MODEL TRACK RECORD ───────────────
              Live calibration stats from /api/calibration. The actual hit
              rate vs the model's prediction is the radical-transparency
              differentiator vs other betting tools (no one shows their
              misses) — earn the section the most-prominent post-hero slot. */}
          {calibration?.overall ? (() => {
            const o = calibration.overall;
            const gap = Math.abs(Number(o.predicted || 0) - Number(o.actual || 0));
            const wellCalibrated = gap <= 5;
            const hitCount = Math.round((o.n * o.actual) / 100);
            return (
              <section className="border-b border-[var(--border-new)] py-20 md:py-28">
                <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-start lg:gap-16">
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">
                      <span className="text-[var(--accent-new)]">●</span> Receipts · Live track record
                    </p>
                    <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                      We log every leg.<br />
                      You see every miss<span className="text-[var(--accent-new)]">.</span>
                    </h2>
                    <p className="mt-5 max-w-[460px] text-[15px] leading-[1.6] text-[var(--text-2-new)]">
                      When MultiPick rates a leg <span className="text-[var(--text-new)] font-medium">80% likely</span>, it should hit ~80% of the time. We log every prediction and check it against the actual result. Below is our last <span className="mono-nums text-[var(--text-new)] font-medium">{o.n}</span> calls — no cherry-picking, no curated highlights. If we're not honest, you'll see it here first.
                    </p>
                    <div className="mt-7 flex flex-wrap items-center gap-3">
                      {wellCalibrated ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--positive-soft-new)] px-3 py-1.5 text-[11px] font-medium text-[var(--positive-new)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--positive-new)]" /> Well calibrated
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--warning-soft-new)] px-3 py-1.5 text-[11px] font-medium text-[var(--warning-new)]">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning-new)]" /> Calibrating
                        </span>
                      )}
                      <span className="text-[11px] text-[var(--text-3-new)]">Updates weekly · Every prediction included</span>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-7 md:p-9">
                    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--border-new)] pb-4">
                      <h3 className="brand-wordmark text-[18px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[20px]">
                        MultiPick<span className="text-[var(--accent-new)]">.</span> hit rate
                      </h3>
                      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">
                        Last <span className="mono-nums">{o.n}</span> picks
                      </span>
                    </div>
                    <div className="mt-6 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Actual hit rate</div>
                    <div className="mono-nums mt-4 text-[88px] font-semibold leading-[0.85] tracking-[-0.055em] text-[var(--positive-new)] md:text-[136px]">
                      {o.actual}%
                    </div>
                    <div className="mt-3 text-[12px] text-[var(--text-2-new)]">
                      <span className="mono-nums text-[var(--text-new)] font-medium">{hitCount}</span> of <span className="mono-nums text-[var(--text-new)] font-medium">{o.n}</span> legs hit their line
                    </div>
                    <div className="mt-7 grid grid-cols-2 border-t border-[var(--border-new)] pt-6">
                      <div className="pr-4">
                        <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">We predicted</div>
                        <div className="mono-nums mt-3 text-[28px] font-semibold leading-none tracking-[-0.03em] text-[var(--text-new)] md:text-[34px]">{o.predicted}%</div>
                        <div className="mt-2 text-[11px] text-[var(--text-3-new)]">Average confidence</div>
                      </div>
                      <div className="border-l border-[var(--border-new)] pl-4">
                        <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Gap</div>
                        <div className="mono-nums mt-3 text-[28px] font-semibold leading-none tracking-[-0.03em] text-[var(--text-2-new)] md:text-[34px]">±{gap}%</div>
                        <div className="mt-2 text-[11px] text-[var(--text-3-new)]">Prediction vs reality</div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            );
          })() : null}

          {/* ─────────────── DASHBOARD MOCK ───────────────
              Mirrors the actual app — stat strip + chart + recent form.
              Shows people exactly what they'll get. */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:gap-16">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">01 — Tracker</p>
                <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                  Your bets,<br />by the numbers.
                </h2>
                <p className="mt-5 max-w-[440px] text-[15px] leading-[1.6] text-[var(--text-2-new)]">
                  Profit/loss · win rate · ROI · in-flight exposure — at every cadence (week, month, year). Click any number to expand a full chart and summary. No spreadsheet manipulation, no Excel formulas.
                </p>
                <ul className="mt-7 space-y-3.5 text-[14px] leading-[1.55] text-[var(--text-2-new)]">
                  {[
                    "Cumulative P/L trajectory with running peak",
                    "Sport-by-sport breakdown — find your edge",
                    "Recent form streaks · win/loss heatmap",
                    "Calibration scoreboard — was your read correct?",
                  ].map((line) => (
                    <li key={line} className="flex gap-3">
                      <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--accent-new)]" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Live-ish stat strip mock (matches actual app exactly) */}
              <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-5 sm:p-7">
                <div className="mb-5 flex items-baseline justify-between">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Dashboard · April 2026</div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--accent-new)]">Live</div>
                </div>
                <div className="grid grid-cols-2 gap-x-5 gap-y-6 border-y border-[var(--border-new)] py-6 md:grid-cols-4">
                  {[
                    { label: "Profit / loss", value: "+$246.50", tone: "text-[var(--positive-new)]", sub: "▲ +$48 this week" },
                    { label: "Win rate", value: "58.3%", tone: "text-[var(--text-new)]", sub: "▲ +2.1pp mo/mo" },
                    { label: "Return on stake", value: "+12.8%", tone: "text-[var(--positive-new)]", sub: "$1,920 staked" },
                    { label: "In flight", value: "$84.00", tone: "text-[var(--text-new)]", sub: "3 pending · 2 tonight" },
                  ].map((s) => (
                    <div key={s.label}>
                      <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">{s.label}</div>
                      <div className={"mono-nums mt-2 text-[26px] font-semibold leading-none tracking-[-0.03em] " + s.tone}>{s.value}</div>
                      <div className="mt-2.5 text-[10px] text-[var(--text-3-new)]">{s.sub}</div>
                    </div>
                  ))}
                </div>
                {/* Mini cumulative chart */}
                <div className="mt-6">
                  <div className="mb-3 flex items-baseline justify-between text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">
                    <span>Cumulative P/L · 12 weeks</span>
                    <span className="text-[var(--positive-new)]">Trajectory ↗</span>
                  </div>
                  <svg viewBox="0 0 320 80" className="h-20 w-full">
                    <defs>
                      <linearGradient id="landingChartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4ade80" stopOpacity="0.30" />
                        <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path d="M0,60 L26,55 L52,58 L78,48 L104,52 L130,42 L156,38 L182,30 L208,33 L234,22 L260,18 L286,10 L320,8 L320,80 L0,80 Z" fill="url(#landingChartGrad)" />
                    <path d="M0,60 L26,55 L52,58 L78,48 L104,52 L130,42 L156,38 L182,30 L208,33 L234,22 L260,18 L286,10 L320,8" fill="none" stroke="#4ade80" strokeWidth="1.5" />
                  </svg>
                </div>
                {/* Recent form */}
                <div className="mt-6 border-t border-[var(--border-new)] pt-5">
                  <div className="mb-3 text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">Recent form · last 20</div>
                  <div className="flex flex-wrap gap-1.5">
                    {"WWLWWWWLWWLWWWLWWWWL".split("").map((r, i) => (
                      <div
                        key={i}
                        className={"h-5 w-5 rounded " + (r === "W" ? "bg-[var(--positive-new)]" : "bg-[var(--danger-new)]")}
                        style={{ opacity: r === "W" ? 0.85 : 0.7 }}
                      />
                    ))}
                  </div>
                  <div className="mt-3 flex gap-5 text-[11px] text-[var(--text-3-new)]">
                    <span>Wins <span className="mono-nums ml-1 text-[var(--positive-new)]">14</span></span>
                    <span>Losses <span className="mono-nums ml-1 text-[var(--danger-new)]">6</span></span>
                    <span>Strike rate <span className="mono-nums ml-1 text-[var(--text-2-new)]">70%</span></span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ─────────────── MULTIPICK ───────────────
              The killer feature. Editorial leg cards + value chip. */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="grid gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16">
              {/* MultiPick output mock */}
              <div className="order-2 rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-5 sm:p-7 lg:order-1">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">MultiPick output · Example</div>
                    <div className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em]">3-leg AFL multi</div>
                    <div className="mt-0.5 text-[11px] text-[var(--text-3-new)]">Geelong vs Carlton · 7:50pm</div>
                  </div>
                  <div className="shrink-0 rounded-xl border border-[var(--border-strong-new)] bg-[var(--surface-2-new)] px-3.5 py-2 text-right">
                    <div className="text-[9px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">Combined</div>
                    <div className="mono-nums mt-0.5 text-[22px] font-semibold leading-none">$2.12</div>
                    <div className="mt-1 text-[10px] text-[var(--text-3-new)]">~48% chance</div>
                  </div>
                </div>
                <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-[var(--positive-soft-new)] px-3 py-1.5 text-[11px] font-medium text-[var(--positive-new)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--positive-new)]" />
                  Value vs market <span className="mono-nums">+4%</span> · 2 of 3 legs positive edge
                </div>
                {/* Leg cards */}
                <div className="space-y-2.5">
                  {[
                    { team: "geelong", name: "M. Bontempelli — 25+ disposals", hit: "9/10", odds: "$1.38", conf: "79%", chip: "+7% value", up: true },
                    { team: "carlton", name: "C. Curnow — 1+ goals", hit: "8/10", odds: "$1.30", conf: "84%", chip: "+3% value", up: true },
                    { team: "geelong", name: "T. Stengle — 20+ disposals", hit: "8/10", odds: "$1.18", conf: "76%", chip: "−2% edge", up: false },
                  ].map((leg, i) => (
                    <div key={i} className="grid grid-cols-[24px_1fr_auto] items-center gap-3 border-t border-[var(--border-new)] py-3 first:border-t-0 first:pt-0">
                      <div className="mono-nums text-[10px] font-medium text-[var(--text-3-new)]">0{i + 1}</div>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--text-new)]">{leg.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-3-new)]">
                          <span>Hit <span className="mono-nums text-[var(--text-2-new)]">{leg.hit}</span> last 10</span>
                          <span>·</span>
                          <span>Conf <span className="mono-nums text-[var(--text-2-new)]">{leg.conf}</span></span>
                          <span className={"mono-nums ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium " + (leg.up ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]")}>{leg.chip}</span>
                        </div>
                      </div>
                      <div className="mono-nums text-[14px] font-semibold text-[var(--text-new)]">{leg.odds}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-5 border-t border-[var(--border-new)] pt-4 text-[10px] leading-[1.5] text-[var(--text-3-new)]">
                  Illustrative example with placeholder reads. Informational analysis only — not betting advice.
                </p>
              </div>

              <div className="order-1 lg:order-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">02 — MultiPick</p>
                <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                  Multis backed<br />by real form<span className="text-[var(--accent-new)]">.</span>
                </h2>
                <p className="mt-5 max-w-[440px] text-[15px] leading-[1.6] text-[var(--text-2-new)]">
                  MultiPick turns recent form, live market lines and a transparent edge model into example multis with honest +EV signals. Refine by chat — "swap leg 2", "make it safer", "around $3".
                </p>
                <ul className="mt-7 space-y-3.5 text-[14px] leading-[1.55] text-[var(--text-2-new)]">
                  {[
                    ["Real form", "Last-5 / last-10 hit rates from actual game logs"],
                    ["Edge math", "Each leg compared to the book's implied price"],
                    ["Correlation-aware", "Same-game legs priced honestly, not multiplied"],
                    ["Matchup-adjusted", "How the opponent concedes on each stat"],
                  ].map(([title, desc]) => (
                    <li key={title} className="grid grid-cols-[14px_1fr] gap-3">
                      <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--accent-new)]" />
                      <span><span className="font-medium text-[var(--text-new)]">{title}</span> — {desc}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-8">
                  <Button onClick={() => openAuth("signup")} className="w-full px-5 py-3 text-[14px] sm:w-auto">Try MultiPick — 3 free builds / week →</Button>
                </div>
              </div>
            </div>
          </section>

          {/* ─────────────── BETSLIP OCR ─────────────── */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:gap-16">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">03 — Quick add</p>
                <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                  Paste a screenshot.<br />We do the rest<span className="text-[var(--accent-new)]">.</span>
                </h2>
                <p className="mt-5 max-w-[440px] text-[15px] leading-[1.6] text-[var(--text-2-new)]">
                  Paste, drag-drop, or upload a betslip from any Australian bookmaker. AI vision reads the stake, odds and every leg — then pre-fills your Add Bet form. No manual entry.
                </p>
                <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[var(--text-3-new)]">
                  <span>· Sportsbet</span>
                  <span>· PointsBet</span>
                  <span>· TAB</span>
                  <span>· Ladbrokes</span>
                  <span>· Bet365</span>
                  <span>· Neds</span>
                  <span>· Unibet</span>
                </div>
              </div>
              {/* OCR mock */}
              <div className="rounded-2xl border border-dashed border-[var(--border-strong-new)] bg-[var(--surface-new)] p-7 sm:p-9">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Quick add · AI vision</div>
                <div className="mt-3 text-[15px] text-[var(--text-2-new)]">
                  <span className="font-medium text-[var(--text-new)]">Drop, paste, or upload a betslip screenshot</span> — we'll read the stake, odds and legs and fill the form for you.
                </div>
                <div className="mt-6 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3-new)]">
                  <kbd className="rounded border border-[var(--border-new)] bg-[var(--surface-2-new)] px-2 py-1 font-mono text-[10px]">⌘V</kbd>
                  <span>to paste</span>
                  <span className="mx-2">·</span>
                  <span>or click anywhere to upload</span>
                </div>
                {/* Mock parsed output preview */}
                <div className="mt-7 grid grid-cols-3 gap-3 border-t border-[var(--border-new)] pt-5">
                  <div>
                    <div className="text-[9px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">Stake</div>
                    <div className="mono-nums mt-1 text-[16px] font-semibold">$25.00</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">Odds</div>
                    <div className="mono-nums mt-1 text-[16px] font-semibold">$4.20</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase tracking-[0.10em] text-[var(--text-3-new)]">Legs</div>
                    <div className="mono-nums mt-1 text-[16px] font-semibold">3</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ─────────────── WHAT'S IN PICKD ───────────────
              Editorial feature manifest — confident, brand-only, no
              competitor names. Big numbers, mono labels, hairline rows. */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="max-w-[640px]">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">What's inside</p>
              <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                Everything in one place<span className="text-[var(--accent-new)]">.</span>
              </h2>
              <p className="mt-5 text-[15px] leading-[1.6] text-[var(--text-2-new)]">
                Tracker, multi builder, betslip OCR and calibrated analytics — engineered together so the data flows from input to decision without you copying and pasting.
              </p>
            </div>

            <div className="mt-12 grid divide-y divide-[var(--border-new)] border-y border-[var(--border-new)]">
              {[
                { num: "01", title: "Full bet tracker", desc: "Stake, odds, return, sport, bookmaker, notes — logged and analysed automatically." },
                { num: "02", title: "MultiPick AI multi builder", desc: "Form-backed multis with transparent edge math. Refine by chat. Honest +EV signals." },
                { num: "03", title: "Betslip OCR", desc: "Paste any bookmaker screenshot. Vision model reads stake, odds and every leg. No manual entry." },
                { num: "04", title: "Calibration scoreboard", desc: "Every prediction gets logged with model probability + outcome. The math is publicly verifiable." },
                { num: "05", title: "Multi-sport coverage", desc: "AFL and NBA at launch. Player props, line markets, head-to-head — all unified." },
                { num: "06", title: "Correlation-aware odds", desc: "Same-game legs priced honestly with pairwise correlation matrix, not naively multiplied." },
              ].map((item) => (
                <div key={item.num} className="grid grid-cols-[48px_1fr] items-baseline gap-5 py-5 md:grid-cols-[64px_1fr_2fr] md:gap-8 md:py-6">
                  <div className="mono-nums text-[12px] font-medium text-[var(--text-3-new)] md:text-[13px]">{item.num}</div>
                  <div className="brand-wordmark text-[16px] font-semibold tracking-[-0.02em] text-[var(--text-new)] md:text-[18px]">{item.title}</div>
                  <div className="col-start-2 text-[13px] leading-[1.55] text-[var(--text-2-new)] md:col-start-3 md:text-[14px]">{item.desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ─────────────── PRICING ─────────────── */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="max-w-[640px]">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Pricing</p>
              <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                Start free.<br />Upgrade when ready<span className="text-[var(--accent-new)]">.</span>
              </h2>
            </div>

            <div className="mt-12 grid gap-5 md:grid-cols-2">
              {/* Free tier */}
              <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-7 sm:p-8">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">Free</div>
                <div className="brand-wordmark mt-3 flex items-baseline gap-2">
                  <span className="mono-nums text-[48px] font-bold leading-none tracking-[-0.04em]">$0</span>
                  <span className="text-[12px] text-[var(--text-3-new)]">forever</span>
                </div>
                <p className="mt-4 text-[13px] leading-[1.55] text-[var(--text-2-new)]">Everything you need to start tracking, plus a taste of MultiPick.</p>
                <ul className="mt-6 space-y-3 text-[13px] text-[var(--text-2-new)]">
                  {["Unlimited bet tracking", "Full analytics dashboard", "Betslip OCR", "3 MultiPick builds / week", "AFL + NBA support"].map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--text-3-new)]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button variant="outline" onClick={() => openAuth("signup")} className="mt-7 w-full py-3 text-[14px]">Start free →</Button>
              </div>

              {/* Pro tier */}
              <div className="relative rounded-2xl border border-[var(--accent-new)] bg-[var(--surface-new)] p-7 sm:p-8">
                <div className="absolute -top-2.5 right-7 rounded-full bg-[var(--accent-new)] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.10em] text-[var(--bg-new)]">{founding ? "Founding offer" : "Best value"}</div>
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--accent-new)]">Pickd Pro</div>
                <div className="brand-wordmark mt-3 flex items-baseline gap-2">
                  <span className="mono-nums text-[48px] font-bold leading-none tracking-[-0.04em]">{founding ? "$4.99" : "$6.99"}</span>
                  {founding ? <span className="mono-nums text-[20px] font-medium text-[var(--text-3-new)] line-through">$6.99</span> : null}
                  <span className="text-[12px] text-[var(--text-3-new)]">/ week</span>
                </div>
                {founding ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft-new)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--accent-new)]">
                      First 20 · <span className="mono-nums">{foundingSpotsLeft}</span> spots left
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-new)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.10em] text-[var(--bg-new)]">
                      🔒 Locked in forever
                    </span>
                  </div>
                ) : null}
                <p className="mt-4 text-[13px] leading-[1.55] text-[var(--text-2-new)]">{founding ? "Founding members lock in $4.99/wk forever — the price never rises to $6.99 for you. Unlimited MultiPick + every feature." : "Unlimited MultiPick + every feature, with priority access to new sports."}</p>
                <ul className="mt-6 space-y-3 text-[13px] text-[var(--text-2-new)]">
                  {[
                    "Everything in Free",
                    "Unlimited MultiPick builds",
                    "Priority support",
                    "Early access to new sports",
                    "Cancel anytime",
                  ].map((f) => (
                    <li key={f} className="flex gap-2.5">
                      <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-[var(--accent-new)]" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button onClick={() => openAuth("signup")} className="mt-7 w-full py-3 text-[14px]">Upgrade to Pro →</Button>
                <p className="mt-3 text-center text-[10px] text-[var(--text-3-new)]">Cancel anytime from Settings · No long-term commitment</p>
              </div>
            </div>
          </section>

          {/* ─────────────── FAQ ─────────────── */}
          <section className="border-b border-[var(--border-new)] py-20 md:py-28">
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
              <div>
                <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">FAQ</p>
                <h2 className="brand-wordmark mt-3 text-[36px] font-bold leading-[0.95] tracking-[-0.045em] md:text-[52px]">
                  Questions,<br />answered<span className="text-[var(--accent-new)]">.</span>
                </h2>
              </div>
              <div className="divide-y divide-[var(--border-new)]">
                {[
                  {
                    q: "Is this a tipping service?",
                    a: "No. Pickd is an analytics tool. MultiPick shows you example multis built from real form data with transparent math — you decide what to do with them. We don't promise wins.",
                  },
                  {
                    q: "Do you accept bets?",
                    a: "No. Pickd doesn't take wagers, hold funds, or operate as a bookmaker. We're a tracker and an AI analysis tool. Place bets with your own licensed bookmaker.",
                  },
                  {
                    q: "What sports?",
                    a: "AFL and NBA at launch. Player props, line markets, head-to-head. More sports coming based on user demand — NRL, Soccer next.",
                  },
                  {
                    q: "How does the AI work?",
                    a: "MultiPick runs a five-stage statistical pipeline. First, the market line is de-vigged — the over/under odds pair gets the bookmaker's overround stripped out using a power-law adjustment, recovering the book's true implied probability rather than the naive 1/odds. Second, the player's last-15 game logs are pulled and weighted with an exponential time-decay kernel so recent form dominates older samples. Third, an Empirical Bayes posterior is computed — the raw hit rate is regressed toward a Beta(α,β) prior anchored to the de-vigged book probability, with sample size determining how aggressively to shrink. Fourth, the posterior is matchup-adjusted by the opponent's stat-specific concession rate vs the league median. Fifth, each candidate leg is scored by expected value (model_p × decimal_odds − 1) and ranked. For same-game multis, a pairwise correlation matrix discounts the independence assumption that vanilla parlays use. A beam search over the leg shortlist then composes a multi closest to your target odds while maximising combined edge. Every prediction is logged with its probability and outcome, so Brier scores and calibration curves stay publicly verifiable rather than theoretical.",
                  },
                  {
                    q: "Refund policy?",
                    a: "Cancel anytime from your Settings. You keep access until the end of your billing period. We don't pro-rate refunds for partial weeks, but cancellations stop the next charge immediately.",
                  },
                  {
                    q: "Is my data private?",
                    a: "Yes. Your bets are stored under your account only. We don't sell data and don't share it with bookmakers. Read the Privacy page in the footer for the full breakdown.",
                  },
                ].map((item) => (
                  <details key={item.q} className="group py-5">
                    <summary className="flex cursor-pointer items-baseline justify-between gap-4 text-[15px] font-medium text-[var(--text-new)]">
                      <span>{item.q}</span>
                      <span className="text-[var(--text-3-new)] transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="mt-3 max-w-[540px] text-[13.5px] leading-[1.65] text-[var(--text-2-new)]">{item.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          {/* ─────────────── FINAL CTA ─────────────── */}
          <section className="border-b border-[var(--border-new)] py-24 text-center md:py-32">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--text-3-new)]">
              <span className="text-[var(--accent-new)]">●</span> Last word
            </p>
            <h2 className="brand-wordmark mx-auto mt-5 max-w-[840px] text-[44px] font-bold leading-[0.92] tracking-[-0.05em] sm:text-[64px] md:text-[88px]">
              Bet smart.<br />Track smarter<span className="text-[var(--accent-new)]">.</span>
            </h2>
            <p className="mx-auto mt-7 max-w-[420px] text-[15px] leading-[1.6] text-[var(--text-2-new)]">
              Free to start. Three MultiPick builds a week. Unlimited bet tracking. No card required.
            </p>
            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Button onClick={() => openAuth("signup")} className="w-full px-6 py-3.5 text-[14px] sm:w-auto">Start free →</Button>
              <Button variant="ghost" onClick={() => openAuth("login")} className="w-full px-6 py-3.5 text-[14px] sm:w-auto">I have an account</Button>
            </div>
            <p className="mt-6 text-[11px] text-[var(--text-3-new)]">18+ · Gamble responsibly · Pickd does not accept bets</p>
          </section>

          {/* ─────────────── FOOTER ─────────────── */}
          <footer className="grid gap-6 pt-10 md:grid-cols-[1fr_auto]">
            <div>
              <div className="brand-wordmark flex items-baseline leading-none">
                <span className="text-[20px] font-bold tracking-[-0.045em] text-[var(--text-new)]">Pickd</span>
                <span className="text-[20px] font-bold tracking-[-0.045em] text-[var(--accent-new)]">.</span>
              </div>
              <p className="mt-3 max-w-[400px] text-[11px] leading-[1.5] text-[var(--text-3-new)]">
                Pickd is an analytics tool for tracking sports betting activity. Informational only — not betting advice, not a tipping service, does not accept wagers. © 2026 Pickd.
              </p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-[var(--text-3-new)] md:justify-end md:gap-x-8">
              <button onClick={() => setActivePage("disclaimer")} className="hover:text-[var(--text-new)]">Disclaimer</button>
              <button onClick={() => setActivePage("responsible")} className="hover:text-[var(--text-new)]">Responsible Gambling</button>
              <button onClick={() => setActivePage("privacy")} className="hover:text-[var(--text-new)]">Privacy</button>
              <button onClick={() => setActivePage("terms")} className="hover:text-[var(--text-new)]">Terms</button>
            </div>
          </footer>
        </div>
      </main>
      <Analytics />
    </div>
  );
}

// Canonical Terms of Use — single source shared by the Terms page (LegalPage)
// and the checkout acceptance gate, so users tick the exact text shown to them.
const TERMS_CONTENT = {
  title: "Terms of Use",
  updated: "Last updated: 9 June 2026",
  intro: "These Terms of Use (\"Terms\") are a binding agreement between you and Aiden Channell, trading as Pickd (\"Pickd\", \"we\", \"us\", \"our\"), and govern your access to and use of the Pickd website and app at pickd.tech and bettracker.tech, including MultiPick and the bet tracker (together, the \"Service\"). By creating an account or using the Service, you confirm you have read, understood and agree to these Terms. If you do not agree, do not use the Service.",
  sections: [
    { h: "1. Eligibility — you must be 18+", p: [
      "You must be at least 18 years old and old enough to legally gamble where you live. The Service is intended for users in Australia, and you are responsible for complying with the laws that apply to you.",
      "You must not use the Service if you are currently self-excluded from gambling, or if you are using it on behalf of someone who is. We may ask you to verify your age, and may suspend or close accounts we reasonably believe belong to a minor or breach this clause.",
    ] },
    { h: "2. What Pickd is — and what it is not", p: [
      "Pickd is an informational sports-statistics, analysis and bet-tracking tool. It helps you record your own bets and review historical player and team statistics, and it generates illustrative, statistically-derived example multis (\"MultiPick\").",
      "Pickd is NOT a bookmaker, wagering operator or betting exchange. We do not accept, place, process or settle bets, and we never handle wagering funds.",
      "Pickd is NOT a tipping service, and does not provide betting, financial, investment or other professional advice. MultiPick outputs, confidence percentages, \"value\" and \"edge\" indicators, cushion grades and any analysis are statistical illustrations only — not recommendations, tips, or predictions of any outcome.",
      "Nothing in the Service is a guarantee, representation or promise of any betting outcome, profit or result.",
    ] },
    { h: "3. No advice — your decisions, your risk", p: [
      "All betting and financial decisions are yours alone, and you bet entirely at your own risk. Sports outcomes are inherently uncertain, and past performance or historical statistics do not guarantee future results.",
      "Data, models, probabilities, edges and analysis may be incomplete, delayed or wrong. Always verify information independently before relying on anything in the Service.",
    ] },
    { h: "4. Responsible gambling", p: [
      "Gambling can be harmful. Only ever bet what you can afford to lose, set your limits in advance, and never chase losses. The Service is for people aged 18 and over.",
      "If gambling is causing you or someone you know harm, free and confidential support is available 24/7 in Australia from Gambling Help Online — 1800 858 858 or gamblinghelponline.org.au. If you are outside Australia, please contact the relevant support service in your country.",
    ] },
    { h: "5. Your account", p: [
      "You must provide accurate information and keep your login details secure. You are responsible for all activity that occurs under your account. One account per person — do not share, sell or transfer your account.",
      "Tell us promptly if you suspect unauthorised use. We may suspend or terminate accounts that breach these Terms or that we reasonably believe are being misused.",
    ] },
    { h: "6. Free tier, subscriptions and billing", p: [
      "Free tier: the Service includes a limited number of MultiPick builds per week (currently 3). These limits may change.",
      "Pickd Pro: a paid subscription billed in advance on a recurring basis (currently weekly) in Australian dollars at the price shown when you subscribe (A$6.99 per week, or A$4.99 per week under the founding offer). Founding-offer and promotional prices, where offered, apply on the terms shown at checkout (for example, a locked-in founding rate available to a limited number of subscribers).",
      "Payments are processed by our third-party payment provider, Stripe. By subscribing, you authorise us, through Stripe, to charge your nominated payment method for each billing period until you cancel.",
      "Auto-renewal: your subscription renews automatically at the end of each billing period until you cancel.",
      "Cancellation: you can cancel at any time from the in-app billing portal or Settings. Cancelling stops future renewals; your Pro access continues until the end of the period you have already paid for.",
      "Price and plan changes: we may change prices, features or limits. We will give reasonable notice, and changes apply from your next billing period. Locked-in founding rates are honoured as described at checkout. Promotional codes are subject to their stated conditions and may be withdrawn.",
    ] },
    { h: "7. Refunds and your Australian Consumer Law rights", p: [
      "Except where required by law, subscription fees are non-refundable, including for partial billing periods or change of mind.",
      "Nothing in these Terms excludes, restricts or modifies any consumer guarantee, right or remedy you may have under the Australian Consumer Law or any other law that cannot lawfully be excluded. Where a consumer guarantee applies and cannot be excluded, but can be limited, our liability is limited (to the extent permitted) to resupplying the relevant service or paying the cost of resupply.",
      "For any billing question or refund request, contact us at aidenchannell0@gmail.com.",
    ] },
    { h: "8. Acceptable use", p: [
      "Use the Service only for your own lawful, personal, non-commercial use. You must not: scrape, harvest or use any automated means to access the Service or its data; copy, resell, redistribute or otherwise commercialise our odds, statistics, outputs or other content; reverse engineer or attempt to extract source code; circumvent usage limits, paywalls or security measures; use the Service for any unlawful purpose or to facilitate illegal gambling; or interfere with the operation or security of the Service.",
    ] },
    { h: "9. Third-party data and availability", p: [
      "The Service relies on third-party data, including betting odds (via The Odds API) and player and team statistics (for example AFL Tables and balldontlie). We do not control and do not guarantee the accuracy, completeness or timeliness of this data, which may be delayed or contain errors.",
      "The Service is provided on an \"as is\" and \"as available\" basis. It may change, be unavailable, or contain bugs, and some features are experimental. We do not guarantee uninterrupted or error-free operation.",
    ] },
    { h: "10. Intellectual property", p: [
      "Pickd and its content, branding, design, software and outputs are owned by us or our licensors and are protected by law. We grant you a limited, personal, non-exclusive, non-transferable and revocable licence to use the Service in accordance with these Terms.",
      "If you send us feedback or suggestions, you grant us a perpetual, worldwide, royalty-free licence to use them without any obligation to you.",
    ] },
    { h: "11. Disclaimers and limitation of liability", p: [
      "To the maximum extent permitted by law, we disclaim all warranties, express or implied, including as to accuracy, fitness for a particular purpose, and that using information from the Service will be profitable. This does not exclude any consumer guarantee that cannot lawfully be excluded.",
      "To the maximum extent permitted by law, we are not liable for any betting or gambling losses, or for any indirect, incidental, special or consequential loss, arising from your use of the Service. Where our liability cannot be excluded but can be limited, our total liability to you is limited to the amount you paid us for the Service in the 3 months before the relevant claim. Nothing in these Terms limits liability that cannot be limited under law, including under the Australian Consumer Law.",
    ] },
    { h: "12. Indemnity", p: [
      "You agree to indemnify us against any claims, losses, damages and costs (including reasonable legal costs) arising from your breach of these Terms, your misuse of the Service, or your betting or other activities.",
    ] },
    { h: "13. Privacy", p: [
      "How we handle your personal information is set out in our Privacy Policy. By using the Service you consent to that handling. We store account and bet-tracking data using infrastructure providers such as Supabase and Vercel, and process payments via Stripe.",
    ] },
    { h: "14. Changes, suspension and termination", p: [
      "We may modify the Service or these Terms. If we make material changes to these Terms, we will take reasonable steps to notify you (for example, in the app or by email), and your continued use after the changes take effect means you accept the updated Terms.",
      "You may stop using the Service and close your account at any time. We may suspend or terminate your access if you breach these Terms or where reasonably necessary. Clauses that by their nature should survive termination (including intellectual property, disclaimers, limitation of liability and indemnity) will survive.",
    ] },
    { h: "15. Governing law and contact", p: [
      "These Terms are governed by the laws of the Australian Capital Territory, Australia, and you submit to the non-exclusive jurisdiction of the courts of that Territory. Questions about these Terms can be sent to aidenchannell0@gmail.com.",
      "Important: this is a draft prepared for an early-stage business and is not legal advice. Because Pickd involves gambling-related content and paid subscriptions, you should have these Terms (and your Privacy Policy) reviewed by an Australian lawyer, and confirm your obligations under gambling-advertising and consumer-protection laws, before relying on them.",
    ] },
  ],
};

function LegalPage({ page, setActivePage }) {
  const content = {
    disclaimer: {
      title: "Disclaimer",
      body: [
        "Pickd is designed to help users record, review and understand their own betting activity. The information shown in the app is for general informational and tracking purposes only.",
        "Nothing in Pickd should be treated as financial advice, betting advice, a guarantee of results or an instruction to place a bet. Betting involves risk, and users are responsible for their own decisions.",
        "Statistics, graphs and future AI-generated analysis may contain errors, omissions or outdated information. Always check information independently before relying on it.",
      ],
    },
    responsible: {
      title: "Responsible Gambling",
      body: [
        "Pickd is intended to support awareness and accountability. If betting stops being fun, causes stress, or affects your finances, relationships, study or work, consider taking a break and seeking support.",
        "Set limits before you bet, never bet more than you can afford to lose, and do not chase losses. Tracking losses clearly is one of the reasons this app exists.",
        "If you are in Australia and need support, consider contacting Gambling Help Online or your local gambling support service. If you are outside Australia, contact the relevant support service in your country.",
      ],
    },
    privacy: {
      title: "Privacy Policy",
      body: [
        "Pickd stores account and bet-tracking information so users can access their data across devices. This may include email address, bet dates, stakes, returns, results, notes and related performance statistics.",
        "Pickd does not need users to enter bookmaker account details or payment card details to use the core tracking features. Do not enter sensitive personal information into the notes field.",
        "Data is stored using third-party infrastructure providers such as Supabase and Vercel. As the product develops, this policy should be reviewed and replaced with a full legal privacy policy before wider public marketing.",
      ],
    },
    terms: TERMS_CONTENT,
  };

  const selected = content[page] || content.disclaimer;

  return (
    <div className="page-fade-in min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <button onClick={() => setActivePage("app")} className="text-sm font-medium text-slate-600 underline">← Back to dashboard</button>
        <Card>
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Pickd</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{selected.title}</h1>
            <div className="mt-6 space-y-4 text-sm leading-7 text-slate-700">
              {selected.updated ? <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{selected.updated}</p> : null}
              {selected.intro ? <p>{selected.intro}</p> : null}
              {selected.sections
                ? selected.sections.map((s) => (
                    <div key={s.h} className="space-y-2">
                      <h2 className="pt-1 text-base font-semibold text-[#11203B]">{s.h}</h2>
                      {s.p.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                    </div>
                  ))
                : selected.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
            <div className="mt-6 rounded-2xl bg-[#E8E2D4] p-4 text-sm text-slate-600">This page is a working draft for an early-stage product and is not a substitute for legal advice.</div>
          </div>
        </Card>
      </div>
    </div>
  );
}


const NAV_ICONS = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10.5V20h13v-9.5" />
      <path d="M9.5 20v-5h5v5" />
    </svg>
  ),
  add: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  // 2x2 grid — on-brand for "MultiPick" (assembling blocks)
  build: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </svg>
  ),
  // sliders — clean line-icon for settings (matches the others, not an emoji)
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <line x1="4" y1="8" x2="20" y2="8" />
      <circle cx="9" cy="8" r="2.3" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="15" cy="16" r="2.3" />
    </svg>
  ),
};

function MobileBottomNav({ activePage, setActivePage, formRef }) {
  const goToDashboard = () => {
    setActivePage("app");
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };
  const goToAddBet = () => {
    setActivePage("app");
    window.setTimeout(() => formRef?.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  // 2026 refresh: subtle glassmorphism on the dark base, active tab uses the
  // primary text token (no chunky pill), Add stays warning-gold for contrast.
  const tab = (active) =>
    "flex flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[11px] transition active:scale-95 " +
    (active ? "font-semibold text-[var(--text-new)]" : "font-medium text-[var(--text-3-new)]");

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:hidden"
      style={{
        background: "rgba(10, 10, 11, 0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid var(--border-new)",
      }}
    >
      <div className="mx-auto flex max-w-md items-stretch">
        <button type="button" onClick={goToDashboard} className={tab(activePage === "app")}>
          {NAV_ICONS.home}<span>Home</span>
        </button>
        <button type="button" onClick={() => setActivePage("tracker")} className={tab(activePage === "tracker")}>
          {NAV_ICONS.home}<span>Tracker</span>
        </button>
        <button type="button" onClick={() => setActivePage("edge")} className={tab(activePage === "edge")}>
          {NAV_ICONS.build}<span>MultiPick</span>
        </button>
        <button type="button" onClick={() => setActivePage("settings")} className={tab(activePage === "settings")}>
          {NAV_ICONS.settings}<span>Settings</span>
        </button>
      </div>
    </nav>
  );
}

// ── Stat detail modal ───────────────────────────────────────────────
// Tapping any of the four headline stat-strip cells (P/L, Win rate, ROI, In
// flight) opens this modal with a fuller picture: a Recharts visualisation
// tuned to that metric plus a tight summary grid. Each tab computes its own
// derived series from the same filtered bet pool the strip uses, so values
// stay consistent. Open/close is animated in CSS (stat-modal-* classes).
const STAT_META = {
  pl: {
    eyebrow: "Profit / loss",
    title: "Cumulative profit",
    subtitle: "Running balance after every settled bet",
  },
  winrate: {
    eyebrow: "Win rate",
    title: "Win rate over time",
    subtitle: "Each point = strike rate over the last 10 settled bets — recent form, not the overall figure above.",
  },
  roi: {
    eyebrow: "Return on stake",
    title: "Monthly ROI",
    subtitle: "Profit divided by stake, grouped by month",
  },
  inflight: {
    eyebrow: "In flight",
    title: "Pending bets",
    subtitle: "Open positions ranked by exposure",
  },
};

function StatDetailModal({ statKey, onClose, stats, subStats, filteredBets, pendingBets, cumulativeData, fmtMoney = formatCurrency }) {
  // Lock scroll while open + close on Escape.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const meta = STAT_META[statKey] || STAT_META.pl;

  // Per-tab derived data + summary cells.
  let chartNode = null;
  let summary = [];
  let headline = null;
  let headlineTone = "text-[var(--text-new)]";

  if (statKey === "pl") {
    headline = fmtMoney(stats.totalProfit);
    headlineTone = stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]";
    summary = [
      { label: "This week", value: (subStats.weekProfit >= 0 ? "+" : "") + formatCurrency(subStats.weekProfit), tone: subStats.weekProfit >= 0 ? "pos" : "neg" },
      { label: "Settled", value: subStats.settledCount },
      { label: "Biggest win", value: fmtMoney(stats.biggestWin), tone: "pos" },
      { label: "Biggest loss", value: fmtMoney(stats.biggestLoss), tone: "neg" },
      { label: "Longest win streak", value: stats.longestWinningStreak },
      { label: "Longest loss streak", value: stats.longestLosingStreak },
    ];
    chartNode = cumulativeData.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={cumulativeData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="statModalPlGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stats.totalProfit >= 0 ? "#4ade80" : "#f87171"} stopOpacity={0.32} />
              <stop offset="100%" stopColor={stats.totalProfit >= 0 ? "#4ade80" : "#f87171"} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis tickFormatter={formatCompactCurrency} tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} width={56} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(255,255,255,0.15)", strokeWidth: 1 }} />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="2 4" />
          <Area type="monotone" dataKey="balance" stroke={stats.totalProfit >= 0 ? "#4ade80" : "#f87171"} strokeWidth={2} fill="url(#statModalPlGrad)" />
        </AreaChart>
      </ResponsiveContainer>
    ) : null;
  } else if (statKey === "winrate") {
    headline = stats.winRate.toFixed(1) + "%";
    // Rolling win rate over last 10 bets, advancing one settled bet at a time.
    const settled = [...filteredBets]
      .filter((b) => b.result === "win" || b.result === "loss")
      .sort((a, b) => (parseBetDate(a.date)?.getTime() || 0) - (parseBetDate(b.date)?.getTime() || 0));
    const W = 10;
    const rolling = settled.map((b, i) => {
      const start = Math.max(0, i - (W - 1));
      const window = settled.slice(start, i + 1);
      const wins = window.filter((x) => x.result === "win").length;
      return {
        label: parseBetDate(b.date)?.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) || "—",
        rate: Number(((wins / window.length) * 100).toFixed(1)),
        sortKey: b.date,
      };
    });
    summary = [
      { label: "Wins", value: stats.wins, tone: "pos" },
      { label: "Losses", value: stats.losses, tone: "neg" },
      { label: "Settled", value: subStats.settledCount },
      { label: "Mo / mo", value: subStats.winRateDelta != null ? (subStats.winRateDelta >= 0 ? "+" : "") + subStats.winRateDelta.toFixed(1) + "pp" : "—", tone: subStats.winRateDelta != null ? (subStats.winRateDelta >= 0 ? "pos" : "neg") : null },
      { label: "Best streak", value: stats.longestWinningStreak + "W" },
      { label: "Worst streak", value: stats.longestLosingStreak + "L" },
    ];
    chartNode = rolling.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rolling} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} minTickGap={40} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => v + "%"} tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} width={42} />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.15)", strokeWidth: 1 }}
            content={({ active, payload, label }) => active && payload && payload.length ? (
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
                <p className="font-semibold text-[#11203B]">{label}</p>
                <p className="mt-0.5 font-medium text-[#11203B]">Last-10 strike rate <span className="mono-nums">{payload[0].value}%</span></p>
              </div>
            ) : null}
          />
          <ReferenceLine y={50} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 4" />
          <Line type="monotone" dataKey="rate" stroke="#d4f23a" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#d4f23a" }} />
        </LineChart>
      </ResponsiveContainer>
    ) : null;
  } else if (statKey === "roi") {
    headline = (stats.roi >= 0 ? "+" : "") + stats.roi.toFixed(1) + "%";
    headlineTone = stats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]";
    // ROI by month.
    const map = new Map();
    filteredBets.forEach((b) => {
      const d = parseBetDate(b.date);
      if (!d) return;
      const key = String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const label = d.toLocaleString("en-AU", { month: "short", year: "2-digit" });
      if (!map.has(key)) map.set(key, { key, label, profit: 0, staked: 0 });
      const cell = map.get(key);
      cell.profit += Number(b.profitLoss || 0);
      cell.staked += Number(b.stake || 0);
    });
    const monthly = [...map.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((m) => ({ ...m, roi: m.staked ? Number(((m.profit / m.staked) * 100).toFixed(1)) : 0 }));
    const bestMonth = monthly.length ? monthly.reduce((best, m) => (m.roi > best.roi ? m : best)) : null;
    const worstMonth = monthly.length ? monthly.reduce((worst, m) => (m.roi < worst.roi ? m : worst)) : null;
    summary = [
      { label: "Total staked", value: fmtMoney(stats.totalStaked, false) },
      { label: "Net profit", value: fmtMoney(stats.totalProfit), tone: stats.totalProfit >= 0 ? "pos" : "neg" },
      { label: "Mo / mo", value: subStats.roiDelta != null ? (subStats.roiDelta >= 0 ? "+" : "") + subStats.roiDelta.toFixed(1) + "pp" : "—", tone: subStats.roiDelta != null ? (subStats.roiDelta >= 0 ? "pos" : "neg") : null },
      { label: "Settled", value: subStats.settledCount },
      { label: "Best month", value: bestMonth ? bestMonth.label + " · " + (bestMonth.roi >= 0 ? "+" : "") + bestMonth.roi + "%" : "—", tone: bestMonth && bestMonth.roi >= 0 ? "pos" : null },
      { label: "Worst month", value: worstMonth ? worstMonth.label + " · " + (worstMonth.roi >= 0 ? "+" : "") + worstMonth.roi + "%" : "—", tone: worstMonth && worstMonth.roi < 0 ? "neg" : null },
    ];
    chartNode = monthly.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={monthly} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={(v) => v + "%"} tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} width={48} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={({ active, payload, label }) => active && payload && payload.length ? (
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
                <p className="font-semibold text-[#11203B]">{label}</p>
                <p className={"mt-0.5 font-medium " + (payload[0].value >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>ROI <span className="mono-nums">{payload[0].value >= 0 ? "+" : ""}{payload[0].value}%</span></p>
                <p className="mt-0.5 text-slate-500">P/L <span className="mono-nums">{formatCurrency(payload[0].payload.profit)}</span></p>
              </div>
            ) : null}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" />
          <Bar dataKey="roi" radius={[4, 4, 0, 0]}>
            {monthly.map((m, i) => (
              <Cell key={i} fill={m.roi >= 0 ? "#4ade80" : "#f87171"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    ) : null;
  } else if (statKey === "inflight") {
    headline = formatCurrency(subStats.inFlightTotal);
    // Group pending bets by sport for a horizontal-bar exposure read.
    const sportMap = new Map();
    pendingBets.forEach((b) => {
      const key = b.sport || "Other";
      if (!sportMap.has(key)) sportMap.set(key, { key, stake: 0, count: 0, potential: 0 });
      const cell = sportMap.get(key);
      cell.stake += Number(b.stake || 0);
      cell.count += 1;
      cell.potential += Number(b.stake || 0) * Number(b.odds || 0);
    });
    const sports = [...sportMap.values()].sort((a, b) => b.stake - a.stake);
    const totalPotential = pendingBets.reduce((s, b) => s + Number(b.stake || 0) * Number(b.odds || 0), 0);
    const avgOdds = pendingBets.length ? pendingBets.reduce((s, b) => s + Number(b.odds || 0), 0) / pendingBets.length : 0;
    summary = [
      { label: "Pending", value: subStats.pendingCount },
      { label: "Tonight", value: subStats.pendingTonight },
      { label: "Potential return", value: formatCurrency(totalPotential), tone: "pos" },
      { label: "Potential profit", value: formatCurrency(totalPotential - subStats.inFlightTotal), tone: "pos" },
      { label: "Avg odds", value: avgOdds ? avgOdds.toFixed(2) : "—" },
      { label: "Sports in play", value: sports.length },
    ];
    chartNode = pendingBets.length ? (
      <div className="h-full overflow-y-auto pr-2">
        {/* Sport exposure bars */}
        {sports.length ? (
          <div className="mb-6">
            <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Exposure by sport</div>
            <div className="space-y-3">
              {sports.map((s) => {
                const pct = subStats.inFlightTotal ? (s.stake / subStats.inFlightTotal) * 100 : 0;
                return (
                  <div key={s.key}>
                    <div className="mb-1 flex items-baseline justify-between text-[12px]">
                      <span className="text-[var(--text-2-new)]">{s.key} <span className="text-[var(--text-3-new)]">· {s.count}</span></span>
                      <span className="mono-nums font-medium text-[var(--text-new)]">{formatCurrency(s.stake)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2-new)]">
                      <div className="h-full rounded-full bg-[var(--accent-new)]" style={{ width: Math.max(3, pct) + "%" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {/* Pending bet list */}
        <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Open positions</div>
        <div className="divide-y divide-[var(--border-new)]">
          {pendingBets.map((b) => (
            <div key={b.id} className="flex items-center justify-between py-2.5 text-[13px]">
              <div className="min-w-0">
                <div className="truncate text-[var(--text-new)]">{b.notes || b.betType || (b.sport || "Bet")}</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-3-new)]"><span className="mono-nums">{b.date}</span> · {b.sport || "Other"}{b.bookmaker ? " · " + b.bookmaker : ""}</div>
              </div>
              <div className="ml-4 flex shrink-0 items-baseline gap-3">
                <span className="mono-nums text-[var(--text-2-new)]">{formatOdds(b.odds)}</span>
                <span className="mono-nums font-medium text-[var(--text-new)]">{formatCurrency(b.stake)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null;
  }

  const toneClass = (tone) => tone === "pos" ? "text-[var(--positive-new)]" : tone === "neg" ? "text-[var(--danger-new)]" : "text-[var(--text-new)]";

  // Portal mount target — guard for SSR even though we're CSR-only.
  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;

  return createPortal(
    <div
      className="stat-modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md sm:p-6 md:p-10"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
    >
      <div
        className="stat-modal-card relative flex max-h-[92vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-3xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] shadow-[0_30px_90px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-6 border-b border-[var(--border-new)] px-8 pt-8 pb-6 md:px-10 md:pt-10 md:pb-7">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">{meta.eyebrow}</div>
            <div className={"mono-nums mt-2.5 text-[52px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[64px] " + headlineTone}>{headline}</div>
            <div className="mt-3.5 text-[15px] text-[var(--text-2-new)]">{meta.title}</div>
            <div className="mt-1 text-[12px] text-[var(--text-3-new)]">{meta.subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-full border border-[var(--border-new)] bg-[var(--surface-2-new)] px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-2-new)] transition-colors hover:border-[var(--border-strong-new)] hover:text-[var(--text-new)]"
          >
            Close ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Chart area */}
          <div className="border-b border-[var(--border-new)] px-8 py-7 md:px-10 md:py-8">
            <div className={statKey === "inflight" ? "h-[340px]" : "h-[300px]"}>
              {chartNode || (
                <div className="grid h-full place-items-center rounded-xl border border-dashed border-[var(--border-new)] text-sm text-[var(--text-3-new)]">
                  {statKey === "inflight" ? "Nothing pending right now." : "Settle a bet to see this chart."}
                </div>
              )}
            </div>
          </div>

          {/* Summary grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 px-8 py-8 sm:grid-cols-3 md:px-10">
            {summary.map((s, i) => (
              <div key={i}>
                <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">{s.label}</div>
                <div className={"mono-nums mt-2 text-[22px] font-semibold leading-none " + toneClass(s.tone)}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    portalTarget
  );
}

// ── Stat-cell hover preview ─────────────────────────────────────────
// A compact sparkline that floats above the stat cell on hover. Each tab
// renders a tab-appropriate visual so users get a quick read before
// committing to click. Positioned via .stat-cell-preview CSS — fades in
// + lifts on parent :hover.
function StatHoverPreview({ statKey, stats, subStats, filteredBets, pendingBets, cumulativeData, fmtMoney = formatCurrency }) {
  const meta = STAT_META[statKey] || STAT_META.pl;
  let chart = null;
  let footer = null;

  if (statKey === "pl") {
    const data = cumulativeData;
    const stroke = stats.totalProfit >= 0 ? "#4ade80" : "#f87171";
    chart = data.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
          <defs>
            <linearGradient id={"sparkPlGrad_" + statKey} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.45} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 3" />
          <Area type="monotone" dataKey="balance" stroke={stroke} strokeWidth={1.75} fill={"url(#sparkPlGrad_" + statKey + ")"} />
        </AreaChart>
      </ResponsiveContainer>
    ) : null;
    footer = (
      <>
        <span>{data.length} period{data.length === 1 ? "" : "s"}</span>
        <span className="mono-nums">{fmtMoney(stats.totalProfit)}</span>
      </>
    );
  } else if (statKey === "winrate") {
    const settled = [...filteredBets]
      .filter((b) => b.result === "win" || b.result === "loss")
      .sort((a, b) => (parseBetDate(a.date)?.getTime() || 0) - (parseBetDate(b.date)?.getTime() || 0));
    const W = 10;
    const rolling = settled.map((b, i) => {
      const start = Math.max(0, i - (W - 1));
      const window = settled.slice(start, i + 1);
      const wins = window.filter((x) => x.result === "win").length;
      return { rate: Number(((wins / window.length) * 100).toFixed(1)) };
    });
    chart = rolling.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rolling} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
          <ReferenceLine y={50} stroke="rgba(255,255,255,0.12)" strokeDasharray="2 3" />
          <Line type="monotone" dataKey="rate" stroke="#d4f23a" strokeWidth={1.75} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    ) : null;
    footer = (
      <>
        <span><span className="mono-nums">{stats.wins}</span>W · <span className="mono-nums">{stats.losses}</span>L</span>
        <span className="mono-nums">{stats.winRate.toFixed(1)}%</span>
      </>
    );
  } else if (statKey === "roi") {
    const map = new Map();
    filteredBets.forEach((b) => {
      const d = parseBetDate(b.date);
      if (!d) return;
      const key = String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0");
      if (!map.has(key)) map.set(key, { key, profit: 0, staked: 0 });
      const cell = map.get(key);
      cell.profit += Number(b.profitLoss || 0);
      cell.staked += Number(b.stake || 0);
    });
    const monthly = [...map.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((m) => ({ ...m, roi: m.staked ? Number(((m.profit / m.staked) * 100).toFixed(1)) : 0 }));
    chart = monthly.length ? (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={monthly} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" />
          <Bar dataKey="roi" radius={[2, 2, 0, 0]}>
            {monthly.map((m, i) => (
              <Cell key={i} fill={m.roi >= 0 ? "#4ade80" : "#f87171"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    ) : null;
    footer = (
      <>
        <span>{monthly.length} month{monthly.length === 1 ? "" : "s"}</span>
        <span className={"mono-nums " + (stats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{(stats.roi >= 0 ? "+" : "") + stats.roi.toFixed(1)}%</span>
      </>
    );
  } else if (statKey === "inflight") {
    const sportMap = new Map();
    pendingBets.forEach((b) => {
      const key = b.sport || "Other";
      if (!sportMap.has(key)) sportMap.set(key, { key, stake: 0 });
      sportMap.get(key).stake += Number(b.stake || 0);
    });
    const sports = [...sportMap.values()].sort((a, b) => b.stake - a.stake).slice(0, 4);
    chart = sports.length ? (
      <div className="flex h-full w-full flex-col justify-center gap-1.5 px-2">
        {sports.map((s) => {
          const pct = subStats.inFlightTotal ? (s.stake / subStats.inFlightTotal) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2 text-[10px]">
              <span className="w-10 shrink-0 truncate text-[var(--text-3-new)]">{s.key}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2-new)]">
                <div className="h-full rounded-full bg-[var(--accent-new)]" style={{ width: Math.max(4, pct) + "%" }} />
              </div>
              <span className="mono-nums w-12 shrink-0 text-right text-[var(--text-2-new)]">{formatCurrency(s.stake).replace(".00", "")}</span>
            </div>
          );
        })}
      </div>
    ) : null;
    footer = (
      <>
        <span><span className="mono-nums">{subStats.pendingCount}</span> open</span>
        <span className="mono-nums">{formatCurrency(subStats.inFlightTotal)}</span>
      </>
    );
  }

  return (
    <div className="stat-cell-preview rounded-xl border border-[var(--border-strong-new)] bg-[var(--surface-new)] p-3 shadow-2xl">
      <div className="mb-1.5 flex items-baseline justify-between text-[10px]">
        <span className="font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">{meta.title}</span>
        <span className="text-[var(--text-3-new)]">Click to expand</span>
      </div>
      <div className="h-[78px] w-full">
        {chart || (
          <div className="grid h-full place-items-center text-[10px] text-[var(--text-3-new)]">
            {statKey === "inflight" ? "Nothing pending" : "No data yet"}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[10px] text-[var(--text-3-new)]">
        {footer}
      </div>
    </div>
  );
}

export default function BettingTrackerWebsite() {
  // Dark by default. We only ever persist a preference when the user EXPLICITLY
  // picks one in Settings (via chooseTheme). The "bg-theme" key is deliberately
  // fresh — the old "theme" key got auto-written on every visit, which silently
  // stuck early users on light; ignoring it resets everyone to the dark default.
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("bg-theme") !== "light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  const chooseTheme = (dark) => {
    setDarkMode(dark);
    try {
      localStorage.setItem("bg-theme", dark ? "dark" : "light");
    } catch (e) {
      /* ignore storage errors */
    }
  };

  // Units: a display lens over the dollar figures. `unitSize` is the dollar
  // value of 1 unit; `showUnits` flips the P/L + staked numbers between $ and
  // units. Both persist to localStorage like the theme. fmtMoney() is the single
  // formatter every P/L/staked render site uses so the toggle is consistent.
  const [unitSize, setUnitSize] = useState(() => {
    const v = Number(localStorage.getItem("pickd-unit-size"));
    return v > 0 ? v : 10;
  });
  const [showUnits, setShowUnits] = useState(() => localStorage.getItem("pickd-show-units") === "1");
  useEffect(() => { try { localStorage.setItem("pickd-unit-size", String(unitSize)); } catch (e) { /* ignore */ } }, [unitSize]);
  useEffect(() => { try { localStorage.setItem("pickd-show-units", showUnits ? "1" : "0"); } catch (e) { /* ignore */ } }, [showUnits]);
  const fmtMoney = (value, signed = true) => (showUnits ? formatUnits(value, unitSize, signed) : formatCurrency(value));
  // The OTHER representation, for showing $ and units side by side: when the
  // headline is units this returns dollars, and vice versa.
  const fmtAlt = (value, signed = true) => (showUnits ? formatCurrency(value) : formatUnits(value, unitSize, signed));

  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  // New-user onboarding tour visibility. Shown once when the localStorage flag
  // is absent; dismissed by finishing or skipping. Replayable from Settings.
  const [showTour, setShowTour] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [message, setMessage] = useState("");
  // Transient "bet saved" confirmation toast — { id, updated? } or null. Tapping
  // it jumps to the bet in the Tracker; auto-dismisses after a few seconds.
  const [savedToast, setSavedToast] = useState(null);
  useEffect(() => {
    if (!savedToast) return;
    const timer = setTimeout(() => setSavedToast(null), 5000);
    return () => clearTimeout(timer);
  }, [savedToast]);
  const viewSavedBet = () => {
    if (savedToast) { setExpandedBetId(savedToast.id); setActivePage("tracker"); setSavedToast(null); window.scrollTo({ top: 0, behavior: "smooth" }); }
  };
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [activePage, setActivePage] = useState("app");
  // Detail modal — null when closed, otherwise one of "pl" | "winrate" | "roi" | "inflight".
  // Renders via a portal at document.body so nothing on the page can clip it.
  const [statDetail, setStatDetail] = useState(null);
  const openStatDetail = (key) => setStatDetail(key);
  const [bets, setBets] = useState([]);
  const [loadingBets, setLoadingBets] = useState(false);
  const [editingBetId, setEditingBetId] = useState(null);
  const [showAllBets, setShowAllBets] = useState(false);
  // Layout B editorial bet table — filter by status pill (all / pending / won / lost).
  const [statusFilter, setStatusFilter] = useState("all");
  // Click a row in the bet table to smooth-expand its detail panel below.
  const [expandedBetId, setExpandedBetId] = useState(null);
  // Per-bet cache of real game stats for each leg, fetched from
  // afl_player_games / nba_player_games when a settled multi expands. Keyed
  // by bet.id → array of { actual, gameDate } | null per leg index.
  const [legActualsByBet, setLegActualsByBet] = useState({});
  const [mobileBetsOpen, setMobileBetsOpen] = useState(false);
  const [selectedSportFilter, setSelectedSportFilter] = useState("All sports");
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const mobileFormRef = useRef(null);
  const [chartView, setChartView] = useState("weekly");
  const [chartType, setChartType] = useState("bar");
  const [form, setForm] = useState({ date: todayString(), sport: "AFL", stake: "", odds: "", result: "win", returnAmount: "", notes: "", bookmaker: "", betType: "", usedMultipick: false });
  // Betslip OCR: paste/upload a screenshot, OpenAI vision extracts the
  // structured details, frontend pre-fills the Add Bet form.
  const [betslipImage, setBetslipImage] = useState(null);
  const [betslipParsing, setBetslipParsing] = useState(false);
  const [betslipError, setBetslipError] = useState("");
  const [betslipExtract, setBetslipExtract] = useState(null);
  // MultiPick dashboard mini-builder — the compact builder card that leads the
  // left column. Sport drives the upcoming-games scroller; legs/odds/risk are a
  // single control row. "Make the multi" stashes the selection and smooth-
  // navigates to the MultiPick page, which auto-fires the build on arrival.
  const [mpSport, setMpSport] = useState("AFL");
  const [mpGameIds, setMpGameIds] = useState([]);
  const [mpLegs, setMpLegs] = useState("Any");
  const [mpOdds, setMpOdds] = useState("$2.00");
  const [mpOddsCustom, setMpOddsCustom] = useState("2.50");
  const [mpRisk, setMpRisk] = useState("Best Chance");
  const [mpBook, setMpBook] = useState("");
  const [mpGames, setMpGames] = useState([]);
  const [mpGamesLoading, setMpGamesLoading] = useState(false);
  const [edgePrefill, setEdgePrefill] = useState(null);
  const [navigating, setNavigating] = useState(false);
  // Add-bet manual form is collapsed by default; the betslip upload leads.
  const [manualOpen, setManualOpen] = useState(false);
  // Weekly build allowance for the card's "X of N free builds left" nudge.
  const [entitlement, setEntitlement] = useState({ subscribed: false, usage: 0, limit: 3 });
  const [upgrading, setUpgrading] = useState(false);
  // Dismissible "Go Pro" strip on the dashboard — remembered per browser.
  const [proStripDismissed, setProStripDismissed] = useState(() => {
    try { return localStorage.getItem("proStripDismissed") === "1"; } catch { return false; }
  });
  const dismissProStrip = () => {
    setProStripDismissed(true);
    try { localStorage.setItem("proStripDismissed", "1"); } catch { /* ignore */ }
  };
  const [termsGateOpen, setTermsGateOpen] = useState(false);
  const startUpgrade = () => { if (!upgrading) setTermsGateOpen(true); };
  const doCheckout = async () => {
    if (upgrading) return;
    setTermsGateOpen(false);
    setUpgrading(true);
    try {
      const response = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      });
      const data = await response.json().catch(() => ({}));
      if (data.url) { window.location.href = data.url; return; }
      setUpgrading(false);
      setMessage(data.error || "Could not start checkout. Please try again.");
    } catch {
      setUpgrading(false);
      setMessage("Could not start checkout. Please try again.");
    }
  };

  // Upcoming games for the scroller, refetched whenever the sport toggles.
  useEffect(() => {
    let cancelled = false;
    setMpGames([]);
    setMpGameIds([]);
    setMpGamesLoading(true);
    fetch(`/api/odds?sport=${encodeURIComponent(mpSport)}&markets=h2h`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const events = (data.events || []).slice(0, 12).map((event) => ({ id: event.id, homeTeam: event.homeTeam, awayTeam: event.awayTeam, commenceTime: event.commenceTime }));
        setMpGames(events.length === 0 && import.meta.env.DEV ? devSampleGames(mpSport) : events);
      })
      .catch(() => { if (!cancelled) setMpGames(import.meta.env.DEV ? devSampleGames(mpSport) : []); })
      .finally(() => { if (!cancelled) setMpGamesLoading(false); });
    return () => { cancelled = true; };
  }, [mpSport]);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return;
    let cancelled = false;
    fetch("/api/entitlement", { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.json())
      .then((data) => { if (!cancelled) setEntitlement({ subscribed: !!data.subscribed, usage: data.usage || 0, limit: data.limit || 3 }); })
      .catch(() => { /* card falls back to the default allowance */ });
    return () => { cancelled = true; };
  }, [session]);

  // Smooth hand-off: stash the mini-builder selection, fade the dashboard out,
  // then switch to MultiPick (which fades in and auto-builds on arrival).
  const goBuildMulti = () => {
    const targetOdds = mpOdds === "Custom" && mpOddsCustom ? `$${mpOddsCustom}` : mpOdds;
    setEdgePrefill({ sport: mpSport, gameIds: mpGameIds, legs: mpLegs, targetOdds, riskProfile: mpRisk, bookmaker: mpBook, autoBuild: true });
    setNavigating(true);
    setTimeout(() => { setActivePage("edge"); setNavigating(false); }, 220);
  };

  const parseBetslip = async (image) => {
    if (!image) return;
    setBetslipParsing(true);
    setBetslipError("");
    setBetslipExtract(null);
    try {
      const response = await fetch("/api/edge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: "parse_betslip", image }),
      });
      const data = await response.json();
      if (!response.ok || data.valid === false) {
        setBetslipError(data.error || "Could not parse the screenshot. Try a clearer image.");
        return;
      }
      setBetslipExtract(data);
      setManualOpen(true); // reveal the (now pre-filled) form so the user can review + save
      // Map OCR-extracted status/result to the form's `result` field. Default
      // is "pending" when the screenshot is unsettled (or the model couldn't
      // tell), NOT the previous "win" — that was the Task #N bug where a
      // screenshot of a LOST bet got saved as a win because the form's hard-
      // coded `result: "win"` default was never overwritten by the OCR
      // pre-fill. Safe fallback: better to leave it pending and force the
      // user to settle manually than silently mark losses as wins.
      const ocrResult =
        data.status === "settled" && (data.result === "win" || data.result === "loss")
          ? data.result
          : "pending";
      // Auto-prefill the form with the extracted values.
      setForm((prev) => ({
        ...prev,
        sport: ["AFL", "NRL", "Soccer", "Basketball", "Cricket"].includes(data.sport) ? data.sport : prev.sport,
        stake: data.stake != null ? String(data.stake) : prev.stake,
        odds: data.odds != null ? String(data.odds) : prev.odds,
        returnAmount: data.returnAmount != null ? String(data.returnAmount) : prev.returnAmount,
        bookmaker: data.bookmaker || prev.bookmaker,
        betType: ["Single", "Multi", "Player prop", "Head-to-head", "Line", "Total", "Other"].includes(data.betType) ? data.betType : prev.betType,
        notes: data.notes || prev.notes,
        result: ocrResult,
      }));
    } catch (err) {
      setBetslipError("Network error. Try again.");
    } finally {
      setBetslipParsing(false);
    }
  };

  const handleBetslipPaste = (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") {
            setBetslipImage(result);
            parseBetslip(result);
          }
        };
        reader.readAsDataURL(file);
        event.preventDefault();
        return;
      }
    }
  };

  const handleBetslipFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setBetslipImage(result);
        parseBetslip(result);
      }
    };
    reader.readAsDataURL(file);
  };

  const clearBetslip = () => {
    setBetslipImage(null);
    setBetslipExtract(null);
    setBetslipError("");
  };

  // Drag-and-drop for the betslip screenshot. Tracks dragOver to highlight
  // the dropzone with the accent colour while a file is hovering over it.
  const [betslipDragOver, setBetslipDragOver] = useState(false);

  const handleBetslipDragOver = (event) => {
    event.preventDefault();
    if (!betslipDragOver) setBetslipDragOver(true);
  };

  const handleBetslipDragLeave = (event) => {
    // Ignore drag-leave when moving onto a child element of the dropzone.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setBetslipDragOver(false);
  };

  const handleBetslipDrop = (event) => {
    event.preventDefault();
    setBetslipDragOver(false);
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBetslipError("Please drop an image file");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        setBetslipImage(result);
        parseBetslip(result);
      }
    };
    reader.readAsDataURL(file);
  };
  const [mobileAddBetOpen, setMobileAddBetOpen] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setMessage("");
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session?.user?.id) {
      loadBets();
      // After login, redirect from the auth screen back to the dashboard.
      // Without this, activePage stays at "auth" (set by LandingPage's
      // openAuth) even after a successful login, which leaves every
      // `activePage === "app"` section (chart / quick-add / pending bets)
      // hidden until the user refreshes. Functional setState so we only
      // change it when actually leaving the auth page.
      setActivePage((current) => (current === "auth" ? "app" : current));
      // First-time tour: only for genuinely new accounts. Gated on BOTH the
      // per-user "seen" flag AND account age — without the age check, every
      // pre-existing user (who never had the flag) would see it once when the
      // feature shipped. New signups log in within minutes of creating their
      // account, so a 24h window cleanly separates them from existing users.
      try {
        const seen = localStorage.getItem(`pickd-tour-seen-${session.user.id}`);
        const createdAt = session.user.created_at ? new Date(session.user.created_at).getTime() : 0;
        const isNewAccount = createdAt > 0 && (Date.now() - createdAt) < 24 * 60 * 60 * 1000;
        if (!seen && isNewAccount) setShowTour(true);
      } catch (e) { /* ignore storage errors */ }
    } else {
      setBets([]);
    }
  }, [session?.user?.id]);

  // When a settled multi expands, fetch the actual game stats for every leg
  // from afl_player_games / nba_player_games. We pick the player's first
  // game on or after the bet's date (within a 14-day window — covers a
  // typical round). Results are cached per bet id so re-expanding is free.
  useEffect(() => {
    if (!supabase || !expandedBetId) return;
    if (legActualsByBet[expandedBetId]) return; // already fetched
    const bet = bets.find((b) => b.id === expandedBetId);
    if (!bet) return;
    const legs = Array.isArray(bet.legs) ? bet.legs : [];
    if (!legs.length) return;
    if (bet.status === "pending") return; // game hasn't happened yet
    const sport = (bet.sport || "AFL").toUpperCase();
    const table = sport === "NBA" ? "nba_player_games" : "afl_player_games";
    const betDate = bet.date;
    if (!betDate) return;
    // 14-day search window so we cover a full round / week of fixtures.
    const start = new Date(betDate + "T00:00:00");
    const end = new Date(start);
    end.setDate(end.getDate() + 14);
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);

    (async () => {
      const actuals = await Promise.all(legs.map(async (leg) => {
        const player = leg.player || leg.name || "";
        const nameKey = toNameKey(player);
        const statCol = statColumnForLeg(leg.line || leg.market || leg.reason || "", sport);
        if (!nameKey || !statCol) return null;
        const { data, error } = await supabase
          .from(table)
          .select(`game_date, ${statCol}`)
          .eq("name_key", nameKey)
          .gte("game_date", startIso)
          .lte("game_date", endIso)
          .order("game_date", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (error || !data) return null;
        const num = Number(data[statCol]);
        return Number.isFinite(num) ? { actual: num, gameDate: data.game_date } : null;
      }));
      setLegActualsByBet((prev) => ({ ...prev, [expandedBetId]: actuals }));
    })();
  }, [expandedBetId, bets]);

  const loadBets = async () => {
    if (!supabase || !session?.user?.id) return;
    setLoadingBets(true);
    setMessage("");
    const { data, error } = await supabase.from("bets").select("*").eq("user_id", session.user.id).order("date", { ascending: false }).order("created_at", { ascending: false });
    if (error) {
      setMessage("Could not load bets: " + error.message);
      setBets([]);
    } else {
      setBets((data || []).map(databaseRowToBet));
    }
    setLoadingBets(false);
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    setAuthLoading(true);
    setMessage("");
    try {
      if (authMode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) setMessage(error.message);
        else setMessage("Password reset email sent. Check your inbox and follow the link.");
        return;
      }
      const response = authMode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { data: firstName.trim() ? { first_name: firstName.trim() } : {} } });
      if (response.error) {
        setMessage(response.error.message);
        return;
      }
      if (authMode === "signup") {
        setMessage("Account created. If Supabase asks for email confirmation, check your inbox, then log in.");
        setAuthMode("login");
        return;
      }
      setEmail("");
      setPassword("");
    } catch (error) {
      setMessage("Auth request failed. Check your Supabase URL/key and internet connection.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handlePasswordResetRequest = () => {
    setAuthMode("reset");
    setMessage("");
    setPassword("");
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    setAuthLoading(true);
    setMessage("");
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Password updated successfully.");
      setNewPassword("");
      setRecoveryMode(false);
    } catch (error) {
      setMessage("Could not update password. Try requesting a new reset link.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setBets([]);
  };

  // Name the app greets the user with — prefers the saved metadata, falls back
  // to whatever's typed in the signup form this session.
  const userFirstName = (session?.user?.user_metadata?.first_name || firstName || "").trim();

  // Dismiss the tour: persist the captured name (if new) to user_metadata so
  // greetings work next session, and flag the tour seen for this user.
  const dismissTour = (nameFromTour) => {
    const trimmed = (nameFromTour || "").trim();
    if (trimmed && supabase && trimmed !== session?.user?.user_metadata?.first_name) {
      supabase.auth.updateUser({ data: { first_name: trimmed } }).catch(() => {});
      setSession((cur) => cur ? { ...cur, user: { ...cur.user, user_metadata: { ...(cur.user.user_metadata || {}), first_name: trimmed } } } : cur);
      setFirstName(trimmed);
    }
    try { if (session?.user?.id) localStorage.setItem(`pickd-tour-seen-${session.user.id}`, "1"); } catch (e) { /* ignore */ }
    setShowTour(false);
  };
  const finishTour = (nameFromTour) => { dismissTour(nameFromTour); setActivePage("edge"); };
  // Replay routes to the dashboard first so the portal-mounted tour is reached
  // even when triggered from Settings (which early-returns its own view).
  const replayTour = () => { setActivePage("app"); setShowTour(true); };

  const settledBets = useMemo(() => bets.filter((bet) => bet.status !== "pending"), [bets]);
  const pendingBets = useMemo(() => bets.filter((bet) => bet.status === "pending"), [bets]);

  const filteredBets = useMemo(() => {
    if (selectedSportFilter === "All sports") return settledBets;
    return settledBets.filter((bet) => (bet.sport || "Other") === selectedSportFilter);
  }, [settledBets, selectedSportFilter]);

  const gridBuildStats = useMemo(() => {
    const gb = settledBets.filter((bet) => bet.source === "grid_build");
    const completed = gb.filter((bet) => bet.result === "win" || bet.result === "loss");
    const wins = gb.filter((bet) => bet.result === "win").length;
    const profit = gb.reduce((sum, bet) => sum + Number(bet.profitLoss || 0), 0);
    const staked = gb.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    return { count: gb.length, completed: completed.length, wins, profit, roi: staked ? (profit / staked) * 100 : null };
  }, [settledBets]);

  const stats = useMemo(() => {
    const totalStaked = filteredBets.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    const totalReturned = filteredBets.reduce((sum, bet) => sum + Number(bet.returnAmount || 0), 0);
    const totalProfit = filteredBets.reduce((sum, bet) => sum + Number(bet.profitLoss || 0), 0);
    const completedBets = filteredBets.filter((bet) => bet.result === "win" || bet.result === "loss");
    const wins = filteredBets.filter((bet) => bet.result === "win").length;
    const losses = filteredBets.filter((bet) => bet.result === "loss").length;
    const winRate = completedBets.length ? (wins / completedBets.length) * 100 : 0;
    const roi = totalStaked ? (totalProfit / totalStaked) * 100 : 0;
    const biggestWin = filteredBets.length ? Math.max(...filteredBets.map((bet) => Number(bet.profitLoss || 0))) : 0;
    const biggestLoss = filteredBets.length ? Math.min(...filteredBets.map((bet) => Number(bet.profitLoss || 0))) : 0;
    let currentLosingStreak = 0;
    let longestLosingStreak = 0;
    let currentWinningStreak = 0;
    let longestWinningStreak = 0;

    [...filteredBets]
      .sort((a, b) => (parseBetDate(a.date)?.getTime() || 0) - (parseBetDate(b.date)?.getTime() || 0))
      .forEach((bet) => {
        if (bet.result === "loss") {
          currentLosingStreak += 1;
          longestLosingStreak = Math.max(longestLosingStreak, currentLosingStreak);
          currentWinningStreak = 0;
        } else if (bet.result === "win") {
          currentWinningStreak += 1;
          longestWinningStreak = Math.max(longestWinningStreak, currentWinningStreak);
          currentLosingStreak = 0;
        } else {
          currentLosingStreak = 0;
          currentWinningStreak = 0;
        }
      });

    return { totalStaked, totalReturned, totalProfit, wins, losses, winRate, roi, biggestWin, biggestLoss, longestLosingStreak, longestWinningStreak };
  }, [filteredBets]);

  // Derived sub-stats for the stat strip sublines — "+$184 this week",
  // "+2.1pp mo/mo", "5 pending · 2 tonight". Computed from the same bet
  // pool the headline stats use.
  const subStats = useMemo(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // P/L delta over the trailing 7 days
    const weekProfit = filteredBets
      .filter((b) => new Date(b.date) >= sevenDaysAgo)
      .reduce((sum, b) => sum + Number(b.profitLoss || 0), 0);

    const settledCount = filteredBets.filter((b) => b.result === "win" || b.result === "loss").length;

    // Win-rate + ROI deltas — current month vs previous month
    const monthBets = (start, end) => filteredBets.filter((b) => {
      const d = new Date(b.date);
      return d >= start && (!end || d <= end) && (b.result === "win" || b.result === "loss");
    });
    const rateOf = (arr) => {
      if (!arr.length) return null;
      return (arr.filter((b) => b.result === "win").length / arr.length) * 100;
    };
    const roiOf = (arr) => {
      if (!arr.length) return null;
      const staked = arr.reduce((s, b) => s + Number(b.stake || 0), 0);
      if (!staked) return null;
      return (arr.reduce((s, b) => s + Number(b.profitLoss || 0), 0) / staked) * 100;
    };
    const thisMonthBets = monthBets(startThisMonth, null);
    const lastMonthBets = monthBets(startLastMonth, endLastMonth);
    const winRateThis = rateOf(thisMonthBets);
    const winRateLast = rateOf(lastMonthBets);
    const winRateDelta = winRateThis != null && winRateLast != null ? winRateThis - winRateLast : null;
    const roiThis = roiOf(thisMonthBets);
    const roiLast = roiOf(lastMonthBets);
    const roiDelta = roiThis != null && roiLast != null ? roiThis - roiLast : null;

    // Pending bets — total stake "in flight" + how many of them are tonight
    const todayStr = now.toDateString();
    const inFlightTotal = pendingBets.reduce((s, b) => s + Number(b.stake || 0), 0);
    const pendingTonight = pendingBets.filter((b) => {
      try { return new Date(b.date).toDateString() === todayStr; } catch { return false; }
    }).length;

    return { weekProfit, settledCount, winRateDelta, roiDelta, inFlightTotal, pendingCount: pendingBets.length, pendingTonight };
  }, [filteredBets, pendingBets]);

  const chartData = useMemo(() => {
    const grouped = filteredBets.reduce((acc, bet) => {
      const periodInfo = getPeriodInfo(bet.date, chartView);
      if (!acc[periodInfo.key]) acc[periodInfo.key] = { sortKey: periodInfo.key, label: periodInfo.label, profitLoss: 0, count: 0 };
      acc[periodInfo.key].profitLoss += Number(bet.profitLoss || 0);
      acc[periodInfo.key].count += 1;
      return acc;
    }, {});
    return Object.values(grouped).map((item) => ({ ...item, profitLoss: Number(item.profitLoss.toFixed(2)) })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [filteredBets, chartView]);

  const cumulativeData = useMemo(() => {
    let running = 0;
    let peak = 0;
    return chartData.map((item) => {
      running += Number(item.profitLoss || 0);
      peak = Math.max(peak, running);
      return {
        label: item.label,
        sortKey: item.sortKey,
        balance: Number(running.toFixed(2)),
        peak: Number(peak.toFixed(2)),
        profitLoss: item.profitLoss,
        count: item.count,
      };
    });
  }, [chartData]);

  const breakdowns = useMemo(() => {
    const oddsBands = [
      { key: "Under $1.50", test: (n) => n > 1 && n < 1.5, order: 1 },
      { key: "$1.50 – $2.00", test: (n) => n >= 1.5 && n < 2, order: 2 },
      { key: "$2.00 – $3.00", test: (n) => n >= 2 && n < 3, order: 3 },
      { key: "$3.00 – $5.00", test: (n) => n >= 3 && n < 5, order: 4 },
      { key: "$5.00+", test: (n) => n >= 5, order: 5 },
    ];
    const sportMap = new Map();
    const oddsMap = new Map();
    const typeMap = new Map();
    const add = (map, key, bet, order = 0) => {
      if (!map.has(key)) map.set(key, { key, profit: 0, staked: 0, count: 0, wins: 0, completed: 0, order });
      const group = map.get(key);
      group.profit += Number(bet.profitLoss || 0);
      group.staked += Number(bet.stake || 0);
      group.count += 1;
      if (bet.result === "win" || bet.result === "loss") {
        group.completed += 1;
        if (bet.result === "win") group.wins += 1;
      }
    };
    for (const bet of settledBets) {
      add(sportMap, bet.sport || "Other", bet);
      const odds = Number(bet.odds || 0);
      const band = oddsBands.find((entry) => entry.test(odds));
      add(oddsMap, band ? band.key : "Unknown odds", bet, band ? band.order : 99);
      if (bet.betType) add(typeMap, bet.betType, bet);
    }
    const finalize = (map) =>
      [...map.values()].map((group) => ({
        ...group,
        roi: group.staked ? (group.profit / group.staked) * 100 : null,
        winRate: group.completed ? (group.wins / group.completed) * 100 : 0,
      }));
    return {
      bySport: finalize(sportMap).sort((a, b) => b.profit - a.profit),
      byOdds: finalize(oddsMap).sort((a, b) => a.order - b.order),
      byType: finalize(typeMap).sort((a, b) => b.profit - a.profit),
    };
  }, [settledBets]);

  const chartTotal = chartData.reduce((sum, item) => sum + Number(item.profitLoss || 0), 0);
  const positiveChartColor = "#2E7D5B";
  const negativeChartColor = "#A94442";
  const chartColor = chartTotal >= 0 ? positiveChartColor : negativeChartColor;
  const chartValues = chartData.map((item) => Number(item.profitLoss || 0));
  const chartMin = Math.min(0, ...chartValues);
  const chartMax = Math.max(0, ...chartValues);
  const zeroOffset = chartMax === chartMin ? 50 : ((chartMax - 0) / (chartMax - chartMin)) * 100;

  const chartTitle = chartView === "monthly" ? "Monthly profit/loss" : chartView === "yearly" ? "Yearly profit/loss" : "Weekly profit/loss";
  const chartDescription = chartView === "monthly" ? "Grouped by the month of each bet." : chartView === "yearly" ? "Grouped by the year of each bet." : "Grouped by Monday to Sunday week ranges.";
  const xAxisLabel = chartView === "weekly" ? "Week Range" : chartView === "monthly" ? "Month" : "Year";

  const sortedBets = [...filteredBets].sort((a, b) => {
    const dateA = parseBetDate(a.date)?.getTime() || 0;
    const dateB = parseBetDate(b.date)?.getTime() || 0;
    if (dateB !== dateA) return dateB - dateA;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  const visibleBets = showAllBets ? sortedBets : sortedBets.slice(0, 5);
  const riskWarning = stats.totalProfit < 0 && stats.longestLosingStreak >= 3;

  const resetBetForm = () => {
    setEditingBetId(null);
    setMobileAddBetOpen(false);
    // Clear any uploaded betslip too, so its legs don't carry onto the next bet.
    setBetslipImage(null);
    setBetslipExtract(null);
    setForm({ date: todayString(), sport: "AFL", stake: "", odds: "", result: "win", returnAmount: "", notes: "", bookmaker: "", betType: "", usedMultipick: false });
  };

  const startEditingBet = (bet) => {
    // The edit form lives on the dashboard, so switch to it — otherwise tapping
    // Edit from the Tracker tab just sets the bet with no visible form.
    setActivePage("app");
    setEditingBetId(bet.id);
    setMobileAddBetOpen(true);
    setForm({
      date: bet.date,
      sport: bet.sport || "Other",
      stake: String(bet.stake || ""),
      odds: String(bet.odds || ""),
      result: bet.status === "pending" ? "pending" : bet.result,
      returnAmount: String(bet.returnAmount || ""),
      notes: bet.notes || "",
      bookmaker: bet.bookmaker || "",
      betType: bet.betType || "",
      usedMultipick: bet.source === "grid_build",
    });
    setMessage("Editing bet from " + bet.date + ". Make changes and click Update Bet.");
    // Wait for the dashboard to render after the page switch, then scroll to the
    // form (fall back to the desktop form ref if the mobile one isn't mounted).
    window.setTimeout(() => {
      const target = (window.innerWidth < 768 && mobileFormRef.current) ? mobileFormRef.current : formRef.current;
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 90);
  };

  const handleAddOrUpdateBet = async (event) => {
    event.preventDefault();
    if (!supabase || !session?.user?.id) return;
    const stakeNum = Number(form.stake);
    const oddsNum = Number(form.odds || 0);
    const isPending = form.result === "pending";
    const effectiveResult = isPending ? "void" : form.result;
    const returnNum = form.result === "loss" || isPending ? 0 : Number(form.returnAmount || 0);
    if (!form.date || !stakeNum || stakeNum <= 0) return;

    const betPayload = normaliseBet({
      date: form.date,
      sport: form.sport,
      stake: stakeNum,
      odds: oddsNum,
      result: effectiveResult,
      returnAmount: returnNum,
      profitLoss: isPending ? 0 : calculateProfitLoss(effectiveResult, stakeNum, returnNum),
      notes: form.notes.trim(),
      bookmaker: (form.bookmaker || "").trim(),
      betType: form.betType || "",
      status: isPending ? "pending" : "settled",
      // "I used MultiPick" checkbox → tag the bet so it counts toward the
      // MultiPick performance stats even when logged manually.
      source: form.usedMultipick ? "grid_build" : "manual",
      // Carry the legs read from an uploaded betslip so the saved/pending bet
      // shows its leg breakdown, just like a MultiPick-built multi. The OCR gives
      // { player, line, odds, game }; we add a combined `name` ("Sam Berry 18+
      // disposals") to match MultiPick's leg shape — the compact card renders
      // `name`, the expanded view uses `player` + `line`. (On edit, legs are
      // re-applied from the original bet below.)
      legs: betslipExtract?.legs?.length
        ? betslipExtract.legs.map((leg) => ({
            name: [leg.player, leg.line].filter(Boolean).join(" ").trim() || leg.player || null,
            player: leg.player || null,
            line: leg.line ?? null,
            odds: leg.odds ?? null,
            game: leg.game || null,
          }))
        : null,
    });

    if (editingBetId) {
      // Preserve legs (the form doesn't expose them) so editing a real
      // MultiPick multi keeps its leg breakdown. Source now comes from the
      // checkbox (initialised from the bet's current source on edit).
      const original = bets.find((bet) => bet.id === editingBetId);
      const rowPayload = betToDatabaseRow(
        { ...betPayload, legs: original?.legs || null },
        session.user.id
      );
      const { data, error } = await supabase.from("bets").update(rowPayload).eq("id", editingBetId).eq("user_id", session.user.id).select().single();
      if (error) {
        setMessage("Could not update bet: " + error.message);
        return;
      }
      const updatedBet = databaseRowToBet(data);
      setBets((current) => current.map((bet) => (bet.id === editingBetId ? updatedBet : bet)));
      setSavedToast({ id: editingBetId, updated: true });
      resetBetForm();
      return;
    }

    const { data, error } = await supabase.from("bets").insert(betToDatabaseRow(betPayload, session.user.id)).select().single();
    if (error) {
      setMessage("Could not add bet: " + error.message);
      return;
    }
    const newBet = databaseRowToBet(data);
    setBets((current) => [newBet, ...current]);
    resetBetForm();
    setSavedToast({ id: newBet.id });
  };

  const deleteBet = async (id) => {
    if (!supabase) return;
    const { error } = await supabase.from("bets").delete().eq("id", id);
    if (error) {
      setMessage("Could not delete bet: " + error.message);
      return;
    }
    setBets((current) => current.filter((bet) => bet.id !== id));
    if (editingBetId === id) resetBetForm();
  };

  const saveMultiAsBet = async (multi, stake) => {
    if (!supabase || !session?.user?.id) return { error: "Please sign in first." };
    if (!multi) return { error: "No multi to save." };
    const stakeNum = Number(stake);
    if (!stakeNum || stakeNum <= 0) return { error: "Enter a stake first." };

    const betPayload = normaliseBet({
      date: todayString(),
      sport: multi.sport || "AFL",
      stake: stakeNum,
      odds: Number(multi.combinedOdds) || 0,
      result: "void",
      returnAmount: 0,
      profitLoss: 0,
      notes: `MultiPick ${multi.legCount}-leg multi`,
      betType: "Multi",
      source: "grid_build",
      status: "pending",
      legs: multi.legs || null,
    });

    const { data, error } = await supabase.from("bets").insert(betToDatabaseRow(betPayload, session.user.id)).select().single();
    if (error) return { error: error.message };
    setBets((current) => [databaseRowToBet(data), ...current]);
    return { ok: true };
  };

  const settlePendingBet = async (id, outcome) => {
    if (!supabase || !session?.user?.id) return;
    const bet = bets.find((item) => item.id === id);
    if (!bet) return;
    const stakeNum = Number(bet.stake || 0);
    const oddsNum = Number(bet.odds || 0);
    const returnAmount = outcome === "win" ? Number((stakeNum * oddsNum).toFixed(2)) : 0;
    const profitLoss = calculateProfitLoss(outcome, stakeNum, returnAmount);

    const { data, error } = await supabase
      .from("bets")
      .update({ status: "settled", result: outcome, return_amount: returnAmount, profit_loss: profitLoss })
      .eq("id", id)
      .eq("user_id", session.user.id)
      .select()
      .single();
    if (error) {
      setMessage("Could not settle bet: " + error.message);
      return;
    }
    setBets((current) => current.map((item) => (item.id === id ? databaseRowToBet(data) : item)));
  };

  const clearAllBets = async () => {
    const confirmed = window.confirm("This will permanently delete all saved bets from this account. This cannot be undone. Continue?");
    if (!confirmed || !supabase || !session?.user?.id) return;
    const { error } = await supabase.from("bets").delete().eq("user_id", session.user.id);
    if (error) {
      setMessage("Could not clear bets: " + error.message);
      return;
    }
    setBets([]);
    resetBetForm();
  };

  const downloadFile = (content, filename, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const headers = ["Date", "Sport", "Stake", "Odds", "Result", "Return", "Profit/Loss", "Notes"];
    const rows = bets.map((bet) => [csvCell(bet.date), csvCell(bet.sport), csvCell(bet.stake), csvCell(bet.odds), csvCell(bet.result), csvCell(bet.returnAmount), csvCell(bet.profitLoss), csvCell(bet.notes)]);
    const csv = [headers.map(csvCell), ...rows].map((row) => row.join(",")).join("\n");
    downloadFile(csv, "bet-grid.csv", "text/csv;charset=utf-8;");
  };

  const exportBackup = () => {
    downloadFile(JSON.stringify({ app: "Pickd", version: 2, exportedAt: new Date().toISOString(), bets }, null, 2), "pickd-backup.json", "application/json;charset=utf-8;");
  };

  const importBackup = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file || !supabase || !session?.user?.id) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const importedBets = Array.isArray(parsed) ? parsed : parsed.bets;
        if (!Array.isArray(importedBets)) {
          window.alert("That backup file does not contain a valid bet list.");
          return;
        }
        const cleanedBets = importedBets.map(normaliseBet);
        const confirmed = window.confirm("Import " + cleanedBets.length + " bets? This will add them to your online account.");
        if (!confirmed) return;
        const rows = cleanedBets.map((bet) => betToDatabaseRow(bet, session.user.id));
        const { data, error } = await supabase.from("bets").insert(rows).select();
        if (error) {
          setMessage("Could not import backup: " + error.message);
          return;
        }
        setBets((current) => [...(data || []).map(databaseRowToBet), ...current]);
      } catch (error) {
        window.alert("Could not import that backup file. Make sure it is a Pickd JSON backup.");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  };

  if (!hasSupabaseKeys) {
    return (
      <div className="min-h-screen bg-[#E8E2D4] p-8 text-[#11203B]">
        <Card className="mx-auto max-w-xl">
          <div className="p-6">
            <h1 className="text-2xl font-bold">Supabase keys missing</h1>
            <p className="mt-2 text-sm text-slate-600">Check your .env file and make sure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. Restart Vite after saving .env.</p>
          </div>
        </Card>
      </div>
    );
  }

  if (["disclaimer", "responsible", "privacy", "terms"].includes(activePage)) return <LegalPage page={activePage} setActivePage={setActivePage} />;
  if (activePage === "edge" && session) return <EdgePage setActivePage={setActivePage} onSaveMulti={saveMultiAsBet} accessToken={session?.access_token} gridBuildStats={gridBuildStats} prefill={edgePrefill} onPrefillConsumed={() => setEdgePrefill(null)} fmtMoney={fmtMoney} />;
  if (activePage === "settings" && session) return <SettingsPage setActivePage={setActivePage} bets={bets} exportCsv={exportCsv} exportBackup={exportBackup} clearAllBets={clearAllBets} fileInputRef={fileInputRef} importBackup={importBackup} darkMode={darkMode} setDarkMode={chooseTheme} onReplayTour={replayTour} unitSize={unitSize} setUnitSize={setUnitSize} showUnits={showUnits} setShowUnits={setShowUnits} />;
  if (recoveryMode) return <PasswordRecoveryScreen newPassword={newPassword} setNewPassword={setNewPassword} loading={authLoading} message={message} onSubmit={handleUpdatePassword} />;
  if (!session && activePage !== "auth") return <LandingPage setActivePage={setActivePage} setAuthMode={setAuthMode} />;
  if (!session) return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} firstName={firstName} setFirstName={setFirstName} loading={authLoading} message={message} onSubmit={handleAuthSubmit} onResetPassword={handlePasswordResetRequest} />;

  // MultiPick mini-builder card — rendered in two spots so it sits high on every
  // screen: in the mobile hero (under the stat row) and the desktop left column.
  // Shared state means only the visible copy at each breakpoint matters.
  const multipickBuilderCard = !editingBetId ? (
    <div
      style={{ background: "linear-gradient(180deg, var(--accent-soft-new), transparent)" }}
      className="rounded-2xl border border-[var(--border-new)] p-5"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent-new)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-new)]" /> MultiPick
      </div>
      <h3 className="brand-wordmark mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--text-new)]">Build a multi<span className="text-[var(--accent-new)]">.</span></h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-2-new)]">Pick one or more games, set it up, and we’ll build it on real form + live odds.</p>

      {/* Upcoming-games scroller */}
      <div className="mt-3.5 -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 snap-x [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {mpGamesLoading ? (
          [0, 1, 2].map((skeleton) => (
            <div key={skeleton} className="h-[104px] w-[150px] shrink-0 animate-pulse rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)]" />
          ))
        ) : mpGames.length === 0 ? (
          <div className="w-full rounded-xl border border-dashed border-[var(--border-new)] px-3 py-4 text-center text-[12px] text-[var(--text-3-new)]">
            No upcoming {mpSport} games right now — you can still build across the slate.
          </div>
        ) : (
          mpGames.map((game) => {
            const selected = mpGameIds.includes(game.id);
            return (
              <button
                key={game.id}
                type="button"
                onClick={() => setMpGameIds((prev) => prev.includes(game.id) ? prev.filter((id) => id !== game.id) : [...prev, game.id])}
                className={"relative snap-start shrink-0 w-[150px] rounded-xl border p-2.5 text-center transition-colors " + (selected ? "border-[var(--accent-new)] bg-[var(--accent-soft-new)]" : "border-[var(--border-new)] bg-[var(--surface-new)] hover:border-[var(--border-strong-new)]")}
              >
                {selected ? <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent-new)] text-[10px] font-bold leading-none text-[var(--bg-new)]">✓</span> : null}
                <div className="mb-2 flex justify-center">
                  <span className="rounded-full bg-[var(--surface-2-new)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-[var(--text-2-new)]">{timeUntilGame(game.commenceTime)}</span>
                </div>
                <div className="flex items-center justify-center gap-1.5">
                  <div className="flex flex-1 flex-col items-center gap-1">
                    <TeamCrest team={game.homeTeam} className="h-7 w-7" />
                    <span className="text-[10px] font-semibold text-[var(--text-new)]">{teamShort(game.homeTeam)}</span>
                  </div>
                  <span className="text-[10px] font-bold text-[var(--text-3-new)]">VS</span>
                  <div className="flex flex-1 flex-col items-center gap-1">
                    <TeamCrest team={game.awayTeam} className="h-7 w-7" />
                    <span className="text-[10px] font-semibold text-[var(--text-new)]">{teamShort(game.awayTeam)}</span>
                  </div>
                </div>
                <div className="mt-2 text-[9.5px] text-[var(--text-3-new)]">{gameKickoff(game.commenceTime)}</div>
              </button>
            );
          })
        )}
      </div>

      {/* One compact control row: sport / legs / odds / risk */}
      <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Sport", value: mpSport, set: setMpSport, options: ["AFL", "NBA"] },
          { label: "Legs", value: mpLegs, set: setMpLegs, options: ["Any", "2", "3", "4", "5"] },
          { label: "Odds", value: mpOdds, set: setMpOdds, options: ["$2.00", "$3.00", "$5.00", "$10.00", "Custom"] },
          { label: "Risk", value: mpRisk, set: setMpRisk, options: ["Safer", "Balanced", "Aggressive", "Best Chance"] },
        ].map((ctrl) => (
          <label key={ctrl.label} className="flex flex-col gap-1">
            <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">{ctrl.label}</span>
            <select
              value={ctrl.value}
              onChange={(event) => ctrl.set(event.target.value)}
              className="cursor-pointer rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none hover:border-[var(--border-strong-new)] focus:border-[var(--text-new)]"
            >
              {ctrl.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        ))}
      </div>

      {mpOdds === "Custom" ? (
        <label className="mt-2.5 flex flex-col gap-1">
          <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">Custom target odds</span>
          <input
            type="number"
            min="1"
            step="0.01"
            inputMode="decimal"
            value={mpOddsCustom}
            onChange={(event) => setMpOddsCustom(event.target.value)}
            placeholder="e.g. 4.50"
            className="rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none hover:border-[var(--border-strong-new)] focus:border-[var(--text-new)] placeholder:text-[var(--text-3-new)]"
          />
        </label>
      ) : null}

      <label className="mt-2.5 flex flex-col gap-1">
        <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-3-new)]">Bookmaker</span>
        <select
          value={mpBook}
          onChange={(event) => setMpBook(event.target.value)}
          className="cursor-pointer rounded-lg border border-[var(--border-new)] bg-[var(--surface-new)] px-2.5 py-2 text-[13px] text-[var(--text-new)] outline-none hover:border-[var(--border-strong-new)] focus:border-[var(--text-new)]"
        >
          <option value="">Best available</option>
          <option value="sportsbet">Sportsbet</option>
          <option value="tab">TAB</option>
          <option value="ladbrokes_au">Ladbrokes</option>
          <option value="neds">Neds</option>
          <option value="pointsbetau">PointsBet</option>
          <option value="unibet">Unibet</option>
        </select>
      </label>

      <Button onClick={goBuildMulti} className="mt-4 w-full py-3 text-[14px]">
        {mpGameIds.length >= 2 ? `Make multi · ${mpGameIds.length} games` : mpGameIds.length === 1 ? "Make this multi" : "Make the multi"} <span className="ml-0.5">→</span>
      </Button>

      <div className="mt-2.5 text-center text-[11.5px] text-[var(--text-3-new)]">
        {entitlement.subscribed
          ? <span className="text-[var(--positive-new)]">Pro · unlimited builds</span>
          : <><span className="mono-nums font-semibold text-[var(--text-new)]">{Math.max(0, entitlement.limit - entitlement.usage)}</span> of <span className="mono-nums">{entitlement.limit}</span> free builds left this week</>}
      </div>
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl">

          <TopNav activePage={activePage} setActivePage={setActivePage} handleLogout={handleLogout} />

          {showTour ? <OnboardingTour initialName={userFirstName} onFinish={finishTour} onSkip={dismissTour} /> : null}

          {/* Mobile-specific block hidden — mobile now uses the same Layout B
              content as desktop via responsive Tailwind classes (md:text-[52px]
              falls back to text-[40px], grid-cols collapse to 1col, etc.). */}
          <div className="hidden">
            <header className="space-y-2 border-b border-[var(--border-new)] pb-4">
              <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">{new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })}</p>
              <h1 className="text-[34px] font-semibold leading-[0.95] tracking-[-0.04em]">Track every bet.</h1>
              <p className="text-xs text-[var(--text-3-new)]">{session.user.email}</p>
            </header>

            {message ? <Card><div className="p-4 text-sm text-slate-700">{message}</div></Card> : null}
            {loadingBets ? <Card><div className="p-4 text-sm text-slate-700">Loading your saved bets...</div></Card> : null}
            {riskWarning ? <Card className="border-[#D9A39B] bg-[#F3DDD7]"><div className="p-4 text-sm text-[#A94442]">Warning: you are currently down overall and have had a losing streak of {stats.longestLosingStreak} bets. Consider reducing stake size or taking a break.</div></Card> : null}

            <Card>
              <div className="space-y-4 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#11203B]">Performance summary</p>
                    <p className="mt-1 text-xs text-slate-500">Profit/loss, ROI and win rate at a glance.</p>
                  </div>
                  <select
                    value={selectedSportFilter}
                    onChange={(event) => {
                      setSelectedSportFilter(event.target.value);
                      setShowAllBets(false);
                    }}
                    className="max-w-[130px] rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs font-medium outline-none focus:border-[#11203B] focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="All sports">All sports</option>
                    <option value="AFL">AFL</option>
                    <option value="NRL">NRL</option>
                    <option value="Soccer">Soccer</option>
                    <option value="Basketball">Basketball</option>
                    <option value="Cricket">Cricket</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div className={"rounded-2xl border p-4 " + (stats.totalProfit >= 0 ? "border-[#9BCBB2] bg-[#DDEFE5]" : "border-[#D9A39B] bg-[#F3DDD7]")}>
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Profit/Loss</p>
                  <p className={"mt-1 text-3xl font-bold " + (stats.totalProfit >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(stats.totalProfit)}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className={(stats.roi >= 0 ? "border-[#9BCBB2] bg-[#DDEFE5]" : "border-[#D9A39B] bg-[#F3DDD7]") + " rounded-2xl border p-4"}>
                    <p className={(stats.roi >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]") + " text-xs font-medium uppercase tracking-wide"}>ROI</p>
                    <p className={(stats.roi >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]") + " mt-1 text-xl font-bold"}>{stats.roi.toFixed(1)}%</p>
                  </div>
                  <div className="rounded-2xl bg-[#E8E2D4] p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Win Rate</p>
                    <p className="mt-1 text-xl font-bold text-[#11203B]">{stats.winRate.toFixed(1)}%</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-[#9BCBB2] bg-[#DDEFE5] p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Wins</p>
                    <p className="mt-1 text-xl font-bold text-[#2E7D5B]">{stats.wins}</p>
                  </div>
                  <div className="rounded-2xl border border-[#D9A39B] bg-[#F3DDD7] p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Losses</p>
                    <p className="mt-1 text-xl font-bold text-[#A94442]">{stats.losses}</p>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{chartTitle}</h2>
                    <p className="text-xs text-slate-500">{chartDescription}</p>
                  </div>
                  <select value={chartView} onChange={(event) => setChartView(event.target.value)} className="rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-xs outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200">
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
                <div className="mt-4 h-56">
                  {chartData.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={20} />
                        <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={formatCompactCurrency} />
                        <Tooltip content={<ChartTooltip />} />
                        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                        <Bar dataKey="profitLoss" radius={[8, 8, 0, 0]}>
                          {chartData.map((entry) => <Cell key={entry.sortKey} fill={entry.profitLoss >= 0 ? positiveChartColor : negativeChartColor} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : <div className="flex h-full items-center justify-center rounded-2xl bg-[#E8E2D4] text-sm text-slate-500">Add your first bet to see the graph.</div>}
                </div>
              </div>
            </Card>

            <Card className="border-[#11203B]/20">
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-sm font-semibold text-[#11203B]">Open MultiPick</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Explore player markets, game analysis and example multis.</p>
                </div>
                <Button onClick={() => setActivePage("edge")} className="w-full rounded-2xl py-3 text-base font-semibold">Open MultiPick</Button>
              </div>
            </Card>

            <Card>
              <div className="grid grid-cols-2 gap-3 p-4">
                <div className="rounded-2xl border border-[#2E7D5B]/25 bg-[#2E7D5B]/10 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Biggest Win</p>
                  <p className="mt-1 text-lg font-bold text-[#2E7D5B]">{formatCurrency(stats.biggestWin)}</p>
                </div>
                <div className="rounded-2xl border border-[#A94442]/25 bg-[#A94442]/10 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Biggest Loss</p>
                  <p className="mt-1 text-lg font-bold text-[#A94442]">{formatCurrency(stats.biggestLoss)}</p>
                </div>
                <div className="rounded-2xl bg-[#E8E2D4] p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Win Streak</p>
                  <p className="mt-1 text-lg font-bold text-[#11203B]">{stats.longestWinningStreak} bets</p>
                </div>
                <div className="rounded-2xl bg-[#E8E2D4] p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Losing Streak</p>
                  <p className="mt-1 text-lg font-bold text-[#11203B]">{stats.longestLosingStreak} bets</p>
                </div>
              </div>
            </Card>

            <Card>
              <div ref={mobileFormRef} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{editingBetId ? "Edit bet" : "Add a bet"}</h2>
                    <p className="mt-1 text-xs text-slate-500">{mobileAddBetOpen ? "Enter the details below." : "Tap to quickly log a new bet."}</p>
                  </div>
                  <Button
                    type="button"
                    variant={mobileAddBetOpen ? "outline" : "primary"}
                    onClick={() => {
                      if (mobileAddBetOpen) resetBetForm();
                      else setMobileAddBetOpen(true);
                    }}
                    className="px-4"
                  >
                    {mobileAddBetOpen ? "Cancel" : "Add Bet"}
                  </Button>
                </div>

                {mobileAddBetOpen ? (
                  <form onSubmit={handleAddOrUpdateBet} className="mt-5 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1 text-sm font-medium">Date<Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
                      <label className="space-y-1 text-sm font-medium">Sport<select value={form.sport} onChange={(event) => setForm({ ...form, sport: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="AFL">AFL</option><option value="NRL">NRL</option><option value="Soccer">Soccer</option><option value="Basketball">Basketball</option><option value="Cricket">Cricket</option><option value="Other">Other</option></select></label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      {["win", "loss", "void", "pending"].map((result) => (
                        <button
                          key={result}
                          type="button"
                          onClick={() => setForm({ ...form, result })}
                          className={"rounded-xl border px-3 py-2.5 text-sm font-semibold capitalize " + (form.result === result ? "border-[#11203B] bg-[#11203B] text-white" : "border-slate-300 bg-[#FAF7EF] text-[#11203B]")}
                        >
                          {result}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <label className="space-y-1 text-sm font-medium">Stake<Input type="number" min="0" step="0.01" placeholder="50" value={form.stake} onChange={(event) => setForm({ ...form, stake: event.target.value })} /></label>
                      <label className="space-y-1 text-sm font-medium">Odds<Input type="number" min="0" step="0.01" placeholder="2.00" value={form.odds} onChange={(event) => setForm({ ...form, odds: event.target.value })} /></label>
                      <label className="space-y-1 text-sm font-medium">Return<Input type="number" min="0" step="0.01" placeholder="100" value={form.returnAmount} onChange={(event) => setForm({ ...form, returnAmount: event.target.value })} disabled={form.result === "loss" || form.result === "pending"} /></label>
                    </div>

                    <label className="space-y-1 text-sm font-medium">Notes<Input placeholder="Optional note" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1 text-sm font-medium">Bet type<select value={form.betType} onChange={(event) => setForm({ ...form, betType: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="">—</option><option value="Single">Single</option><option value="Multi">Multi</option><option value="Player prop">Player prop</option><option value="Head-to-head">Head-to-head</option><option value="Line">Line</option><option value="Total">Total</option><option value="Other">Other</option></select></label>
                      <label className="space-y-1 text-sm font-medium">Bookmaker<Input placeholder="e.g. Sportsbet" value={form.bookmaker} onChange={(event) => setForm({ ...form, bookmaker: event.target.value })} /></label>
                    </div>
                    <MultipickCheckbox checked={form.usedMultipick} onChange={(v) => setForm({ ...form, usedMultipick: v })} />
                    <div className="rounded-xl bg-[#E8E2D4] p-3 text-sm text-slate-700">Estimated profit/loss: {form.result === "pending" ? "Pending — settle it after the game" : formatCurrency(calculateProfitLoss(form.result, form.stake, form.result === "loss" ? 0 : form.returnAmount))}</div>
                    <Button type="submit" className="w-full py-3 text-base font-semibold">{editingBetId ? "Update Bet" : "Save Bet"}</Button>
                  </form>
                ) : null}
              </div>
            </Card>

            <Card>
              <div className="p-4">
                <button type="button" onClick={() => setMobileBetsOpen((current) => !current)} className="flex w-full items-center justify-between gap-3 text-left">
                  <div>
                    <h2 className="text-lg font-semibold">Recent bets</h2>
                    <p className="text-xs text-slate-500">{filteredBets.length} bet{filteredBets.length === 1 ? "" : "s"}{selectedSportFilter !== "All sports" ? " · " + selectedSportFilter : ""} · tap to {mobileBetsOpen ? "hide" : "view"}</p>
                  </div>
                  <span className="text-2xl leading-none text-slate-500">{mobileBetsOpen ? "−" : "+"}</span>
                </button>

                {mobileBetsOpen ? (
                  <>
                    <div className="mt-4 space-y-3">
                      {visibleBets.map((bet) => (
                        <div key={bet.id} className={"rounded-2xl border border-slate-200 p-4 " + (editingBetId === bet.id ? "bg-slate-50" : "bg-[#FAF7EF]")}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-[#11203B]">{bet.sport || "Other"} · {bet.date}</p>
                              <p className="mt-1 text-xs capitalize text-slate-500">{bet.result} · Stake {formatCurrency(bet.stake)} · Odds {bet.odds || "-"}</p>
                            </div>
                            <p className={"text-base font-bold " + (bet.profitLoss >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(bet.profitLoss)}</p>
                          </div>
                          {bet.notes ? <p className="mt-3 text-sm text-slate-600">{bet.notes}</p> : null}
                          <div className="mt-4 grid grid-cols-2 gap-2">
                            <Button variant="outline" onClick={() => startEditingBet(bet)} className="w-full">Edit</Button>
                            <Button variant="ghost" onClick={() => deleteBet(bet.id)} className="w-full">Delete</Button>
                          </div>
                        </div>
                      ))}
                      {!bets.length ? <div className="rounded-2xl bg-[#E8E2D4] p-8 text-center text-sm text-slate-500">No bets added yet.</div> : null}
                    </div>
                    {filteredBets.length > 5 ? <div className="mt-4 flex justify-center"><button type="button" onClick={() => setShowAllBets((current) => !current)} className="text-sm font-semibold text-[#11203B] underline">{showAllBets ? "Show less" : `View all ${filteredBets.length}`}</button></div> : null}
                  </>
                ) : null}
              </div>
            </Card>

          </div>


          {/* Main content — now shows at every screen size (mobile parity).
              All inner sections have responsive Tailwind classes so typography
              and grids scale gracefully. TopNav stays desktop-only above;
              mobile uses the bottom nav for navigation. The key={activePage}
              triggers a remount on page switch so the page-fade-in CSS
              animation re-fires every time the user navigates. */}
          <div key={activePage} className={"space-y-6 " + (navigating ? "page-leaving" : "page-fade-in")}>
            {/* Dismissible "Go Pro" strip — dashboard only, free users only. */}
            {activePage === "app" && !entitlement.subscribed && !proStripDismissed ? (
              <div
                style={{ background: "linear-gradient(90deg, var(--accent-soft-new), transparent)" }}
                className="flex items-center gap-3 rounded-xl border border-[var(--border-new)] px-4 py-3"
              >
                <span className="shrink-0 text-[var(--accent-new)]">✦</span>
                <span className="flex-1 text-[13px] leading-snug text-[var(--text-2-new)]">
                  <span className="font-semibold text-[var(--text-new)]">Unlimited builds with Pickd Pro.</span> <span className="text-[var(--text-3-new)]">$4.99/wk · founding price.</span>
                </span>
                <Button onClick={startUpgrade} disabled={upgrading} className="shrink-0">{upgrading ? "Starting…" : "Go Pro"}</Button>
                <button type="button" onClick={dismissProStrip} aria-label="Dismiss" className="shrink-0 text-[var(--text-3-new)] transition-colors hover:text-[var(--text-new)]">✕</button>
              </div>
            ) : null}

          {/* ───────────── MOBILE HERO + CAROUSEL (under md) ─────────────
              Concept #02 — Hero stat + horizontal scroll. Mobile gets a
              dedicated layout: greeting + massive headline number, a
              horizontal-scroll carousel of secondary stats, a quick-add
              panel, and a recent-activity feed. Desktop view is unchanged
              and the editorial header/stat-strip below are hidden under
              the md breakpoint via `hidden md:`. */}
          {(() => {
            // Friendly first name from the auth email (falls back to "there").
            const emailLocal = (session?.user?.email || "").split("@")[0] || "";
            const firstName = emailLocal
              .replace(/[._-]/g, " ")
              .split(" ")[0]
              .replace(/^./, (c) => c.toUpperCase());
            const isTracker = activePage === "tracker";
            const heroNumber = isTracker ? String(bets.length) : fmtMoney(stats.totalProfit);
            const heroLabel = isTracker ? "Bets logged" : "Profit / loss";
            const heroTone = isTracker
              ? "text-[var(--text-new)]"
              : stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]";
            return (
              <section className="md:hidden">
                {/* Hero block */}
                <div className="border-b border-[var(--border-new)] pb-7 pt-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">
                    <span className="text-[var(--accent-new)]">●</span> Live · {new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })}
                  </p>
                  <h1 className="brand-wordmark mt-2 text-[22px] font-semibold tracking-[-0.025em] text-[var(--text-new)]">Hey, {firstName || "there"}.</h1>
                  <div className={"mono-nums mt-5 text-[64px] font-semibold leading-[0.9] tracking-[-0.045em] " + heroTone}>{heroNumber}</div>
                  <div className="mt-3 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">{heroLabel}</div>
                  {!isTracker ? (
                    <div className="mt-1.5 mono-nums text-[16px] font-medium text-[var(--text-3-new)]">{fmtAlt(stats.totalProfit)}</div>
                  ) : null}
                  {!isTracker ? (
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--text-3-new)]">
                      <span>
                        <span className={subStats.weekProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]"}>
                          {subStats.weekProfit >= 0 ? "▲ +" : "▼ "}<span className="mono-nums">{formatCurrency(subStats.weekProfit).replace("-", "")}</span>
                        </span>
                        <span className="ml-1">this week</span>
                      </span>
                      <span><span className="mono-nums text-[var(--text-2-new)]">{subStats.settledCount}</span> settled</span>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--text-3-new)]">
                      <span><span className="mono-nums text-[var(--text-2-new)]">{subStats.settledCount}</span> settled</span>
                      <span><span className="mono-nums text-[var(--text-2-new)]">{subStats.pendingCount}</span> pending</span>
                    </div>
                  )}
                </div>

                {/* Horizontal scroll carousel — Win rate / ROI / In flight.
                    -mx-5 + px-5 lets the cards bleed to the screen edge and
                    flow off the right, signalling there's more to scroll. */}
                <div className="-mx-5 mt-5 flex gap-3 overflow-x-auto px-5 pb-2 snap-x [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                  <button type="button" onClick={() => openStatDetail("winrate")} className="snap-start shrink-0 w-[160px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4 text-left active:opacity-80">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Win rate</div>
                    <div className="mono-nums mt-2.5 text-[24px] font-semibold leading-none">{stats.winRate.toFixed(1)}%</div>
                    <div className="mt-2.5 text-[10px] text-[var(--text-3-new)]">
                      {subStats.winRateDelta != null ? (
                        <span className={subStats.winRateDelta >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]"}>{subStats.winRateDelta >= 0 ? "▲ +" : "▼ "}<span className="mono-nums">{Math.abs(subStats.winRateDelta).toFixed(1)}pp</span></span>
                      ) : <span>—</span>}
                      <span className="ml-1">mo/mo</span>
                    </div>
                  </button>
                  <button type="button" onClick={() => openStatDetail("roi")} className="snap-start shrink-0 w-[160px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4 text-left active:opacity-80">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Return on stake</div>
                    <div className={"mono-nums mt-2.5 text-[24px] font-semibold leading-none " + (stats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{(stats.roi >= 0 ? "+" : "") + stats.roi.toFixed(1)}%</div>
                    <div className="mt-2.5 text-[10px] text-[var(--text-3-new)]"><span className="mono-nums text-[var(--text-2-new)]">{fmtMoney(stats.totalStaked, false)}</span> staked</div>
                  </button>
                  <button type="button" onClick={() => openStatDetail("inflight")} className="snap-start shrink-0 w-[160px] rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)] p-4 text-left active:opacity-80">
                    <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">In flight</div>
                    <div className="mono-nums mt-2.5 text-[24px] font-semibold leading-none">{formatCurrency(subStats.inFlightTotal)}</div>
                    <div className="mt-2.5 text-[10px] text-[var(--text-3-new)]"><span className="mono-nums text-[var(--text-2-new)]">{subStats.pendingCount}</span> pending{subStats.pendingTonight > 0 ? <> · <span className="mono-nums">{subStats.pendingTonight}</span> tonight</> : null}</div>
                  </button>
                  {/* Edge card — only on Dashboard, links to MultiPick page */}
                  {!isTracker ? (
                    <button type="button" onClick={() => setActivePage("edge")} className="snap-start shrink-0 w-[160px] rounded-2xl border border-[var(--accent-new)] bg-[var(--accent-soft-new)] p-4 text-left active:opacity-80">
                      <div className="text-[9px] font-medium uppercase tracking-[0.10em] text-[var(--accent-new)]">MultiPick</div>
                      <div className="mt-2.5 text-[16px] font-semibold leading-[1.1] text-[var(--text-new)]">Build a multi <span aria-hidden>→</span></div>
                      <div className="mt-2.5 text-[10px] text-[var(--text-3-new)]">AI · form-backed legs</div>
                    </button>
                  ) : null}
                </div>

                {/* MultiPick builder — mobile placement. This whole section is
                    md:hidden, so this copy only shows on phones, sitting right
                    under the stat row (desktop renders it in the left column). */}
                {!isTracker ? <div className="mt-7">{multipickBuilderCard}</div> : null}

              </section>
            );
          })()}

          {/* 2026 Layout B editorial header — 52px display title, eyebrow
              meta (date + email), action buttons + sport filter right-aligned.
              Hidden on mobile (the dedicated hero above takes its place). */}
          <header className="hidden gap-10 border-b border-[var(--border-new)] pb-9 md:grid md:grid-cols-[1.4fr_1fr] md:items-end">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">{activePage === "tracker" ? `${new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })} — ${bets.length} bets logged` : `${new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })} · ${session.user.email}`}</p>
              <h1 className="mt-3.5 text-[40px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[52px]">
                {activePage === "tracker"
                  ? <>My bets,<br />by the numbers.</>
                  : userFirstName
                  ? <>Welcome back,<br />{userFirstName}<span className="text-[var(--accent-new)]">.</span></>
                  : <>Track every bet.<br />Read every result.</>}
              </h1>
              <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[var(--text-2-new)]">
                {activePage === "tracker"
                  ? "Every wager logged, settled or pending. Filter, sort, and review your bet history."
                  : "Your performance, by the numbers. Profit/loss, ROI, win rate, weekly trends — all backed by your saved bets."}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2.5">
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
                <Button variant="outline" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><span className="mr-1 text-base font-normal leading-none">+</span> Add bet</Button>
                <Button onClick={() => setActivePage("edge")}>Build a multi</Button>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)]">
                <select
                  value={selectedSportFilter}
                  onChange={(event) => { setSelectedSportFilter(event.target.value); setShowAllBets(false); }}
                  className="cursor-pointer rounded-full border border-[var(--border-new)] bg-transparent px-3 py-1.5 text-[12px] font-normal normal-case tracking-normal text-[var(--text-2-new)] outline-none hover:border-[var(--border-strong-new)] focus:border-[var(--text-new)]"
                >
                  <option value="All sports">All sports</option>
                  <option value="AFL">AFL</option>
                  <option value="NRL">NRL</option>
                  <option value="Soccer">Soccer</option>
                  <option value="Basketball">Basketball</option>
                  <option value="Cricket">Cricket</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
          </header>

          {message ? <Card><div className="p-4 text-sm text-slate-700">{message}</div></Card> : null}
          {loadingBets ? <Card><div className="p-4 text-sm text-slate-700">Loading your saved bets...</div></Card> : null}
          {riskWarning ? <Card className="border-[#D9A39B] bg-[#F3DDD7]"><div className="p-4 text-sm text-[#A94442]">Warning: you are currently down overall and have had a losing streak of {stats.longestLosingStreak} bets. Consider reducing stake size or taking a break.</div></Card> : null}
          {!loadingBets && bets.length === 0 ? (
            <div className="overflow-hidden rounded-2xl border border-[var(--border-new)] bg-[var(--surface-new)]">
              <div className="grid items-center gap-6 p-6 md:grid-cols-[1fr_220px] md:p-8">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent-new)]">Welcome to Pickd</p>
                  <h2 className="brand-wordmark mt-2 text-[26px] font-bold tracking-[-0.03em] text-[var(--text-new)] md:text-[30px]">Build your first multi with MultiPick<span className="text-[var(--accent-new)]">.</span></h2>
                  <p className="mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-[var(--text-2-new)]">Pick a sport, target odds and risk — MultiPick reads real player form and live market lines to build a form-backed multi in seconds. Save it here and your dashboard fills with profit/loss, win rate and ROI.</p>
                  <div className="mt-5 flex flex-wrap gap-2.5">
                    <Button type="button" onClick={() => setActivePage("edge")} className="rounded-xl px-5 py-3">Build a multi</Button>
                    <Button type="button" variant="outline" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="rounded-xl px-5 py-3">Log a bet manually</Button>
                  </div>
                </div>
                {/* Compact, decorative MultiPick sphere — minimal point cloud,
                    transparent (no card/border), no status line or beam */}
                <div className="hidden md:block">
                  <BuildingAnimation height={200} showStatus={false} showBeam={false} bare minimal className="" />
                </div>
              </div>
            </div>
          ) : null}

          {/* Filter + feedback cards removed in Layout B port — sport filter
              lives in the header now; feedback link is in the footer. */}

          {/* Editorial stat strip — Layout B. Hairline dividers between cells,
              massive mono numerals, two-line sublines: a triangle delta (week
              or month) and a context line below. Final cell shows IN FLIGHT
              (pending bets) instead of total staked, mirroring preview B.
              Each cell is now a button — clicking opens a detail modal with a
              chart + summary, scaling up from the cell as its origin.
              Hidden on mobile — the dedicated mobile hero + carousel above
              covers these stats with a more thumb-friendly layout. */}
          <section className="hidden grid-cols-2 border-y border-[var(--border-new)] py-9 md:grid lg:grid-cols-4">
            <button type="button" onClick={() => openStatDetail("pl")} className="stat-cell relative px-0 pr-7 text-left lg:border-r lg:border-[var(--border-new)]">
              <StatHoverPreview statKey="pl" stats={stats} subStats={subStats} filteredBets={filteredBets} pendingBets={pendingBets} cumulativeData={cumulativeData} fmtMoney={fmtMoney} />
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5 flex items-center gap-1.5">{selectedSportFilter === "All sports" ? "Profit / loss" : selectedSportFilter + " P/L"}<span className="stat-cell-hint text-[var(--text-3-new)]">↗</span></div>
              <div className={"mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none " + (stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{fmtMoney(stats.totalProfit)}</div>
              <div className="mt-1.5 mono-nums text-[15px] font-medium text-[var(--text-3-new)]">{fmtAlt(stats.totalProfit)}</div>
              <div className="mt-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-[var(--text-3-new)]">
                <span className={subStats.weekProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]"}>{subStats.weekProfit >= 0 ? "▲ +" : "▼ "}<span className="mono-nums">{formatCurrency(subStats.weekProfit).replace("-", "")}</span></span>
                <span className="text-[var(--text-3-new)]">this week</span>
                <span><span className="mono-nums">{subStats.settledCount}</span> settled</span>
              </div>
            </button>
            <button type="button" onClick={() => openStatDetail("winrate")} className="stat-cell relative px-7 text-left lg:border-r lg:border-[var(--border-new)]">
              <StatHoverPreview statKey="winrate" stats={stats} subStats={subStats} filteredBets={filteredBets} pendingBets={pendingBets} cumulativeData={cumulativeData} />
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5 flex items-center gap-1.5">{selectedSportFilter === "All sports" ? "Win rate" : selectedSportFilter + " win rate"}<span className="stat-cell-hint text-[var(--text-3-new)]">↗</span></div>
              <div className="mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">{stats.winRate.toFixed(1)}%</div>
              <div className="mt-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-[var(--text-3-new)]">
                {subStats.winRateDelta != null ? (
                  <span className={subStats.winRateDelta >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]"}>{subStats.winRateDelta >= 0 ? "▲ +" : "▼ "}<span className="mono-nums">{Math.abs(subStats.winRateDelta).toFixed(1)}pp</span></span>
                ) : <span>—</span>}
                <span>mo/mo</span>
                <span><span className="mono-nums">{stats.wins}</span>W · <span className="mono-nums">{stats.losses}</span>L</span>
              </div>
            </button>
            <button type="button" onClick={() => openStatDetail("roi")} className="stat-cell relative px-0 pr-7 mt-9 text-left lg:mt-0 lg:px-7 lg:border-r lg:border-[var(--border-new)]">
              <StatHoverPreview statKey="roi" stats={stats} subStats={subStats} filteredBets={filteredBets} pendingBets={pendingBets} cumulativeData={cumulativeData} />
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5 flex items-center gap-1.5">{selectedSportFilter === "All sports" ? "Return on stake" : selectedSportFilter + " ROI"}<span className="stat-cell-hint text-[var(--text-3-new)]">↗</span></div>
              <div className={"mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none " + (stats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{(stats.roi >= 0 ? "+" : "") + stats.roi.toFixed(1)}%</div>
              <div className="mt-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-[var(--text-3-new)]">
                {subStats.roiDelta != null ? (
                  <span className={subStats.roiDelta >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]"}>{subStats.roiDelta >= 0 ? "▲ +" : "▼ "}<span className="mono-nums">{Math.abs(subStats.roiDelta).toFixed(1)}pp</span></span>
                ) : <span>—</span>}
                <span><span className="mono-nums">{fmtMoney(stats.totalStaked, false)}</span> staked</span>
              </div>
            </button>
            <button type="button" onClick={() => openStatDetail("inflight")} className="stat-cell relative px-7 mt-9 text-left lg:mt-0 lg:pl-7 lg:pr-0">
              <StatHoverPreview statKey="inflight" stats={stats} subStats={subStats} filteredBets={filteredBets} pendingBets={pendingBets} cumulativeData={cumulativeData} />
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5 flex items-center gap-1.5">In flight<span className="stat-cell-hint text-[var(--text-3-new)]">↗</span></div>
              <div className="mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">{formatCurrency(subStats.inFlightTotal)}</div>
              <div className="mt-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-[var(--text-3-new)]">
                <span className="text-[var(--text-new)]"><span className="mono-nums">{subStats.pendingCount}</span> pending</span>
                {subStats.pendingTonight > 0 ? <span><span className="mono-nums">{subStats.pendingTonight}</span> tonight</span> : <span>0 tonight</span>}
              </div>
            </button>
          </section>

          {/* Add Bet + Chart — Dashboard page only. Layout B editorial: both
              unboxed, hairline section dividers, bare-underline form inputs.
              The chart sits on the page background instead of in a card. */}
          {activePage === "app" ? (
          <section className="grid gap-10 border-b border-[var(--border-new)] py-10 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-2" ref={formRef} onPaste={editingBetId ? undefined : handleBetslipPaste}>
              {/* Desktop: the builder card leads the left column (md+). On mobile
                  it's rendered up in the hero, under the stat row, instead. */}
              <div className="mb-6 hidden md:block">{multipickBuilderCard}</div>
              <div className="mb-5 flex items-baseline justify-between">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">{editingBetId ? "Editing" : "Manual entry"}</div>
                  <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">{editingBetId ? "Edit bet" : "Add a bet"}</h2>
                </div>
                {editingBetId ? <Button type="button" variant="ghost" onClick={resetBetForm}>Cancel</Button> : null}
              </div>

              {/* Betslip OCR — paste, drag-and-drop, or file-upload a
                  screenshot of your bookmaker's slip and OpenAI vision will
                  pre-fill the form. Hidden when editing an existing bet. */}
              {!editingBetId ? (
                <div
                  onDragOver={handleBetslipDragOver}
                  onDragLeave={handleBetslipDragLeave}
                  onDrop={handleBetslipDrop}
                  style={!betslipImage && !betslipParsing ? { background: "linear-gradient(180deg, var(--accent-soft-new), transparent)" } : undefined}
                  className={"mb-4 rounded-2xl border-2 border-dashed px-5 py-6 transition-colors " + (betslipDragOver ? "border-[var(--accent-new)] bg-[var(--accent-soft-new)]" : !betslipImage && !betslipParsing ? "border-[var(--accent-new)]" : "border-[var(--border-new)] bg-[var(--surface-new)]")}
                >
                  {!betslipImage && !betslipParsing ? (
                    <label className="flex cursor-pointer flex-col items-center gap-3.5 text-center sm:flex-row sm:text-left">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-new)] text-[var(--bg-new)]">
                        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z"/><circle cx="12" cy="13.5" r="3.5"/></svg>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent-new)]">Quick add · AI vision</span>
                        <span className="mt-1 block text-[15px] font-semibold text-[var(--text-new)]">{betslipDragOver ? "Drop it — we'll read it" : "Snap or upload your betslip"}</span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--text-2-new)]">Drop, paste, or tap to upload a screenshot from any bookie — AI reads the stake, odds and every leg and fills it in.</span>
                      </span>
                      <span className="shrink-0 rounded-lg bg-[var(--accent-new)] px-4 py-2.5 text-[13px] font-semibold text-[var(--bg-new)]">Upload</span>
                      <input type="file" accept="image/*" onChange={handleBetslipFile} className="hidden" />
                    </label>
                  ) : null}
                  {betslipParsing ? (
                    <div className="flex items-center gap-3 text-[13px] text-[var(--text-2-new)]">
                      <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--border-new)] border-t-[var(--accent-new)]" />
                      Reading the betslip with AI vision…
                    </div>
                  ) : null}
                  {betslipError ? (
                    <div className="flex items-start justify-between gap-3 text-[13px] text-[var(--danger-new)]">
                      <span>{betslipError}</span>
                      <button onClick={clearBetslip} className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--text-new)]">Dismiss</button>
                    </div>
                  ) : null}
                  {betslipImage && !betslipParsing ? (
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <img src={betslipImage} alt="Betslip preview" className="h-20 w-20 shrink-0 rounded border border-[var(--border-new)] object-cover" />
                        <div className="flex-1 text-[13px] text-[var(--text-2-new)]">
                          {betslipExtract ? (
                            <>
                              <div className="text-[var(--text-new)] font-medium">Read · review and save</div>
                              <div className="mt-1 text-[12px]">
                                {betslipExtract.bookmaker ? <>From <span className="text-[var(--text-2-new)]">{betslipExtract.bookmaker}</span> · </> : null}
                                {betslipExtract.betType || "Bet"} ·{" "}
                                <span className="mono-nums">${betslipExtract.stake || "?"}</span> at <span className="mono-nums">${betslipExtract.odds || "?"}</span>
                                {betslipExtract.legs?.length ? <> · {betslipExtract.legs.length} legs</> : null}
                              </div>
                              <div className="mt-1.5 text-[11px] text-[var(--text-3-new)]">Form has been pre-filled. Edit anything that needs fixing, then save.</div>
                            </>
                          ) : (
                            <div className="text-[var(--text-3-new)]">Preview only — could not extract details.</div>
                          )}
                        </div>
                        <button onClick={clearBetslip} className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--text-new)]">Clear</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Manual entry is a collapsed extension — the betslip upload above
                  leads. Forced open while editing, or after a slip pre-fills it. */}
              {!editingBetId ? (
                <button
                  type="button"
                  onClick={() => setManualOpen((open) => !open)}
                  className="mb-4 flex w-full items-center justify-between rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)] px-4 py-3 text-left transition-colors hover:border-[var(--border-strong-new)]"
                >
                  <span>
                    <span className="block text-[13px] font-medium text-[var(--text-new)]">Or add manually</span>
                    <span className="block text-[11px] text-[var(--text-3-new)]">Type the stake, odds and result yourself</span>
                  </span>
                  <svg viewBox="0 0 12 8" className={"h-3 w-3 shrink-0 text-[var(--text-3-new)] transition-transform " + (manualOpen ? "rotate-180" : "")} fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 1.5 L6 6.5 L11 1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              ) : null}

              {(editingBetId || manualOpen) ? (
              <form onSubmit={handleAddOrUpdateBet} className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Date</span>
                    <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} className="mono-nums mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] outline-none focus:border-[var(--text-new)]" />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Sport</span>
                    <select value={form.sport} onChange={(event) => setForm({ ...form, sport: event.target.value })} className="mt-1.5 w-full cursor-pointer border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] outline-none focus:border-[var(--text-new)]"><option value="AFL">AFL</option><option value="NRL">NRL</option><option value="Soccer">Soccer</option><option value="Basketball">Basketball</option><option value="Cricket">Cricket</option><option value="Other">Other</option></select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Result</span>
                    <select value={form.result} onChange={(event) => setForm({ ...form, result: event.target.value })} className="mt-1.5 w-full cursor-pointer border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] outline-none focus:border-[var(--text-new)]"><option value="win">Win</option><option value="loss">Loss</option><option value="void">Void</option><option value="pending">Pending</option></select>
                  </label>
                </div>
                <div className="grid gap-5 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Stake</span>
                    <input type="number" min="0" step="0.01" placeholder="50" value={form.stake} onChange={(event) => setForm({ ...form, stake: event.target.value })} className="mono-nums mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] placeholder:text-[var(--text-3-new)] outline-none focus:border-[var(--text-new)]" />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Odds</span>
                    <input type="number" min="0" step="0.01" placeholder="2.00" value={form.odds} onChange={(event) => setForm({ ...form, odds: event.target.value })} className="mono-nums mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] placeholder:text-[var(--text-3-new)] outline-none focus:border-[var(--text-new)]" />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Return</span>
                    <input type="number" min="0" step="0.01" placeholder="100" value={form.returnAmount} onChange={(event) => setForm({ ...form, returnAmount: event.target.value })} disabled={form.result === "loss" || form.result === "pending"} className="mono-nums mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] placeholder:text-[var(--text-3-new)] outline-none focus:border-[var(--text-new)] disabled:opacity-50" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Notes</span>
                  <input placeholder="Optional note" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} className="mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] placeholder:text-[var(--text-3-new)] outline-none focus:border-[var(--text-new)]" />
                </label>
                <div className="grid grid-cols-2 gap-5">
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Bet type</span>
                    <select value={form.betType} onChange={(event) => setForm({ ...form, betType: event.target.value })} className="mt-1.5 w-full cursor-pointer border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] outline-none focus:border-[var(--text-new)]"><option value="">—</option><option value="Single">Single</option><option value="Multi">Multi</option><option value="Player prop">Player prop</option><option value="Head-to-head">Head-to-head</option><option value="Line">Line</option><option value="Total">Total</option><option value="Other">Other</option></select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Bookmaker</span>
                    <input placeholder="e.g. Sportsbet" value={form.bookmaker} onChange={(event) => setForm({ ...form, bookmaker: event.target.value })} className="mt-1.5 w-full border-0 border-b border-[var(--border-new)] bg-transparent py-2 text-sm text-[var(--text-new)] placeholder:text-[var(--text-3-new)] outline-none focus:border-[var(--text-new)]" />
                  </label>
                </div>
                <MultipickCheckbox checked={form.usedMultipick} onChange={(v) => setForm({ ...form, usedMultipick: v })} />
                <div className="flex items-center justify-between border-t border-[var(--border-new)] pt-4">
                  <div className="text-xs text-[var(--text-3-new)]">Est. P/L: <span className="mono-nums font-medium text-[var(--text-new)]">{form.result === "pending" ? "—" : formatCurrency(calculateProfitLoss(form.result, form.stake, form.result === "loss" ? 0 : form.returnAmount))}</span></div>
                  <Button type="submit">{editingBetId ? "Update bet" : "Save bet"}</Button>
                </div>
              </form>
              ) : null}

              {/* Recent activity — mobile only, sitting below the betslip + manual
                  entry. Desktop keeps the full history on the Tracker page. */}
              {bets.length > 0 ? (
                <div className="mt-8 border-t border-[var(--border-new)] pt-6 md:hidden">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h3 className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Recent activity</h3>
                    <button type="button" onClick={() => setActivePage("tracker")} className="text-[11px] font-medium text-[var(--accent-new)]">View all →</button>
                  </div>
                  {bets.slice(0, 5).map((bet) => {
                    const isWin = bet.result === "win";
                    const isLoss = bet.result === "loss";
                    const pl = Number(bet.profitLoss || 0);
                    return (
                      <div key={bet.id} className="grid grid-cols-[20px_1fr_auto] items-center gap-3 border-t border-[var(--border-new)] py-3">
                        <div className={"grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold " + (isWin ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : isLoss ? "bg-[var(--danger-soft-new)] text-[var(--danger-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]")}>{isWin ? "✓" : isLoss ? "✕" : "·"}</div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--text-new)]">{bet.notes || bet.betType || bet.sport || "Bet"}</div>
                          <div className="mt-0.5 text-[10px] text-[var(--text-3-new)]"><span className="mono-nums">{bet.date}</span> · <span className="mono-nums">{formatCurrency(bet.stake)}</span> stake</div>
                        </div>
                        {(isWin || isLoss) ? (
                          <div className={"mono-nums text-[13px] font-semibold " + (pl >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{pl >= 0 ? "+" : ""}{formatCurrency(pl)}</div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => settlePendingBet(bet.id, "win")} className="rounded-md bg-[var(--positive-soft-new)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--positive-new)] active:opacity-80">Won</button>
                            <button type="button" onClick={() => settlePendingBet(bet.id, "loss")} className="rounded-md bg-[var(--danger-soft-new)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--danger-new)] active:opacity-80">Lost</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="lg:col-span-3">
              <div className="mb-5 flex items-baseline justify-between">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Performance</div>
                  <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">{chartTitle}</h2>
                  <p className="text-xs text-[var(--text-3-new)]">{chartDescription}</p>
                </div>
                <div className="flex gap-2">
                  <select value={chartView} onChange={(event) => setChartView(event.target.value)} className="cursor-pointer rounded-full border border-[var(--border-new)] bg-transparent px-3 py-1.5 text-xs text-[var(--text-2-new)] outline-none hover:border-[var(--border-strong-new)]"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
                  <select value={chartType} onChange={(event) => setChartType(event.target.value)} className="cursor-pointer rounded-full border border-[var(--border-new)] bg-transparent px-3 py-1.5 text-xs text-[var(--text-2-new)] outline-none hover:border-[var(--border-strong-new)]"><option value="bar">Bar</option><option value="line">Line</option><option value="area">Area</option></select>
                </div>
              </div>
                <div className="mt-4 h-80">
                  {chartData.length ? (
                    <ResponsiveContainer width="100%" height="100%">
                      {chartType === "line" ? (
                        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} label={{ value: xAxisLabel, position: "insideBottom", offset: -10 }} />
                          <YAxis tick={{ fontSize: 11 }} tickFormatter={formatCompactCurrency} label={{ value: "Profit/Loss ($AUD)", angle: -90, position: "insideLeft", offset: -5 }} />
                          <Tooltip content={<ChartTooltip />} />
                          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                          <Line type="monotone" dataKey="profitLoss" stroke={chartColor} strokeWidth={3} dot={(props) => <circle cx={props.cx} cy={props.cy} r={4} fill={props.payload.profitLoss >= 0 ? positiveChartColor : negativeChartColor} />} activeDot={{ r: 6 }} />
                        </LineChart>
                      ) : chartType === "area" ? (
                        <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} label={{ value: xAxisLabel, position: "insideBottom", offset: -10 }} />
                          <YAxis tick={{ fontSize: 11 }} tickFormatter={formatCompactCurrency} label={{ value: "Profit/Loss ($AUD)", angle: -90, position: "insideLeft", offset: -5 }} />
                          <Tooltip content={<ChartTooltip />} />
                          <defs>
                            <linearGradient id="profitLossGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={positiveChartColor} stopOpacity={0.22} />
                              <stop offset={zeroOffset + "%"} stopColor={positiveChartColor} stopOpacity={0.16} />
                              <stop offset={zeroOffset + "%"} stopColor={negativeChartColor} stopOpacity={0.16} />
                              <stop offset="100%" stopColor={negativeChartColor} stopOpacity={0.24} />
                            </linearGradient>
                          </defs>
                          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                          <Area type="monotone" dataKey="profitLoss" stroke={chartColor} fill="url(#profitLossGradient)" strokeWidth={3} />
                        </AreaChart>
                      ) : (
                        <BarChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 30 }}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} label={{ value: xAxisLabel, position: "insideBottom", offset: -10 }} />
                          <YAxis tick={{ fontSize: 11 }} tickFormatter={formatCompactCurrency} label={{ value: "Profit/Loss ($AUD)", angle: -90, position: "insideLeft", offset: -5 }} />
                          <Tooltip content={<ChartTooltip />} />
                          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                          <Bar dataKey="profitLoss" radius={[10, 10, 0, 0]}>
                            {chartData.map((entry) => <Cell key={entry.sortKey} fill={entry.profitLoss >= 0 ? positiveChartColor : negativeChartColor} />)}
                          </Bar>
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  ) : <div className="flex h-full items-center justify-center rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)] text-sm text-[var(--text-3-new)]">Add your first bet to see the graph.</div>}
              </div>

              {/* Fills the right-column gap under the chart with a recent-bets
                  glance. lg-only: the 2/3 split (and the gap) only exist at lg+,
                  and mobile already shows recent activity under the add-bet form. */}
              {bets.length > 0 ? (
                <div className="mt-8 hidden border-t border-[var(--border-new)] pt-6 lg:block">
                  <div className="mb-2 flex items-baseline justify-between">
                    <div>
                      <div className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Recent</div>
                      <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">Latest bets</h2>
                    </div>
                    <button type="button" onClick={() => setActivePage("tracker")} className="text-[11px] font-medium text-[var(--accent-new)] hover:opacity-80">View all →</button>
                  </div>
                  <div>
                    {bets.slice(0, 5).map((bet) => {
                      const isWin = bet.result === "win";
                      const isLoss = bet.result === "loss";
                      const pl = Number(bet.profitLoss || 0);
                      return (
                        <div
                          key={bet.id}
                          className="grid w-full grid-cols-[1fr_auto] items-center gap-3 border-t border-[var(--border-new)] py-3"
                        >
                          <button
                            type="button"
                            onClick={() => { setExpandedBetId(bet.id); setActivePage("tracker"); }}
                            className="grid min-w-0 grid-cols-[24px_1fr] items-center gap-3 text-left transition-opacity hover:opacity-80"
                          >
                            <div className={"grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold " + (isWin ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : isLoss ? "bg-[var(--danger-soft-new)] text-[var(--danger-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]")}>{isWin ? "✓" : isLoss ? "✕" : "·"}</div>
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-medium text-[var(--text-new)]">{bet.notes || bet.betType || bet.sport || "Bet"}</div>
                              <div className="mt-0.5 text-[11px] text-[var(--text-3-new)]"><span className="mono-nums">{bet.date}</span> · <span className="mono-nums">{formatCurrency(bet.stake)}</span> stake{bet.bookmaker ? <> · {bet.bookmaker}</> : null}</div>
                            </div>
                          </button>
                          {(isWin || isLoss) ? (
                            <div className={"mono-nums text-[14px] font-semibold " + (pl >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{pl >= 0 ? "+" : ""}{formatCurrency(pl)}</div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button type="button" onClick={() => settlePendingBet(bet.id, "win")} className="rounded-md bg-[var(--positive-soft-new)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--positive-new)] hover:opacity-80">Won</button>
                              <button type="button" onClick={() => settlePendingBet(bet.id, "loss")} className="rounded-md bg-[var(--danger-soft-new)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--danger-new)] hover:opacity-80">Lost</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
          ) : null}

          {/* Editorial secondary stat strip — same hairline grid as the primary
              stats above. Biggest Win/Loss in mono with positive/danger tones,
              streaks in neutral text. */}
          {activePage === "app" ? (
          <section className="grid grid-cols-2 border-y border-[var(--border-new)] py-9 lg:grid-cols-4">
            <div className="relative px-0 pr-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">Biggest win</div>
              <div className="mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none text-[var(--positive-new)]">{fmtMoney(stats.biggestWin)}</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Top single-bet result</div>
            </div>
            <div className="relative px-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">Biggest loss</div>
              <div className={"mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none " + (stats.biggestLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-2-new)]")}>{fmtMoney(stats.biggestLoss)}</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Worst single-bet result</div>
            </div>
            <div className="relative px-0 pr-7 mt-9 lg:mt-0 lg:px-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">Winning streak</div>
              <div className="mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none text-[var(--positive-new)]">{stats.longestWinningStreak}<span className="text-[var(--text-3-new)] text-base font-normal"> bets</span></div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Longest consecutive run</div>
            </div>
            <div className="relative px-7 mt-9 lg:mt-0 lg:pl-7 lg:pr-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">Losing streak</div>
              <div className={"mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none " + (stats.longestLosingStreak > 0 ? "text-[var(--danger-new)]" : "text-[var(--text-2-new)]")}>{stats.longestLosingStreak}<span className="text-[var(--text-3-new)] text-base font-normal"> bets</span></div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Longest cold run</div>
            </div>
          </section>
          ) : null}

          {/* Tracker analytics block — Layout B editorial visuals. Big
              cumulative profit area chart unboxed, recent-form strip,
              and P/L-by-sport horizontal bar visualisation. */}
          {activePage === "tracker" && bets.length > 0 ? (() => {
            const settled = bets.filter(b => b.result === "win" || b.result === "loss");
            // Sort by date descending so the FIRST element is the most recent
            // settled bet, regardless of how `bets` came back from Supabase
            // (could be oldest-first or newest-first depending on the query).
            const recentForm = settled
              .slice()
              .sort((a, b) => new Date(b.date) - new Date(a.date))
              .slice(0, 20);
            const sportTotals = breakdowns.bySport.slice().sort((a, b) => (b.profit || 0) - (a.profit || 0));
            const maxSportAbs = Math.max(1, ...sportTotals.map(s => Math.abs(s.profit || 0)));
            return (
              <div className="space-y-10 border-b border-[var(--border-new)] py-10">

                {/* Cumulative profit chart — unboxed editorial */}
                <div>
                  <div className="mb-5 flex items-baseline justify-between">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Trajectory</p>
                      <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">Cumulative profit</h2>
                      <p className="mt-1 text-xs text-[var(--text-3-new)]">Running total after every settled bet</p>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Current</div>
                      <div className={"mono-nums mt-1 text-[20px] font-semibold leading-none " + (stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{fmtMoney(stats.totalProfit)}</div>
                    </div>
                  </div>
                  <div className="h-[280px]">
                    {cumulativeData.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={cumulativeData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="trackerProfitGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#4ade80" stopOpacity={0.32} />
                              <stop offset="100%" stopColor="#4ade80" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="2 4" stroke="rgba(255,255,255,0.04)" vertical={false} />
                          <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} minTickGap={40} />
                          <YAxis tickFormatter={formatCompactCurrency} tick={{ fontSize: 10, fill: "#5d5d63" }} axisLine={false} tickLine={false} width={56} />
                          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "rgba(255,255,255,0.15)", strokeWidth: 1 }} />
                          <ReferenceLine y={0} stroke="rgba(255,255,255,0.10)" strokeDasharray="2 4" />
                          <Area type="monotone" dataKey="balance" stroke="#4ade80" strokeWidth={2} fill="url(#trackerProfitGrad)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="grid h-full place-items-center rounded-xl border border-dashed border-[var(--border-new)] text-sm text-[var(--text-3-new)]">Settle a bet to see your trajectory</div>
                    )}
                  </div>
                </div>

                {/* Recent form + Sport P/L bars side-by-side */}
                <div className="grid gap-9 md:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Recent form</p>
                    <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">Last {recentForm.length} settled</h2>
                    <p className="mt-1 text-xs text-[var(--text-3-new)]">Most recent on the left · green = win, red = loss</p>
                    <div className="mt-5 flex flex-wrap gap-1.5">
                      {recentForm.map((bet) => (
                        <div
                          key={bet.id}
                          title={`${bet.date} · ${bet.sport || "Other"} · ${bet.result.toUpperCase()} · ${formatCurrency(bet.profitLoss)}`}
                          className={"h-6 w-6 rounded " + (bet.result === "win" ? "bg-[var(--positive-new)]" : "bg-[var(--danger-new)]")}
                          style={{ opacity: bet.result === "win" ? 0.85 : 0.7 }}
                        />
                      ))}
                      {recentForm.length === 0 ? <div className="text-xs text-[var(--text-3-new)]">No settled bets yet.</div> : null}
                    </div>
                    {recentForm.length > 0 ? (
                      <div className="mt-4 flex gap-5 text-xs text-[var(--text-3-new)]">
                        <span>Wins <span className="mono-nums ml-1 font-medium text-[var(--positive-new)]">{recentForm.filter(b => b.result === "win").length}</span></span>
                        <span>Losses <span className="mono-nums ml-1 font-medium text-[var(--danger-new)]">{recentForm.filter(b => b.result === "loss").length}</span></span>
                        <span>Strike rate <span className="mono-nums ml-1 font-medium text-[var(--text-2-new)]">{Math.round((recentForm.filter(b => b.result === "win").length / recentForm.length) * 100)}%</span></span>
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">By sport</p>
                    <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">Where the P/L lives</h2>
                    <p className="mt-1 text-xs text-[var(--text-3-new)]">Bar width relative to your biggest sport result</p>
                    <div className="mt-5 space-y-3.5">
                      {sportTotals.length ? sportTotals.map((s) => {
                        const widthPct = Math.max(2, (Math.abs(s.profit || 0) / maxSportAbs) * 100);
                        const positive = (s.profit || 0) >= 0;
                        return (
                          <div key={s.key}>
                            <div className="mb-1 flex items-baseline justify-between">
                              <span className="text-[13px] text-[var(--text-2-new)]">{s.key}</span>
                              <span className={"mono-nums text-[13px] font-medium " + (positive ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{formatCurrency(s.profit || 0)}</span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2-new)]">
                              <div
                                className={"h-full rounded-full " + (positive ? "bg-[var(--positive-new)]" : "bg-[var(--danger-new)]")}
                                style={{ width: `${widthPct}%`, opacity: 0.85 }}
                              />
                            </div>
                            <div className="mt-1 text-[10px] uppercase tracking-[0.06em] text-[var(--text-3-new)]">
                              <span className="mono-nums">{s.n || 0}</span> bets · <span className="mono-nums">{s.winRate != null ? `${s.winRate.toFixed(0)}%` : "—"}</span> win rate
                            </div>
                          </div>
                        );
                      }) : <div className="text-xs text-[var(--text-3-new)]">No bets yet.</div>}
                    </div>
                  </div>
                </div>

                {/* MultiPick performance — when present */}
                {gridBuildStats.count > 0 ? (
                  <div className="border-t border-[var(--border-new)] pt-8">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">MultiPick AI</p>
                        <h2 className="mt-1 text-[20px] font-medium tracking-[-0.015em] text-[var(--text-new)]">How AI-built multis have gone</h2>
                      </div>
                    </div>
                    <div className="mt-5 grid grid-cols-2 gap-y-5 md:grid-cols-4">
                      <div>
                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Multis picked</div>
                        <div className="mono-nums mt-2 text-[24px] font-semibold leading-none text-[var(--text-new)]">{gridBuildStats.count}</div>
                      </div>
                      <div className="md:border-l md:border-[var(--border-new)] md:pl-6">
                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Won / Lost</div>
                        <div className="mono-nums mt-2 text-[24px] font-semibold leading-none">
                          <span className="text-[var(--positive-new)]">{gridBuildStats.wins}</span><span className="text-[var(--text-3-new)]"> / </span><span className="text-[var(--danger-new)]">{Math.max(0, gridBuildStats.completed - gridBuildStats.wins)}</span>
                        </div>
                      </div>
                      <div className="md:border-l md:border-[var(--border-new)] md:pl-6">
                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Profit / loss</div>
                        <div className={"mono-nums mt-2 text-[24px] font-semibold leading-none " + (gridBuildStats.profit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{fmtMoney(gridBuildStats.profit)}</div>
                      </div>
                      <div className="md:border-l md:border-[var(--border-new)] md:pl-6">
                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">ROI</div>
                        <div className={"mono-nums mt-2 text-[24px] font-semibold leading-none " + (gridBuildStats.roi == null ? "text-[var(--text-3-new)]" : gridBuildStats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>
                          {gridBuildStats.roi == null ? "—" : `${gridBuildStats.roi >= 0 ? "+" : ""}${gridBuildStats.roi.toFixed(1)}%`}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })() : null}

          {/* Bet history — Tracker page only. Layout B editorial table.
              Top: status filter pills + sort dropdown. Below: proper table
              with column headers (BET / DATE / STAKE / RETURN / P/L / STATUS),
              hairline borders, mono numerals, status dots and sport tags. */}
          {activePage === "tracker" ? (() => {
            // Include settled + pending bets in the table, filtered by sport.
            const tableBets = selectedSportFilter === "All sports"
              ? bets
              : bets.filter(b => (b.sport || "Other") === selectedSportFilter);
            const counts = {
              all: tableBets.length,
              pending: tableBets.filter(b => b.result === "pending" || b.status === "pending").length,
              won: tableBets.filter(b => b.result === "win").length,
              lost: tableBets.filter(b => b.result === "loss").length,
            };
            const filtered = statusFilter === "all" ? tableBets
              : statusFilter === "won" ? tableBets.filter(b => b.result === "win")
              : statusFilter === "lost" ? tableBets.filter(b => b.result === "loss")
              : statusFilter === "pending" ? tableBets.filter(b => b.result === "pending" || b.status === "pending")
              : tableBets;
            const showing = showAllBets ? filtered : filtered.slice(0, 6);
            const dotClass = (r) => r === "win" ? "bg-[var(--positive-new)]" : r === "loss" ? "bg-[var(--danger-new)]" : r === "pending" ? "bg-[var(--warning-new)]" : "bg-[var(--text-3-new)]";
            const statusLabel = (r) => r === "win" ? "Won" : r === "loss" ? "Lost" : r === "pending" ? "Pending" : "Void";
            const statusColor = (r) => r === "win" ? "text-[var(--positive-new)]" : r === "loss" ? "text-[var(--danger-new)]" : r === "pending" ? "text-[var(--warning-new)]" : "text-[var(--text-3-new)]";
            const betTitle = (bet) => {
              const legCount = Array.isArray(bet.legs) ? bet.legs.length : 0;
              if (legCount >= 2) return `${legCount}-leg multi`;
              if (bet.betType) return bet.betType;
              return "Single";
            };
            // Shared expansion helper — same summary + leg detail JSX used by
            // both the desktop table row and the mobile card. Without this
            // the mobile cards would have to duplicate ~200 lines of leg
            // rendering (achievement pill, target marker, fallback states).
            // Returns the full detail panel with grid-rows transition wrapper.
            const renderBetExpansion = (bet, isOpen) => {
              const legs = Array.isArray(bet.legs) ? bet.legs : [];
              return (
                <div className={"grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out " + (isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                  <div className="overflow-hidden">
                    <div className="px-4 pb-6 pt-1 md:px-6 md:pt-2 md:pb-7">
                      {/* Summary cells — 2x2 on mobile, 4-col on desktop */}
                      <div className="grid grid-cols-2 gap-y-5 border-y border-[var(--border-new)] py-5 md:grid-cols-4 md:gap-y-0">
                        <div className="pr-3 md:pr-5">
                          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Odds</div>
                          <div className="mono-nums mt-1.5 text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{bet.odds ? `$${formatOdds(bet.odds)}` : "—"}</div>
                        </div>
                        <div className="border-l border-[var(--border-new)] pl-3 md:px-5">
                          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Stake</div>
                          <div className="mono-nums mt-1.5 text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{formatCurrency(bet.stake)}</div>
                        </div>
                        <div className="pr-3 md:border-l md:border-[var(--border-new)] md:px-5">
                          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Return</div>
                          <div className="mono-nums mt-1.5 text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{formatCurrency(bet.returnAmount)}</div>
                        </div>
                        <div className="border-l border-[var(--border-new)] pl-3 md:pl-5">
                          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Profit / Loss</div>
                          <div className={"mono-nums mt-1.5 text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] leading-none " + (bet.profitLoss > 0 ? "text-[var(--positive-new)]" : bet.profitLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-3-new)]")}>{bet.result === "pending" ? "Pending" : formatCurrency(bet.profitLoss)}</div>
                        </div>
                      </div>

                      {/* Legs breakdown (only for multis with leg data) */}
                      {legs.length ? (
                        <div className="mt-6">
                          <div className="mb-3 flex items-baseline justify-between">
                            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Legs · {legs.length}</div>
                            {bet.result === "win" ? <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--positive-new)]">All hit</div>
                              : bet.result === "loss" ? <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--danger-new)]">Multi failed</div>
                              : <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--warning-new)]">Pending</div>}
                          </div>
                          <div className="rounded-xl border border-[var(--border-new)] bg-[var(--bg-new)]">
                            {legs.map((leg, i) => {
                              const hit = leg.hit === true ? "won" : leg.hit === false ? "lost" : (bet.result === "win" ? "won" : bet.result === "loss" ? "pending" : "pending");
                              const label = hit === "won" ? "✓" : hit === "lost" ? "✕" : "·";
                              const labelClass = hit === "won" ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : hit === "lost" ? "bg-[var(--surface-2-new)] text-[var(--text-3-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]";
                              const lineNum = typeof leg.line === "number" ? leg.line : parseFloat(String(leg.line || "").replace(/[^0-9.]/g, ""));
                              const fetchedActuals = legActualsByBet[bet.id];
                              const fetched = fetchedActuals ? fetchedActuals[i] : undefined;
                              let actualNum = fetched && typeof fetched.actual === "number" ? fetched.actual
                                : typeof leg.actual === "number" ? leg.actual
                                : null;
                              const actualsLoading = !fetchedActuals && bet.status !== "pending";
                              const haveBar = !isNaN(lineNum) && lineNum > 0 && actualNum != null && !isNaN(actualNum);
                              const barCleared = haveBar && actualNum >= lineNum;
                              let max = 1, actualPct = 0, linePct = 0;
                              if (haveBar) {
                                max = Math.max(actualNum, lineNum) * 1.15;
                                actualPct = (actualNum / max) * 100;
                                linePct = (lineNum / max) * 100;
                              }
                              const statName = (() => {
                                const src = leg.line || leg.market || "";
                                const m = String(src).match(/([a-zA-Z][a-zA-Z\s]+)$/);
                                if (m) return m[1].trim().replace(/^./, (c) => c.toUpperCase());
                                return leg.market || null;
                              })();
                              const lineDisplay = (() => {
                                const src = leg.line || "";
                                const m = String(src).match(/^([0-9.]+\+?)/);
                                return m ? m[1] : String(src);
                              })();
                              return (
                                <div key={i} className={"px-4 py-5 " + (i > 0 ? "border-t border-[var(--border-new)]" : "")}>
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-new)]">
                                        {leg.player || leg.name || `Leg ${i + 1}`}
                                        {lineDisplay ? <span className="ml-1.5 text-[var(--text-2-new)]"> {lineDisplay}</span> : null}
                                      </div>
                                      {statName || leg.game ? (
                                        <div className="mt-0.5 text-[12px] text-[var(--text-3-new)]">
                                          {statName ? `To get ${statName}` : leg.game}
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className={"grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold " + labelClass}>{label}</div>
                                  </div>
                                  {haveBar ? (
                                    <div className="relative mt-4 h-[26px]">
                                      <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                      <div
                                        className={"absolute top-[10px] left-0 h-[6px] rounded-full transition-all " + (barCleared ? "bg-[var(--accent-new)]" : "bg-[var(--danger-new)]")}
                                        style={{ width: `${Math.max(2, actualPct)}%`, boxShadow: barCleared ? "0 0 10px rgba(212,242,58,0.45)" : "none" }}
                                      />
                                      {!barCleared ? (
                                        <div className="absolute top-0 bottom-0 w-px bg-[var(--text-3-new)] opacity-60" style={{ left: `${linePct}%` }}>
                                          <span className="mono-nums absolute -top-0.5 left-1 text-[9px] text-[var(--text-3-new)]">{lineNum}</span>
                                        </div>
                                      ) : null}
                                      <div
                                        className={"mono-nums absolute top-0 -translate-x-1/2 rounded-full px-2.5 py-1 text-[12px] font-bold leading-none transition-all " + (barCleared ? "bg-[var(--accent-new)] text-[var(--bg-new)]" : "bg-[var(--danger-new)] text-[var(--bg-new)]")}
                                        style={{ left: `${Math.min(96, Math.max(6, actualPct))}%`, boxShadow: barCleared ? "0 2px 10px rgba(212,242,58,0.35)" : "0 2px 8px rgba(248,113,113,0.30)" }}
                                      >
                                        {Number.isInteger(actualNum) ? actualNum : actualNum.toFixed(1)}
                                      </div>
                                    </div>
                                  ) : (hit === "won" || hit === "lost") ? (
                                    <div className="relative mt-4 h-[26px]">
                                      <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                      <div
                                        className={"absolute top-[10px] left-0 h-[6px] rounded-full " + (hit === "won" ? "bg-[var(--accent-new)]" : "bg-[var(--danger-new)]")}
                                        style={{ width: hit === "won" ? "95%" : "40%", boxShadow: hit === "won" ? "0 0 10px rgba(212,242,58,0.45)" : "0 0 8px rgba(248,113,113,0.30)" }}
                                      />
                                      <div
                                        className={"mono-nums absolute top-0 -translate-x-1/2 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase leading-none tracking-[0.06em] " + (hit === "won" ? "bg-[var(--accent-new)] text-[var(--bg-new)]" : "bg-[var(--danger-new)] text-[var(--bg-new)]")}
                                        style={{ left: hit === "won" ? "95%" : "40%", boxShadow: hit === "won" ? "0 2px 10px rgba(212,242,58,0.35)" : "0 2px 8px rgba(248,113,113,0.30)" }}
                                      >
                                        {hit === "won" ? "Won" : "Lost"}
                                      </div>
                                    </div>
                                  ) : actualsLoading ? (
                                    <div className="relative mt-4 h-[26px]">
                                      <div className="absolute inset-x-0 top-[10px] h-[6px] overflow-hidden rounded-full bg-[var(--surface-2-new)]">
                                        <div className="absolute inset-0 animate-pulse bg-[var(--border-strong-new)]" />
                                      </div>
                                    </div>
                                  ) : !isNaN(lineNum) && lineNum > 0 ? (
                                    <div className="relative mt-4 h-[26px]">
                                      <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                      <div className="absolute top-[3px] left-1/2 -translate-x-1/2 text-[10px] text-[var(--text-3-new)]">
                                        Line <span className="mono-nums text-[var(--text-2-new)]">{lineNum}</span> · awaiting game
                                      </div>
                                    </div>
                                  ) : null}
                                  <div className="mt-3 flex items-baseline justify-between gap-3 text-[11px]">
                                    <div className="min-w-0 text-[var(--text-3-new)]">
                                      {leg.game ? <span>{leg.game}</span> : null}
                                      {leg.game && leg.result ? " · " : ""}
                                      {leg.result ? <span>{leg.result}</span> : null}
                                    </div>
                                    <div className="flex shrink-0 items-baseline gap-3">
                                      {haveBar ? (
                                        <span className={"mono-nums font-medium " + (barCleared ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{barCleared ? "+" : ""}{(actualNum - lineNum).toFixed(1)}</span>
                                      ) : null}
                                      <span className="mono-nums text-[var(--text-2-new)]">{leg.odds ? `$${formatOdds(leg.odds)}` : "—"}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : bet.notes ? (
                        <div className="mt-5">
                          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Notes</div>
                          <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)]">{bet.notes}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            };
            return (
              <>
                {/* Filter + sort row — pills scroll horizontally on mobile,
                    wrap on tablet+. Sort label hides on mobile to save space. */}
                <div className="flex items-center justify-between gap-3 border-b border-[var(--border-new)] py-4 md:py-5">
                  <div className="-mx-1 flex flex-nowrap gap-1.5 overflow-x-auto px-1 md:flex-wrap md:overflow-visible [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    {[
                      { key: "all", label: "All", count: counts.all },
                      { key: "pending", label: "Pending", count: counts.pending },
                      { key: "won", label: "Won", count: counts.won },
                      { key: "lost", label: "Lost", count: counts.lost },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setStatusFilter(tab.key)}
                        className={"cursor-pointer whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] transition-colors " + (statusFilter === tab.key ? "border-[var(--text-new)] bg-[var(--text-new)] font-medium text-[var(--bg-new)]" : "border-[var(--border-new)] bg-transparent text-[var(--text-2-new)] hover:border-[var(--border-strong-new)]")}
                      >
                        {tab.label} <span className={statusFilter === tab.key ? "ml-1 opacity-60" : "ml-1 text-[var(--text-3-new)]"}>{tab.count}</span>
                      </button>
                    ))}
                  </div>
                  <div className="hidden items-center gap-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] md:flex">
                    Sort
                    <span className="cursor-pointer text-[12px] normal-case tracking-normal text-[var(--text-2-new)] hover:text-[var(--text-new)]">Most recent</span>
                  </div>
                </div>

                {/* Mobile cards — full feature parity with desktop table. Each
                    card is tappable to toggle expand; expanded reveals the same
                    summary cells + leg detail (achievement pills, progress
                    bars, target markers) that desktop shows. */}
                <div className="border-b border-[var(--border-new)] md:hidden">
                  {showing.map((bet) => {
                    const isExpanded = expandedBetId === bet.id;
                    return (
                      <div key={bet.id} className={"border-b border-[var(--border-new)] last:border-0 transition-colors " + (isExpanded ? "bg-[var(--surface-new)]" : "")}>
                        <button
                          type="button"
                          onClick={() => setExpandedBetId(isExpanded ? null : bet.id)}
                          className="w-full px-1 py-4 text-left active:opacity-80"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <div className={"h-2 w-2 shrink-0 rounded-full " + dotClass(bet.result)} />
                              <div className="min-w-0">
                                <div className="flex items-baseline gap-2">
                                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3-new)]">{bet.sport || "OTHER"}</span>
                                  <span className="text-[14px] font-medium text-[var(--text-new)]">{betTitle(bet)}</span>
                                  <svg width="10" height="10" viewBox="0 0 12 12" className={"shrink-0 text-[var(--text-3-new)] transition-transform " + (isExpanded ? "rotate-90" : "")}>
                                    <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </div>
                                <div className="mt-1 text-[11px] text-[var(--text-3-new)]"><span className="mono-nums">{bet.date}</span>{bet.bookmaker ? ` · ${bet.bookmaker}` : ""}</div>
                              </div>
                            </div>
                            <div className="text-right">
                              <span className={"mono-nums text-[14px] font-semibold " + (bet.profitLoss > 0 ? "text-[var(--positive-new)]" : bet.profitLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-3-new)]")}>{bet.result === "pending" ? "—" : formatCurrency(bet.profitLoss)}</span>
                              <div className={"mt-0.5 text-[9px] font-medium uppercase tracking-[0.08em] " + statusColor(bet.result)}>{statusLabel(bet.result)}</div>
                            </div>
                          </div>
                          {!isExpanded ? (
                            <div className="mt-2 flex justify-between pl-5 text-[11px] text-[var(--text-3-new)]">
                              <span>Stake <span className="mono-nums text-[var(--text-2-new)]">{formatCurrency(bet.stake)}</span></span>
                              <span>Return <span className="mono-nums text-[var(--text-2-new)]">{formatCurrency(bet.returnAmount)}</span></span>
                            </div>
                          ) : null}
                        </button>
                        {/* Expanded detail — summary cells + legs */}
                        {renderBetExpansion(bet, isExpanded)}
                        {/* Edit / Delete actions when expanded */}
                        {isExpanded ? (
                          <div className="flex gap-2 px-4 pb-4" onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => startEditingBet(bet)} className="flex-1 rounded-lg border border-[var(--border-new)] px-3 py-2.5 text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--text-2-new)] active:opacity-80 hover:text-[var(--text-new)]">Edit</button>
                            <button type="button" onClick={() => deleteBet(bet.id)} className="flex-1 rounded-lg border border-[var(--border-new)] px-3 py-2.5 text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--text-2-new)] active:opacity-80 hover:border-[var(--danger-new)] hover:text-[var(--danger-new)]">Delete</button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {!bets.length ? <div className="py-10 text-center text-sm text-[var(--text-3-new)]">No bets added yet.</div> : null}
                </div>

                {/* Desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[720px] border-collapse text-left">
                    <thead>
                      <tr>
                        <th className="border-b border-[var(--border-new)] py-4 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Bet</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Date</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Stake</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Return</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">P / L</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Status</th>
                        <th className="border-b border-[var(--border-new)] py-4 text-right text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {showing.map((bet) => {
                        const isExpanded = expandedBetId === bet.id;
                        const legs = Array.isArray(bet.legs) ? bet.legs : [];
                        return (
                        <React.Fragment key={bet.id}>
                        <tr
                          onClick={() => setExpandedBetId(isExpanded ? null : bet.id)}
                          className={"cursor-pointer transition-colors hover:bg-[var(--surface-new)] " + (editingBetId === bet.id ? "bg-[var(--surface-2-new)]" : "") + (isExpanded ? " bg-[var(--surface-new)]" : "")}
                        >
                          <td className={"py-5 pr-3 " + (isExpanded ? "" : "border-b border-[var(--border-new)]")}>
                            <div className="flex items-center gap-3">
                              <div className={"h-1.5 w-1.5 shrink-0 rounded-full " + dotClass(bet.result)} />
                              <div>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3-new)]">{bet.sport || "OTHER"}</span>
                                  <span className="text-[13px] font-medium text-[var(--text-new)]">{betTitle(bet)}</span>
                                  <svg width="10" height="10" viewBox="0 0 12 12" className={"text-[var(--text-3-new)] transition-transform " + (isExpanded ? "rotate-90" : "")}><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                </div>
                                {(bet.source === "grid_build" || bet.bookmaker || bet.notes) ? (
                                  <div className="mt-1 text-[11px] text-[var(--text-3-new)]">
                                    {bet.source === "grid_build" ? "MultiPick" : "Manual"}{bet.bookmaker ? ` · ${bet.bookmaker}` : ""}{bet.odds ? ` · @ ${formatOdds(bet.odds)}` : ""}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className={"mono-nums py-5 text-right text-[12px] text-[var(--text-3-new)] " + (isExpanded ? "" : "border-b border-[var(--border-new)]")}>{bet.date}</td>
                          <td className={"mono-nums py-5 text-right text-[13px] text-[var(--text-2-new)] " + (isExpanded ? "" : "border-b border-[var(--border-new)]")}>{formatCurrency(bet.stake)}</td>
                          <td className={"mono-nums py-5 text-right text-[13px] text-[var(--text-2-new)] " + (isExpanded ? "" : "border-b border-[var(--border-new)]")}>{bet.result === "pending" ? formatCurrency(bet.returnAmount) : formatCurrency(bet.returnAmount)}</td>
                          <td className={"mono-nums py-5 text-right text-[13px] font-medium " + (bet.profitLoss > 0 ? "text-[var(--positive-new)]" : bet.profitLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-3-new)]") + (isExpanded ? "" : " border-b border-[var(--border-new)]")}>{bet.result === "pending" ? "—" : formatCurrency(bet.profitLoss)}</td>
                          <td className={"py-5 text-right text-[10px] font-medium uppercase tracking-[0.08em] " + statusColor(bet.result) + (isExpanded ? "" : " border-b border-[var(--border-new)]")}>{statusLabel(bet.result)}</td>
                          <td className={"py-5 text-right " + (isExpanded ? "" : "border-b border-[var(--border-new)]")}>
                            <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => startEditingBet(bet)} className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--text-new)]">Edit</button>
                              <button onClick={() => deleteBet(bet.id)} className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)] hover:text-[var(--danger-new)]">Delete</button>
                            </div>
                          </td>
                        </tr>
                        {/* Smooth expand panel for the selected bet — slides open below the row with a max-height transition.
                            Shows: 4-cell summary (combined odds · stake · return · P/L), then a per-leg breakdown with
                            hit/miss indicators when the bet has leg data, otherwise notes + metadata. */}
                        <tr>
                          <td colSpan="7" className="p-0">
                            <div className={"grid overflow-hidden border-b border-[var(--border-new)] bg-[var(--surface-new)] transition-[grid-template-rows] duration-300 ease-out " + (isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                              <div className="overflow-hidden">
                                <div className="px-6 pb-7 pt-2">
                                  {/* Summary cells */}
                                  <div className="grid grid-cols-4 border-y border-[var(--border-new)] py-5">
                                    <div className="pr-5">
                                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Odds</div>
                                      <div className="mono-nums mt-1.5 text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{bet.odds ? `$${formatOdds(bet.odds)}` : "—"}</div>
                                    </div>
                                    <div className="border-l border-[var(--border-new)] px-5">
                                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Stake</div>
                                      <div className="mono-nums mt-1.5 text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{formatCurrency(bet.stake)}</div>
                                    </div>
                                    <div className="border-l border-[var(--border-new)] px-5">
                                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Return</div>
                                      <div className="mono-nums mt-1.5 text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{formatCurrency(bet.returnAmount)}</div>
                                    </div>
                                    <div className="border-l border-[var(--border-new)] pl-5">
                                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Profit / Loss</div>
                                      <div className={"mono-nums mt-1.5 text-[22px] font-semibold tracking-[-0.02em] leading-none " + (bet.profitLoss > 0 ? "text-[var(--positive-new)]" : bet.profitLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-3-new)]")}>{bet.result === "pending" ? "Pending" : formatCurrency(bet.profitLoss)}</div>
                                    </div>
                                  </div>

                                  {/* Legs breakdown (only for multis with leg data) */}
                                  {legs.length ? (
                                    <div className="mt-6">
                                      <div className="mb-3 flex items-baseline justify-between">
                                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Legs · {legs.length}</div>
                                        {bet.result === "win" ? <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--positive-new)]">All hit</div>
                                          : bet.result === "loss" ? <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--danger-new)]">Multi failed</div>
                                          : <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--warning-new)]">Pending</div>}
                                      </div>
                                      <div className="rounded-xl border border-[var(--border-new)] bg-[var(--bg-new)]">
                                        {legs.map((leg, i) => {
                                          // hit can be: true (hit), false (missed), null/undefined (pending or unknown)
                                          const hit = leg.hit === true ? "won" : leg.hit === false ? "lost" : (bet.result === "win" ? "won" : bet.result === "loss" ? "pending" : "pending");
                                          const label = hit === "won" ? "✓" : hit === "lost" ? "✕" : "·";
                                          const labelClass = hit === "won" ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : hit === "lost" ? "bg-[var(--surface-2-new)] text-[var(--text-3-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]";

                                          // Pull the line (the threshold) and the actual value (what the
                                          // player got in the bet's game). Priority order:
                                          //   1. Real game stat fetched from afl/nba_player_games (truth)
                                          //   2. leg.actual if the user/scraper saved one
                                          // We deliberately DO NOT fall back to recent-form averages here —
                                          // those would mislead the pill into showing the wrong number.
                                          const lineNum = typeof leg.line === "number" ? leg.line : parseFloat(String(leg.line || "").replace(/[^0-9.]/g, ""));
                                          const fetchedActuals = legActualsByBet[bet.id];
                                          const fetched = fetchedActuals ? fetchedActuals[i] : undefined;
                                          let actualNum = fetched && typeof fetched.actual === "number" ? fetched.actual
                                            : typeof leg.actual === "number" ? leg.actual
                                            : null;
                                          const actualsLoading = !fetchedActuals && bet.status !== "pending";
                                          const haveBar = !isNaN(lineNum) && lineNum > 0 && actualNum != null && !isNaN(actualNum);
                                          // Achievement-pill scale: the bar extends up to max(actual, line) × 1.15
                                          // so there's always breathing room at the right. The fill stops at the
                                          // actual achievement with a rounded pill on the end showing the number.
                                          // Misses also show a faint target marker so users see how short they fell.
                                          const barCleared = haveBar && actualNum >= lineNum;
                                          let max = 1, actualPct = 0, linePct = 0;
                                          if (haveBar) {
                                            max = Math.max(actualNum, lineNum) * 1.15;
                                            actualPct = (actualNum / max) * 100;
                                            linePct = (lineNum / max) * 100;
                                          }
                                          // For "To get X" sub-label, extract the stat name from the leg description.
                                          // Common patterns: "25+ disposals", "1+ goals", "20+ points". We strip the
                                          // number and "+" to get just the stat type, then capitalise.
                                          const statName = (() => {
                                            const src = leg.line || leg.market || "";
                                            const m = String(src).match(/([a-zA-Z][a-zA-Z\s]+)$/);
                                            if (m) return m[1].trim().replace(/^./, (c) => c.toUpperCase());
                                            return leg.market || null;
                                          })();
                                          // Display the line cleanly — "23+" rather than "23+ disposals" so the
                                          // sub-label can carry the stat name. Strip trailing stat words.
                                          const lineDisplay = (() => {
                                            const src = leg.line || "";
                                            const m = String(src).match(/^([0-9.]+\+?)/);
                                            return m ? m[1] : String(src);
                                          })();

                                          return (
                                            <div key={i} className={"px-4 py-5 " + (i > 0 ? "border-t border-[var(--border-new)]" : "")}>
                                              {/* Header row: name + line on left, ✓/✕ pill on right. */}
                                              <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                  <div className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-new)]">
                                                    {leg.player || leg.name || `Leg ${i + 1}`}
                                                    {lineDisplay ? <span className="ml-1.5 text-[var(--text-2-new)]"> {lineDisplay}</span> : null}
                                                  </div>
                                                  {statName || leg.game ? (
                                                    <div className="mt-0.5 text-[12px] text-[var(--text-3-new)]">
                                                      {statName ? `To get ${statName}` : leg.game}
                                                    </div>
                                                  ) : null}
                                                </div>
                                                <div className={"grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold " + labelClass}>{label}</div>
                                              </div>

                                              {/* Achievement bar — full-width, fat (10px), rounded. Lime if cleared,
                                                  muted red if missed. A rounded "pill" extends past the bar's end
                                                  cap with the achieved number. For misses, a faint vertical line
                                                  marks where the target was so you see how short you fell. */}
                                              {haveBar ? (
                                                <div className="relative mt-4 h-[26px]">
                                                  {/* Track */}
                                                  <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                                  {/* Fill */}
                                                  <div
                                                    className={"absolute top-[10px] left-0 h-[6px] rounded-full transition-all " + (barCleared ? "bg-[var(--accent-new)]" : "bg-[var(--danger-new)]")}
                                                    style={{ width: `${Math.max(2, actualPct)}%`, boxShadow: barCleared ? "0 0 10px rgba(212,242,58,0.45)" : "none" }}
                                                  />
                                                  {/* Target marker — only for misses, faint vertical line where the line sat */}
                                                  {!barCleared ? (
                                                    <div className="absolute top-0 bottom-0 w-px bg-[var(--text-3-new)] opacity-60" style={{ left: `${linePct}%` }}>
                                                      <span className="mono-nums absolute -top-0.5 left-1 text-[9px] text-[var(--text-3-new)]">{lineNum}</span>
                                                    </div>
                                                  ) : null}
                                                  {/* Achievement pill — sits at the end of the fill */}
                                                  <div
                                                    className={"mono-nums absolute top-0 -translate-x-1/2 rounded-full px-2.5 py-1 text-[12px] font-bold leading-none transition-all " + (barCleared ? "bg-[var(--accent-new)] text-[var(--bg-new)]" : "bg-[var(--danger-new)] text-[var(--bg-new)]")}
                                                    style={{ left: `${Math.min(96, Math.max(6, actualPct))}%`, boxShadow: barCleared ? "0 2px 10px rgba(212,242,58,0.35)" : "0 2px 8px rgba(248,113,113,0.30)" }}
                                                  >
                                                    {Number.isInteger(actualNum) ? actualNum : actualNum.toFixed(1)}
                                                  </div>
                                                </div>
                                              ) : (hit === "won" || hit === "lost") ? (
                                                /* WON / LOST placeholder — we know the leg outcome but the
                                                   actual game stat isn't scraped yet. Lime full bar + WON
                                                   pill for hits; muted-red shorter bar + LOST pill for
                                                   misses. Upgrades automatically to the achievement pill
                                                   above once the player_games row lands. */
                                                <div className="relative mt-4 h-[26px]">
                                                  <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                                  <div
                                                    className={"absolute top-[10px] left-0 h-[6px] rounded-full " + (hit === "won" ? "bg-[var(--accent-new)]" : "bg-[var(--danger-new)]")}
                                                    style={{ width: hit === "won" ? "95%" : "40%", boxShadow: hit === "won" ? "0 0 10px rgba(212,242,58,0.45)" : "0 0 8px rgba(248,113,113,0.30)" }}
                                                  />
                                                  <div
                                                    className={"mono-nums absolute top-0 -translate-x-1/2 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase leading-none tracking-[0.06em] " + (hit === "won" ? "bg-[var(--accent-new)] text-[var(--bg-new)]" : "bg-[var(--danger-new)] text-[var(--bg-new)]")}
                                                    style={{ left: hit === "won" ? "95%" : "40%", boxShadow: hit === "won" ? "0 2px 10px rgba(212,242,58,0.35)" : "0 2px 8px rgba(248,113,113,0.30)" }}
                                                  >
                                                    {hit === "won" ? "Won" : "Lost"}
                                                  </div>
                                                </div>
                                              ) : actualsLoading ? (
                                                /* Skeleton loader — actuals still fetching from player_games */
                                                <div className="relative mt-4 h-[26px]">
                                                  <div className="absolute inset-x-0 top-[10px] h-[6px] overflow-hidden rounded-full bg-[var(--surface-2-new)]">
                                                    <div className="absolute inset-0 animate-pulse bg-[var(--border-strong-new)]" />
                                                  </div>
                                                </div>
                                              ) : !isNaN(lineNum) && lineNum > 0 ? (
                                                /* Pending bet — game hasn't happened yet. Empty track + tiny label. */
                                                <div className="relative mt-4 h-[26px]">
                                                  <div className="absolute inset-x-0 top-[10px] h-[6px] rounded-full bg-[var(--surface-2-new)]" />
                                                  <div className="absolute top-[3px] left-1/2 -translate-x-1/2 text-[10px] text-[var(--text-3-new)]">
                                                    Line <span className="mono-nums text-[var(--text-2-new)]">{lineNum}</span> · awaiting game
                                                  </div>
                                                </div>
                                              ) : null}

                                              {/* Footer row: game + reason on the left, odds + margin on the right. */}
                                              <div className="mt-3 flex items-baseline justify-between gap-3 text-[11px]">
                                                <div className="min-w-0 text-[var(--text-3-new)]">
                                                  {leg.game ? <span>{leg.game}</span> : null}
                                                  {leg.game && leg.result ? " · " : ""}
                                                  {leg.result ? <span>{leg.result}</span> : null}
                                                </div>
                                                <div className="flex shrink-0 items-baseline gap-3">
                                                  {haveBar ? (
                                                    <span className={"mono-nums font-medium " + (barCleared ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{barCleared ? "+" : ""}{(actualNum - lineNum).toFixed(1)}</span>
                                                  ) : null}
                                                  <span className="mono-nums text-[var(--text-2-new)]">{leg.odds ? `$${formatOdds(leg.odds)}` : "—"}</span>
                                                </div>
                                              </div>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ) : (
                                    /* Single bet or no leg data — just show notes if present */
                                    bet.notes ? (
                                      <div className="mt-5">
                                        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-3-new)]">Notes</div>
                                        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-2-new)]">{bet.notes}</p>
                                      </div>
                                    ) : null
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                        </React.Fragment>
                        );
                      })}
                      {!filtered.length ? (
                        <tr><td colSpan="7" className="py-10 text-center text-sm text-[var(--text-3-new)]">No bets {statusFilter !== "all" ? `with ${statusFilter} status` : "added yet"}.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                {filtered.length > 6 ? (
                  <div className="mt-5 flex justify-center">
                    <button type="button" onClick={() => setShowAllBets((current) => !current)} className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-2-new)] hover:text-[var(--text-new)]">
                      {showAllBets ? "Show less" : `View all ${filtered.length} →`}
                    </button>
                  </div>
                ) : null}
              </>
            );
          })() : null}

          {/* Calibration scoreboard was added here but referenced `calibration`
              state that lives inside EdgePage — caused a ReferenceError that
              blanked the whole Tracker page. Hoist the state up to use it
              here. For now, the calibration display still works on the
              MultiPick page (EdgePage) where the state lives. */}

          </div>

          {/* Dashboard-only: PendingBets sits below the main dashboard sections
              so users see what's still open at the bottom of the page. The
              Bankroll/Breakdowns/Grid Build score cards live on the Tracker
              page now (above the bet history table), where they belong. */}
          {activePage === "app" && bets.length > 0 && pendingBets.length > 0 ? (
            <div className="mt-4 space-y-4 md:mt-6 md:space-y-6">
              <PendingBetsCard bets={pendingBets} onSettle={settlePendingBet} onDelete={deleteBet} onEdit={startEditingBet} />
            </div>
          ) : null}

          <div className="mt-4 md:hidden">
            <Card>
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-sm font-semibold text-[#11203B]">Account and feedback</p>
                  <p className="mt-1 text-xs text-slate-500">Logged in as {session.user.email}</p>
                </div>
                <a
                  href="mailto:aidenchannell0@gmail.com?subject=Bet%20Grid%20Feedback&body=What%20did%20you%20think%20of%20Bet%20Grid%3F%0A%0AWhat%20was%20confusing%3F%0A%0AWhat%20feature%20should%20come%20next%3F%0A%0AWould%20you%20use%20Grid%20Build%20with%20live%20sports%20data%3F"
                  className="block rounded-xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-sm font-medium text-[#11203B]"
                >
                  Give feedback
                </a>
                <button type="button" onClick={() => setActivePage("settings")} className="w-full rounded-xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-left text-sm font-medium text-[#11203B]">Settings</button>
                <button type="button" onClick={handleLogout} className="w-full rounded-xl border border-[#D9A39B] bg-[#F3DDD7] px-4 py-3 text-left text-sm font-medium text-[#A94442]">Log out</button>
              </div>
            </Card>
          </div>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
      <MobileBottomNav activePage={activePage} setActivePage={setActivePage} formRef={formRef} />
      {/* Bet-saved confirmation toast — tappable, jumps to the bet in Tracker. */}
      {savedToast ? createPortal(
        <div className="fixed inset-x-0 bottom-[88px] z-[60] flex justify-center px-4 md:bottom-6">
          <div className="toast-in flex items-center gap-2 rounded-full border border-[var(--border-strong-new)] bg-[var(--surface-new)] py-2 pl-2.5 pr-2 shadow-xl shadow-black/40">
            <button type="button" onClick={viewSavedBet} className="flex items-center gap-3 text-left">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-new)] text-[var(--bg-new)]">
                <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M2.5 6.2 L5 8.5 L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
              <span className="pr-1">
                <span className="block text-[13px] font-semibold leading-tight text-[var(--text-new)]">{savedToast.updated ? "Bet updated" : "Bet saved"}</span>
                <span className="block text-[11px] leading-tight text-[var(--text-3-new)]">Tap to see it in your tracker →</span>
              </span>
            </button>
            <button type="button" onClick={() => setSavedToast(null)} aria-label="Dismiss" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-3-new)] transition-colors hover:bg-[var(--surface-2-new)] hover:text-[var(--text-new)]">
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>,
        document.body
      ) : null}
      {statDetail ? (
        <StatDetailModal
          statKey={statDetail}
          onClose={() => setStatDetail(null)}
          stats={stats}
          subStats={subStats}
          filteredBets={filteredBets}
          pendingBets={pendingBets}
          cumulativeData={cumulativeData}
          fmtMoney={fmtMoney}
        />
      ) : null}
      {termsGateOpen ? <TermsGateModal onAccept={doCheckout} onClose={() => setTermsGateOpen(false)} accepting={upgrading} /> : null}
    </div>
  );
}

runBasicTests();
