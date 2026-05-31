import React, { useEffect, useMemo, useRef, useState } from "react";
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

// Odds always show two decimals ($1.40, not $1.4). Leaves non-numeric values as-is.
function formatOdds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : String(value ?? "");
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
const TEAM_CRESTS = {
  "adelaide": (
    <>
      <rect width="32" height="32" fill="#002b5c" />
      <rect y="11" width="32" height="10" fill="#ffd200" />
      <rect y="21" width="32" height="11" fill="#e21937" />
    </>
  ),
  "brisbane lions": (
    <>
      <rect width="32" height="32" fill="#0c2340" />
      <rect y="12" width="32" height="7" fill="#fdbb30" />
      <rect y="19" width="32" height="13" fill="#7a002e" />
    </>
  ),
  "brisbane": (
    <>
      <rect width="32" height="32" fill="#0c2340" />
      <rect y="12" width="32" height="7" fill="#fdbb30" />
      <rect y="19" width="32" height="13" fill="#7a002e" />
    </>
  ),
  "carlton": <rect width="32" height="32" fill="#0e2547" />,
  "collingwood": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <rect x="11" width="3" height="32" fill="#ffffff" />
      <rect x="18" width="3" height="32" fill="#ffffff" />
    </>
  ),
  "essendon": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polygon points="0,8 8,0 32,24 24,32" fill="#cc2031" />
    </>
  ),
  "fremantle": (
    <>
      <rect width="32" height="32" fill="#2a0d54" />
      <polyline points="5,9 16,17 27,9" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points="5,15 16,23 27,15" fill="none" stroke="#ffffff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  "geelong": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect y="0" width="32" height="5.3" fill="#022b5c" />
      <rect y="10.6" width="32" height="5.3" fill="#022b5c" />
      <rect y="21.3" width="32" height="5.3" fill="#022b5c" />
    </>
  ),
  "gold coast": (
    <>
      <rect width="32" height="32" fill="#d6001c" />
      <rect y="13" width="32" height="3.5" fill="#f8d000" />
      <rect y="16.5" width="32" height="3.5" fill="#13357f" />
    </>
  ),
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
  "hawthorn": (
    <>
      <rect width="32" height="32" fill="#fbbf15" />
      <rect x="11" width="3.2" height="32" fill="#4d2004" />
      <rect x="18" width="3.2" height="32" fill="#4d2004" />
    </>
  ),
  "melbourne": (
    <>
      <rect width="32" height="32" fill="#0c1c3a" />
      <polygon points="0,0 32,0 16,22" fill="#d6001c" />
    </>
  ),
  "north melbourne": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect x="0" width="6" height="32" fill="#013b9f" />
      <rect x="12" width="6" height="32" fill="#013b9f" />
      <rect x="24" width="6" height="32" fill="#013b9f" />
    </>
  ),
  "kangaroos": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <rect x="0" width="6" height="32" fill="#013b9f" />
      <rect x="12" width="6" height="32" fill="#013b9f" />
      <rect x="24" width="6" height="32" fill="#013b9f" />
    </>
  ),
  "port adelaide": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polyline points="6,8 16,16 26,8" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points="6,13 16,21 26,13" fill="none" stroke="#01b6c7" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    </>
  ),
  "richmond": (
    <>
      <rect width="32" height="32" fill="#000000" />
      <polygon points="0,8 8,0 32,24 24,32" fill="#ffd200" />
    </>
  ),
  "st kilda": (
    <>
      <rect width="32" height="32" fill="#ed0f05" />
      <rect x="11" width="10" height="32" fill="#ffffff" />
      <rect x="21" width="11" height="32" fill="#000000" />
    </>
  ),
  "sydney": (
    <>
      <rect width="32" height="32" fill="#ffffff" />
      <polygon points="0,0 32,0 32,11 16,17 0,11" fill="#ed171f" />
    </>
  ),
  "west coast": (
    <>
      <rect width="32" height="32" fill="#06214f" />
      <rect width="16" height="32" fill="#f2a900" />
    </>
  ),
  "western bulldogs": (
    <>
      <rect width="32" height="32" fill="#0a4595" />
      <rect y="11.5" width="32" height="9" fill="#ffffff" />
      <rect y="13.5" width="32" height="5" fill="#e1251b" />
    </>
  ),
  "bulldogs": (
    <>
      <rect width="32" height="32" fill="#0a4595" />
      <rect y="11.5" width="32" height="9" fill="#ffffff" />
      <rect y="13.5" width="32" height="5" fill="#e1251b" />
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
  if (!key) return null;
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

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, loading, message, onSubmit, onResetPassword }) {
  return (
    <div className="min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Online version</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Pickd</h1>
            <p className="mt-2 text-sm text-slate-600">Create an account or log in to save your bets online and access them from any device.</p>
            {authMode === "reset" ? <p className="mt-2 text-sm text-slate-600">Enter your email and we will send you a password reset link.</p> : null}

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
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
      <button
        type="button"
        onClick={() => setActivePage && setActivePage("app")}
        className="flex items-center gap-3"
      >
        <div className="grid h-7 w-7 place-items-center rounded bg-[var(--accent-new)] text-[12px] font-bold text-[var(--bg-new)]">P</div>
        <div className="text-[13px] font-semibold tracking-[0.02em] text-[var(--text-new)]">PICKD</div>
      </button>
      <div className="-mx-2 flex items-center gap-4 overflow-x-auto px-2 md:gap-6 md:overflow-visible">
        <button onClick={() => setActivePage("app")} className={tabClass("app") + " whitespace-nowrap"}>Dashboard</button>
        <button onClick={() => setActivePage("tracker")} className={tabClass("tracker") + " whitespace-nowrap"}>Tracker</button>
        <button onClick={() => setActivePage("edge")} className={tabClass("edge") + " whitespace-nowrap"}>MultiPick</button>
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

function SettingsPage({ setActivePage, bets, exportCsv, exportBackup, clearAllBets, fileInputRef, importBackup, darkMode, setDarkMode }) {
  return (
    <div className="min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopNav activePage="settings" setActivePage={setActivePage} />
        </div>
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="border-b border-[var(--border-new)] pb-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">PICKD · Account</p>
            <h1 className="mt-3.5 text-[40px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[44px]">Settings.</h1>
            <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[var(--text-2-new)]">Manage exports, backups and account-level bet data actions.</p>
          </div>
          <Card>
            <div className="p-6 md:p-8">

              <div className="mt-6 space-y-5">
                <div className="rounded-2xl border border-slate-200 p-4">
                  <h2 className="text-lg font-semibold">Appearance</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Choose your preferred display mode.</p>
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setDarkMode(false)}
                      className={"rounded-xl px-4 py-2 text-sm font-medium transition border " + (!darkMode ? "bg-[#11203B] text-white border-transparent" : "border-slate-300 bg-[#FAF7EF] text-slate-700 hover:bg-[#E8E2D4]")}
                    >
                      Light
                    </button>
                    <button
                      type="button"
                      onClick={() => setDarkMode(true)}
                      className={"rounded-xl px-4 py-2 text-sm font-medium transition border " + (darkMode ? "bg-[#11203B] text-white border-transparent" : "border-slate-300 bg-[#FAF7EF] text-slate-700 hover:bg-[#E8E2D4]")}
                    >
                      Dark
                    </button>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4">
                  <h2 className="text-lg font-semibold">Export data</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Download your bet history for spreadsheets or personal backups.</p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <Button onClick={exportCsv} variant="outline" disabled={!bets.length}>Export CSV</Button>
                    <Button onClick={exportBackup} variant="outline" disabled={!bets.length}>Export Backup</Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 p-4">
                  <h2 className="text-lg font-semibold">Import backup</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Import a Pickd JSON backup. Imported bets will be added to your online account.</p>
                  <div className="mt-4">
                    <Button onClick={() => fileInputRef.current && fileInputRef.current.click()} variant="outline">Import Backup</Button>
                    <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importBackup} className="hidden" />
                  </div>
                </div>

                <div className="rounded-2xl border border-[#D9A39B] bg-[#F3DDD7] p-4">
                  <h2 className="text-lg font-semibold text-red-900">Danger zone</h2>
                  <p className="mt-1 text-sm leading-6 text-red-800">Delete all saved bets from this account. This does not delete your account, but the bet entries will be removed.</p>
                  <div className="mt-4">
                    <Button onClick={clearAllBets} variant="outline" disabled={!bets.length} className="border-red-300 text-red-900 hover:bg-red-100">Delete All Bets</Button>
                  </div>
                </div>
              </div>
            </div>
          </Card>
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

function EdgeDetailToggle({ leg }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-800 hover:bg-[#E8E2D4]">
        <span>{open ? "Hide detailed form" : "Show detailed form"}</span>
        <span className="text-slate-500">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
          <div className="grid grid-cols-2 gap-2">
            {leg.details.map((item) => (
              <div key={item.label} className="rounded-lg bg-[#FAF7EF] p-3">
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className="mt-1 font-semibold text-[#11203B]">{item.value}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="font-medium text-slate-900">Recent trend</p>
            {Array.isArray(leg.last5Values) && leg.last5Values.length ? (
              <>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {[...leg.last5Values].reverse().map((value, index, arr) => {
                    const isLatest = index === arr.length - 1;
                    return (
                      <span
                        key={index}
                        title={isLatest ? "Latest game" : undefined}
                        className={
                          "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-sm font-semibold " +
                          (isLatest ? "bg-[#11203B] text-white ring-2 ring-[#C49A4A]" : "bg-[#FAF7EF] text-[#11203B]")
                        }
                      >
                        {value}
                      </span>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-slate-500">Oldest → latest (boxed){typeof leg.line === "number" ? ` · line: Over ${leg.line}` : ""}</p>
              </>
            ) : (
              <p className="mt-1 leading-6">{leg.trend}</p>
            )}
          </div>
          <div>
            <p className="font-medium text-slate-900">Why MultiPick included it</p>
            <p className="mt-1 leading-6">{leg.extraReason}</p>
          </div>
        </div>
      ) : null}
    </div>
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

function EdgePage({ setActivePage, onSaveMulti, accessToken, gridBuildStats }) {
  const [mode, setMode] = useState("multi");
  const [sport, setSport] = useState("AFL");
  const [legs, setLegs] = useState("3");
  const [targetOdds, setTargetOdds] = useState("$2.00");
  const [customTargetOdds, setCustomTargetOdds] = useState("2.20");
  const [customLegs, setCustomLegs] = useState("6");
  const [riskProfile, setRiskProfile] = useState("Balanced");
  const [bookmaker, setBookmaker] = useState("");
  const [request, setRequest] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [showRiskExplanation, setShowRiskExplanation] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [lastEdgeContext, setLastEdgeContext] = useState(null);
  const [multiOutput, setMultiOutput] = useState(null);
  const [analysisOutput, setAnalysisOutput] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [betStake, setBetStake] = useState("");
  const [savingBet, setSavingBet] = useState(false);
  const [saveBetMsg, setSaveBetMsg] = useState("");
  const [entitlement, setEntitlement] = useState({ subscribed: false, usage: 0, limit: 3 });
  const [upgrading, setUpgrading] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [calibration, setCalibration] = useState(null);
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
        if (!cancelled) setEntitlement({ subscribed: !!data.subscribed, usage: data.usage || 0, limit: data.limit || 3 });
      } catch {
        /* ignore — counter just won't show until a build */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const startUpgrade = async () => {
    if (upgrading) return;
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
  const chatSectionRef = React.useRef(null);
  const outputPanelRef = React.useRef(null);

  // Load the real upcoming games for the chosen sport so users can pick one
  React.useEffect(() => {
    let cancelled = false;
    setSelectedGameId("");
    setGames([]);
    (async () => {
      try {
        const response = await fetch(`/api/odds?sport=${encodeURIComponent(sport)}&markets=h2h`);
        const data = await response.json();
        if (cancelled) return;
        const upcoming = (data.events || [])
          .slice(0, 12)
          .map((event) => ({ id: event.id, label: `${event.homeTeam} vs ${event.awayTeam}` }));
        setGames(upcoming);
      } catch {
        if (!cancelled) setGames([]);
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

  const previewMulti = () => {
    if (edgeLoading) return;
    setAnalysisOutput(null);
    const requestPart = request.trim() ? `. Focus: ${request.trim()}` : "";
    const riskPart = riskProfile !== "Balanced" ? ` with a ${riskProfile} risk profile` : "";
    const selectedGame = games.find((game) => game.id === selectedGameId);
    const gamePart = selectedGame ? ` for the ${selectedGame.label} game` : "";
    const prompt = `Build a ${displayedLegs}-leg ${sport} example multi${gamePart} targeting ${displayedTargetOdds}${riskPart}${requestPart}. Use real player form and current odds to pick the best legs mathematically. Show each leg's hit rate and recent average.`;
    sendChatMessage(prompt);
    setTimeout(() => {
      outputPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  };

  const sendChatMessage = async (messageOverride = null) => {
    const trimmed = (messageOverride || chatInput).trim();
    if (!trimmed || edgeLoading) return;

    setChatMessages((current) => [...current, { role: "user", text: trimmed }]);
    if (!messageOverride) setChatInput("");
    setEdgeLoading(true);

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
        }));
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
    }
  };

  return (
    <div className="min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <TopNav activePage="edge" setActivePage={setActivePage} />
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
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-[#FAF7EF] px-4 py-3 text-sm">
                {entitlement.subscribed ? (
                  <>
                    <span className="font-semibold text-[#2E7D5B]">MultiPick Pro — unlimited builds ✓</span>
                    <button
                      type="button"
                      onClick={startManageBilling}
                      disabled={openingPortal}
                      className="ml-auto text-xs font-medium text-slate-500 underline hover:text-slate-700 disabled:opacity-50"
                    >
                      {openingPortal ? "Opening…" : "Manage subscription"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-[#11203B]">
                      {gatedNow ? "You're out of free builds this week" : `${buildsLeft} of ${entitlement.limit} free builds left this week`}
                    </span>
                    <Button type="button" onClick={startUpgrade} disabled={upgrading} className="ml-auto">
                      {upgrading ? "Starting…" : "Upgrade"}
                    </Button>
                  </>
                )}
              </div>
              <div className="mt-3 inline-flex max-w-xl items-center rounded-2xl border border-[#C49A4A]/50 bg-[#C49A4A]/15 px-4 py-3 text-sm leading-6 text-[#11203B] shadow-sm">
                <span className="mr-2">✨</span><span><span className="font-semibold">Live AFL data connected:</span> real player stats, hit rates and market lines power the multi builder.</span>
              </div>
              <div className="mt-3 max-w-3xl rounded-2xl border border-slate-300 bg-[#FAF7EF] p-4 text-sm leading-6 text-slate-700">
                <p className="font-semibold text-[#11203B]">What is MultiPick?</p>
                <p className="mt-1">MultiPick is an AI-powered multi builder. It helps create structured example multis, explain risk levels, compare market types and show what data should be checked before making decisions. MultiPick is designed to be structured and data-focused, not a betting tips service.</p>
              </div>
            </div>
            <div className="space-y-4 lg:pt-10">
              <div className="rounded-2xl border border-[#C49A4A]/40 bg-[#C49A4A]/15 p-4 text-sm leading-6 text-[#11203B] shadow-sm">
                <span className="font-semibold">Important:</span> MultiPick is for informational analysis only. It is not betting advice, financial advice, or a guarantee of results. Always make your own decision and gamble responsibly.
              </div>
              <div className="flex flex-col items-start gap-3 lg:items-end">
                <div className="rounded-2xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-sm text-slate-600 shadow-sm">
                  <span className="font-semibold text-[#11203B]">Live AFL data</span><br />Powered by current odds and AFL Tables stats
                </div>
              </div>
            </div>
          </header>

          {calibration && calibration.resolved >= 10 ? (
            <Card className="mb-6">
              <div className="p-5 md:p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-500">Model track record</p>
                    <h2 className="mt-1 text-xl font-semibold">How our ratings have held up</h2>
                  </div>
                  {calibration.overall ? (
                    <p className="text-sm text-slate-600">Across <span className="font-semibold text-[#11203B]">{calibration.overall.n}</span> resolved legs we predicted <span className="font-semibold text-[#11203B]">{calibration.overall.predicted}%</span> and they hit <span className="font-semibold text-[#2E7D5B]">{calibration.overall.actual}%</span>.</p>
                  ) : null}
                </div>
                <div className="mt-4 space-y-2">
                  {calibration.buckets.map((bucket) => (
                    <div key={bucket.label} className="flex items-center gap-3 text-sm">
                      <span className="w-24 shrink-0 font-medium text-[#11203B]">Rated {bucket.label}</span>
                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-[#2E7D5B]" style={{ width: `${Math.min(100, bucket.actual)}%` }} />
                      </div>
                      <span className="w-28 shrink-0 text-right text-slate-600">hit {bucket.actual}% <span className="text-slate-400">({bucket.n})</span></span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">We log every leg MultiPick rates and check it against the actual result. Well-calibrated means predicted ≈ actual.</p>
              </div>
            </Card>
          ) : null}

          <section className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
            <div className="space-y-5">
            <Card className="h-fit">
              <div className="p-5">
                <div className="grid gap-2 rounded-2xl bg-[#E8E2D4] p-1 sm:grid-cols-2">
                  <button onClick={() => setMode("multi")} className={"rounded-xl px-4 py-3 text-sm font-semibold transition " + (mode === "multi" ? "bg-[#FAF7EF] text-[#11203B] shadow-sm" : "text-slate-600 hover:text-[#11203B]")}>Example Multi</button>
                  <button onClick={() => setMode("analysis")} className={"rounded-xl px-4 py-3 text-sm font-semibold transition " + (mode === "analysis" ? "bg-[#FAF7EF] text-[#11203B] shadow-sm" : "text-slate-600 hover:text-[#11203B]")}>Game Analysis</button>
                </div>

                {mode === "multi" ? (
                  <div className="mt-6 space-y-5">
                    <EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NRL", "Soccer", "Basketball", "Cricket"]} />
                    <EdgeSelectField label="Games" value={selectedGameId} onChange={setSelectedGameId} options={[{ label: games.length ? "All upcoming games" : "Loading games…", value: "" }, ...games.map((game) => ({ label: game.label, value: game.id }))]} />
                    <EdgeSelectField label="Number of legs" value={legs} onChange={setLegs} options={["Any", "2", "3", "4", "5", "Custom"]} />
                    {legs === "Custom" ? <label className="space-y-1 text-sm font-medium">Custom number of legs<Input type="number" min="1" step="1" value={customLegs} onChange={(event) => setCustomLegs(event.target.value)} placeholder="e.g. 6" /></label> : null}
                    <EdgeSelectField label="Target odds" value={targetOdds} onChange={setTargetOdds} options={["$1.50", "$2.00", "$3.00", "$5.00", "Custom"]} />
                    {targetOdds === "Custom" ? <label className="space-y-1 text-sm font-medium">Custom target odds<Input type="number" min="1" step="0.01" value={customTargetOdds} onChange={(event) => setCustomTargetOdds(event.target.value)} placeholder="e.g. 2.20" /></label> : null}
                    <EdgeSelectField label="Risk profile" value={riskProfile} onChange={setRiskProfile} options={["Safer", "Balanced", "Aggressive"]} />
                    <EdgeSelectField
                      label="Bookmaker"
                      value={bookmaker}
                      onChange={setBookmaker}
                      options={[
                        { label: "Best available", value: "" },
                        { label: "Sportsbet", value: "sportsbet" },
                        { label: "TAB", value: "tab" },
                        { label: "Ladbrokes", value: "ladbrokes_au" },
                        { label: "Neds", value: "neds" },
                        { label: "PointsBet", value: "pointsbetau" },
                        { label: "Unibet", value: "unibet" },
                      ]}
                    />
                    <label className="space-y-1 text-sm font-medium">Optional request<Input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Disposals only, no same-game legs" /></label>
                    <div className="pt-2"><Button onClick={previewMulti} disabled={edgeLoading} className="w-full rounded-2xl py-3 text-base">{edgeLoading ? "Analysing..." : "Preview example multi"}</Button></div>
                  </div>
                ) : (
                  <div className="mt-6 space-y-5">
                    <EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NRL", "Soccer", "Basketball", "Cricket"]} />
                    <EdgeSelectField label="Game" value={selectedGameId} onChange={setSelectedGameId} options={[{ label: games.length ? "Select upcoming game" : "Loading games…", value: "" }, ...games.map((game) => ({ label: game.label, value: game.id }))]} />
                    <label className="space-y-1 text-sm font-medium">Focus area<Input value="Form, market read, key players & value" readOnly /></label>
                    <div className="pt-2"><Button onClick={previewAnalysis} disabled={edgeLoading || !selectedGameId} className="w-full rounded-2xl py-3 text-base">{edgeLoading ? "Analysing..." : "Preview game analysis"}</Button></div>
                  </div>
                )}
              </div>
            </Card>

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
                    <div className={"mt-1 mono-nums text-[22px] font-semibold tracking-[-0.02em] leading-none " + (gridBuildStats.profit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{formatCurrency(gridBuildStats.profit)}</div>
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

            <div className="space-y-6" ref={outputPanelRef}>
              {analysisOutput || analyzing ? (
                <GameAnalysisOutput analysis={analysisOutput} loading={analyzing} />
              ) : (
              /* NEW 2026 minimalist build-output card — replaces the old Card.
                 Tokens are in index.css under "2026 minimalist refresh".
                 Old version preserved in src/App.legacy.jsx. */
              <div className="rounded-2xl border border-[var(--border-new)] bg-[var(--bg-new)] overflow-hidden">
                <div className="p-5 md:p-8">
                  {/* Eyebrow + title */}
                  <p className="text-[11px] uppercase tracking-[0.08em] font-medium text-[var(--text-3-new)]">
                    {multiOutput ? `Output · ${multiOutput.legCount}-leg ${multiOutput.sport} multi` : `Example · ${displayedLegs}-leg ${sport} multi`}
                  </p>
                  <h2 className="mt-2 text-[22px] md:text-[24px] font-medium tracking-[-0.02em] text-[var(--text-new)]">
                    {multiOutput ? "Form-backed, correlation-adjusted" : "Preview to build a live multi"}
                  </h2>
                  <p className="mt-1.5 text-sm text-[var(--text-2-new)]">
                    {multiOutput
                      ? <>Real form × current odds. Refine in chat below.</>
                      : <>The example is illustrative. Click <span className="text-[var(--text-new)] font-medium">Preview example multi</span> to build from real {sport} stats and current market lines.</>}
                  </p>

                  {/* Editorial stat strip — Layout B. Hairline borders only,
                      massive 44px mono numerals on Combined, 26px on others. */}
                  <div className="mt-7 grid grid-cols-2 md:grid-cols-4 gap-y-7 gap-x-0 border-y border-[var(--border-new)] py-7 md:py-9">
                    <div className="md:pr-7 md:border-r md:border-[var(--border-new)]">
                      <div className="text-[10px] uppercase tracking-[0.10em] text-[var(--text-3-new)] font-medium">Combined</div>
                      <div className="mt-3.5 mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">${multiOutput ? formatOdds(multiOutput.combinedOdds) : displayedTargetOdds.replace("$", "")}</div>
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{multiOutput ? `Target ${displayedTargetOdds}` : "Target"}</div>
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
                      <div className="mt-3 text-xs text-[var(--text-3-new)]">{multiOutput && typeof multiOutput.valueLegs === "number" ? `${multiOutput.valueLegs} of ${multiOutput.legCount} +edge` : "Form vs odds"}</div>
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
                  {multiOutput?.bookmakerNote ? (
                    <div className="mt-3 border-l-2 border-[var(--warning-new)] rounded-r-lg px-5 py-3 text-sm leading-relaxed text-[var(--text-2-new)]" style={{ background: "linear-gradient(90deg, var(--warning-soft-new) 0%, transparent 100%)" }}>
                      {multiOutput.bookmakerNote}
                    </div>
                  ) : null}

                  {edgeLoading ? (
                    <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--border-new)] bg-[var(--surface-new)] px-4 py-3 text-sm text-[var(--text-2-new)]">
                      <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--border-strong-new)] border-t-[var(--text-new)]" />
                      <span>Crunching live odds, recent form and market lines…</span>
                    </div>
                  ) : null}

                  {/* Legs section header */}
                  <div className="mt-7 mb-3 flex items-baseline justify-between">
                    <div className="text-[15px] font-medium tracking-[-0.01em] text-[var(--text-new)]">Legs</div>
                    <div className="text-xs text-[var(--text-3-new)]">Tap a row for full form breakdown</div>
                  </div>

                  {/* Legs — vertical rows with hair-thin dividers */}
                  <div className="rounded-2xl border border-[var(--border-new)] overflow-hidden divide-y divide-[var(--border-new)]">
                    {(multiOutput?.legs || exampleLegs).map((leg, index) => {
                      const matchupPct = leg.matchupFactor && leg.matchupFactor !== 1 ? Math.round((leg.matchupFactor - 1) * 100) : null;
                      const ageDays = leg.formAsOf ? Math.floor((Date.now() - new Date(leg.formAsOf + "T00:00:00").getTime()) / 86400000) : null;
                      const stale = ageDays !== null && ageDays >= 10;
                      return (
                        <div key={`${leg.name}-${index}`} className="bg-[var(--surface-new)] hover:bg-[var(--surface-2-new)] transition-colors p-5 md:p-6 grid grid-cols-[36px_1fr] md:grid-cols-[36px_1fr_140px_140px] gap-x-5 gap-y-3 items-center">
                          <div className="mono-nums text-xs text-[var(--text-3-new)] tracking-[0.05em]">{String(index + 1).padStart(2, "0")}</div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-3">
                              <TeamCrest team={leg.team} className="h-8 w-8 shrink-0" />
                              <div className="text-[15px] md:text-[16px] font-medium tracking-[-0.01em] text-[var(--text-new)] truncate">{leg.name}</div>
                            </div>
                            {leg.game ? <div className="mt-1.5 text-xs text-[var(--text-3-new)]">{leg.game}</div> : null}
                            <div className="mt-1.5 text-sm text-[var(--text-2-new)] leading-relaxed">{leg.reason}</div>
                            {matchupPct !== null && leg.opponent ? (
                              <div className={"mt-1 text-xs " + (matchupPct >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>
                                Matchup nudge {matchupPct >= 0 ? "+" : ""}{matchupPct}% vs {leg.opponent}
                              </div>
                            ) : null}
                            {ageDays !== null ? (
                              <div className={"mt-1 text-[11px] " + (stale ? "text-[var(--warning-new)] font-medium" : "text-[var(--text-3-new)]")}>
                                Form as of {formatFormDate(leg.formAsOf)}{stale ? ` · ${ageDays}d ago` : " · completed games only"}
                              </div>
                            ) : null}
                          </div>
                          {/* Confidence column (desktop only) */}
                          <div className="hidden md:block">
                            <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-3-new)] font-medium">Confidence</div>
                            <div className="mt-1 mono-nums text-[22px] md:text-[24px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">{leg.confidence}</div>
                          </div>
                          {/* Odds / value column */}
                          <div className="text-right col-span-2 md:col-span-1 flex md:block items-center justify-between gap-3 pt-1 md:pt-0 border-t md:border-0 border-[var(--border-new)] mt-1 md:mt-0">
                            <div className="md:hidden text-left">
                              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-3-new)] font-medium">Confidence</div>
                              <div className="mt-0.5 mono-nums text-lg font-semibold text-[var(--text-new)]">{leg.confidence}</div>
                            </div>
                            <div>
                              <div className="mono-nums text-[20px] md:text-[22px] font-semibold tracking-[-0.02em] leading-none text-[var(--text-new)]">${leg.odds ? formatOdds(leg.odds) : "—"}</div>
                              <div className="mt-1 text-[11px] text-[var(--text-3-new)]">{leg.bookmaker || ""}</div>
                              {typeof leg.edgePct === "number" ? (
                                <div className={"inline-block mt-1.5 mono-nums text-[11px] font-medium px-2 py-0.5 rounded-md " + (leg.edgePct > 0 ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]")}>
                                  {leg.edgePct > 0 ? `+${leg.edgePct}% value` : `${leg.edgePct}% edge`}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          {/* Detail toggle spans full width */}
                          <div className="col-span-2 md:col-span-4">
                            <EdgeDetailToggle leg={leg} />
                          </div>
                        </div>
                      );
                    })}
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

  return (
    <div className="min-h-screen bg-[#E8E2D4] text-[#11203B]">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-10">
          <header className="grid gap-10 border-b border-[var(--border-new)] pb-9 md:grid-cols-[1.4fr_1fr] md:items-end">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">PICKD · AFL + NBA tracker</p>
              <h1 className="mt-3.5 text-[40px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[60px]">
                Track every bet.<br />Read every result.
              </h1>
              <p className="mt-3 max-w-[480px] text-sm leading-relaxed text-[var(--text-2-new)]">
                A bet tracker with serious math under the hood. Form-backed AI multi builder, calibration scoreboard, honest +EV signals.
              </p>
            </div>
            <div className="flex gap-2 md:justify-end md:items-end">
              <Button variant="outline" onClick={() => openAuth("login")}>Log in</Button>
              <Button onClick={() => openAuth("signup")}>Sign up</Button>
            </div>
          </header>

          <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div className="space-y-6">
              <div>
                <span className="inline-flex rounded-full bg-[#11203B] px-3 py-1 text-xs font-semibold text-white">AI multi builder + bet tracker</span>
                <h2 className="mt-3 text-4xl font-bold tracking-tight md:text-6xl">Build smarter AFL multis, backed by real data.</h2>
                <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">MultiPick (Pickd's AI) turns real AFL form, live market lines and a transparent edge model into structured example multis — then Pickd tracks how every bet actually performs. Data-driven analysis, not a tips service.</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button onClick={() => openAuth("signup")} className="w-full sm:w-auto">Try MultiPick free</Button>
                <Button variant="outline" onClick={() => openAuth("login")} className="w-full sm:w-auto">I already have an account</Button>
              </div>
              <p className="text-sm text-slate-500">Built for tracking and informational use. Pickd does not accept bets or guarantee outcomes.</p>
            </div>

            <Card>
              <div className="p-5 md:p-6">
                <p className="text-sm font-medium text-slate-500">Dashboard preview</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-sm text-slate-500">Total Profit/Loss</p><p className="mt-1 text-2xl font-semibold text-[#2E7D5B]">+$246.50</p></div>
                  <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-sm text-slate-500">Win Rate</p><p className="mt-1 text-2xl font-semibold">58.3%</p></div>
                  <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-sm text-slate-500">ROI</p><p className="mt-1 text-2xl font-semibold">12.8%</p></div>
                  <div className="rounded-2xl bg-[#E8E2D4] p-4"><p className="text-sm text-slate-500">Longest Win Streak</p><p className="mt-1 text-2xl font-semibold">5 bets</p></div>
                </div>
                <div className="mt-5 rounded-2xl border border-slate-200 p-4">
                  <div className="mb-3 flex items-center justify-between text-sm"><span className="font-medium">Weekly profit/loss</span><span className="text-slate-500">Example</span></div>
                  <div className="flex h-32 items-end gap-3"><div className="h-16 flex-1 rounded-t-xl bg-[#2E7D5B]" /><div className="h-24 flex-1 rounded-t-xl bg-[#2E7D5B]" /><div className="h-10 flex-1 rounded-t-xl bg-[#A94442]" /><div className="h-28 flex-1 rounded-t-xl bg-[#2E7D5B]" /><div className="h-20 flex-1 rounded-t-xl bg-[#A94442]" /></div>
                </div>
              </div>
            </Card>
          </section>

          <section className="rounded-3xl border border-[#C49A4A]/30 bg-[#FAF7EF] p-6 md:p-10">
            <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
              <div className="space-y-6">
                <div>
                  <span className="inline-flex rounded-full bg-[#11203B] px-3 py-1 text-xs font-semibold text-white">AI multi builder</span>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Meet MultiPick</h2>
                  <p className="mt-3 text-base leading-7 text-slate-600">Build structured example multis from real AFL form, live market lines and a transparent edge model — then track how they perform. It’s a data-driven analysis tool, not a betting tips service.</p>
                </div>
                <ul className="space-y-3 text-sm leading-6 text-slate-700">
                <li className="flex gap-3"><span className="font-bold text-[#2E7D5B]">✓</span><span><span className="font-semibold text-[#11203B]">Real recent form</span> — last-5 / last-10 hit rates from AFL game logs.</span></li>
                <li className="flex gap-3"><span className="font-bold text-[#2E7D5B]">✓</span><span><span className="font-semibold text-[#11203B]">Value vs the market</span> — each leg’s form chance compared to the bookmaker’s implied price.</span></li>
                <li className="flex gap-3"><span className="font-bold text-[#2E7D5B]">✓</span><span><span className="font-semibold text-[#11203B]">Correlation-aware odds</span> — same-game legs priced honestly, not just multiplied.</span></li>
                <li className="flex gap-3"><span className="font-bold text-[#2E7D5B]">✓</span><span><span className="font-semibold text-[#11203B]">Matchup-adjusted</span> — factors in how the opponent concedes on each stat.</span></li>
                <li className="flex gap-3"><span className="font-bold text-[#2E7D5B]">✓</span><span><span className="font-semibold text-[#11203B]">Refine by chat</span> — “swap leg 2”, “make it safer”, “around $3”.</span></li>
                </ul>
                <div className="flex flex-col items-start gap-3 pt-1 sm:flex-row sm:items-center">
                  <Button onClick={() => openAuth("signup")} className="w-full sm:w-auto">Try MultiPick — 3 free builds a week</Button>
                  <p className="text-sm text-slate-500">Free to start. 18+ · Gamble responsibly.</p>
                </div>
              </div>

              <Card>
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">MultiPick output · Example</p>
                      <h3 className="mt-1 text-xl font-semibold">3-leg AFL multi</h3>
                      <p className="text-xs text-slate-500">Geelong Cats vs Carlton Blues</p>
                    </div>
                    <div className="shrink-0 rounded-2xl bg-[#11203B] px-4 py-2 text-right text-white">
                      <p className="text-[10px] uppercase tracking-wide text-slate-300">Combined</p>
                      <p className="text-xl font-semibold">$2.12</p>
                      <p className="text-[10px] text-slate-300">~48% chance</p>
                      <p className="text-[10px] text-emerald-300">correlation-adjusted</p>
                    </div>
                  </div>
                  <div className="mt-3 inline-flex rounded-lg bg-[#2E7D5B]/15 px-2.5 py-1 text-xs font-semibold text-[#2E7D5B]">Value vs market +4% · 2 of 3 legs positive-edge</div>
                  <div className="mt-4 space-y-3">
                    {[
                      { team: "Geelong Cats", name: "Midfielder A — 25+ disposals", hit: "9/10", avg: "28.4", matchup: { text: "Carlton concedes +9% disposals", up: true }, last5: [31, 26, 24, 29, 27], conf: "79%", chip: "+7% value", up: true, odds: "$1.38", book: "Sportsbet" },
                      { team: "Carlton Blues", name: "Forward B — 1+ goals", hit: "8/10", avg: "1.8", matchup: { text: "Geelong concedes −6% goals", up: false }, last5: [2, 1, 0, 2, 1], conf: "84%", chip: "+3% value", up: true, odds: "$1.30", book: "TAB" },
                      { team: "Geelong Cats", name: "Midfielder C — 20+ disposals", hit: "8/10", avg: "23.1", matchup: null, last5: [22, 25, 19, 24, 21], conf: "76%", chip: "−2% edge", up: false, odds: "$1.18", book: "Ladbrokes" },
                    ].map((leg, i) => (
                      <div key={leg.name} className="relative rounded-2xl border border-slate-200 bg-[#FAF7EF] p-4">
                        <TeamCrest team={leg.team} className="absolute right-3 top-3 h-6 w-6 drop-shadow-sm" />
                        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Leg {i + 1}</p>
                        <h4 className="mt-0.5 pr-8 text-sm font-semibold text-[#11203B]">{leg.name}</h4>
                        <p className="mt-1.5 text-xs text-slate-600">Cleared this line {leg.hit} recent games · avg {leg.avg}</p>
                        {leg.matchup ? (
                          <p className={"mt-0.5 text-xs font-medium " + (leg.matchup.up ? "text-[#2E7D5B]" : "text-[#A94442]")}>Matchup: {leg.matchup.text}</p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {leg.last5.map((v, idx, arr) => (
                            <span key={idx} className={"inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-[11px] font-semibold " + (idx === arr.length - 1 ? "bg-[#11203B] text-white ring-1 ring-[#C49A4A]" : "bg-[#E8E2D4] text-[#11203B]")}>{v}</span>
                          ))}
                          <span className="ml-1 text-[10px] text-slate-500">last 5</span>
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-[#11203B]">
                          <span>Confidence {leg.conf}</span>
                          <span className={"rounded-full px-2 py-0.5 text-xs font-semibold " + (leg.up ? "bg-[#2E7D5B]/15 text-[#2E7D5B]" : "bg-slate-200 text-slate-600")}>{leg.chip}</span>
                          <span className="text-slate-500">{leg.odds} · {leg.book}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] leading-4 text-slate-500">Illustrative example with placeholder players. Informational analysis only — not betting advice or a guarantee of results.</p>
                </div>
              </Card>
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Track every bet</h3><p className="mt-2 text-sm leading-6 text-slate-600">Record stakes, odds, returns, sports, results and notes so your betting history is easy to review.</p></div></Card>
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Understand performance</h3><p className="mt-2 text-sm leading-6 text-slate-600">See profit/loss, ROI, win rate, streaks and weekly, monthly or yearly trends.</p></div></Card>
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Free to start</h3><p className="mt-2 text-sm leading-6 text-slate-600">Create a free account to track unlimited bets and get 3 MultiPick builds every week. Subscribe for unlimited builds whenever you’re ready.</p><button onClick={() => openAuth("signup")} className="mt-3 text-sm font-medium text-[#11203B] underline">Create free account</button></div></Card>
          </section>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
    </div>
  );
}

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
    terms: {
      title: "Terms of Use",
      body: [
        "By using Pickd, you agree to use it for lawful personal tracking and informational purposes only. You are responsible for the accuracy of the information you enter.",
        "Pickd does not accept bets, process wagers, provide bookmaker services or guarantee betting outcomes. Any betting decisions are made entirely by the user.",
        "The app may change, experience downtime, or contain errors while it is being developed. These terms are a working draft and should be reviewed by a qualified lawyer before commercial launch.",
      ],
    },
  };

  const selected = content[page] || content.disclaimer;

  return (
    <div className="min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <button onClick={() => setActivePage("app")} className="text-sm font-medium text-slate-600 underline">← Back to dashboard</button>
        <Card>
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Pickd</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{selected.title}</h1>
            <div className="mt-6 space-y-4 text-sm leading-7 text-slate-700">
              {selected.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
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

  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [activePage, setActivePage] = useState("app");
  const [bets, setBets] = useState([]);
  const [loadingBets, setLoadingBets] = useState(false);
  const [editingBetId, setEditingBetId] = useState(null);
  const [showAllBets, setShowAllBets] = useState(false);
  // Layout B editorial bet table — filter by status pill (all / pending / won / lost).
  const [statusFilter, setStatusFilter] = useState("all");
  // Click a row in the bet table to smooth-expand its detail panel below.
  const [expandedBetId, setExpandedBetId] = useState(null);
  const [mobileBetsOpen, setMobileBetsOpen] = useState(false);
  const [selectedSportFilter, setSelectedSportFilter] = useState("All sports");
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const mobileFormRef = useRef(null);
  const [chartView, setChartView] = useState("weekly");
  const [chartType, setChartType] = useState("bar");
  const [form, setForm] = useState({ date: todayString(), sport: "AFL", stake: "", odds: "", result: "win", returnAmount: "", notes: "", bookmaker: "", betType: "" });
  // Betslip OCR: paste/upload a screenshot, OpenAI vision extracts the
  // structured details, frontend pre-fills the Add Bet form.
  const [betslipImage, setBetslipImage] = useState(null);
  const [betslipParsing, setBetslipParsing] = useState(false);
  const [betslipError, setBetslipError] = useState("");
  const [betslipExtract, setBetslipExtract] = useState(null);

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
    if (session?.user?.id) loadBets();
    else setBets([]);
  }, [session?.user?.id]);

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
      const response = authMode === "login" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });
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
    setForm({ date: todayString(), sport: "AFL", stake: "", odds: "", result: "win", returnAmount: "", notes: "", bookmaker: "", betType: "" });
  };

  const startEditingBet = (bet) => {
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
    });
    setMessage("Editing bet from " + bet.date + ". Make changes and click Update Bet.");
    window.setTimeout(() => {
      const target = window.innerWidth < 768 ? mobileFormRef.current : formRef.current;
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
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
    });

    if (editingBetId) {
      // Preserve multi-only fields the form doesn't expose (legs, source) so editing
      // a MultiPick multi keeps its legs and "from MultiPick" tag.
      const original = bets.find((bet) => bet.id === editingBetId);
      const rowPayload = betToDatabaseRow(
        { ...betPayload, legs: original?.legs || null, source: original?.source || "manual" },
        session.user.id
      );
      const { data, error } = await supabase.from("bets").update(rowPayload).eq("id", editingBetId).eq("user_id", session.user.id).select().single();
      if (error) {
        setMessage("Could not update bet: " + error.message);
        return;
      }
      const updatedBet = databaseRowToBet(data);
      setBets((current) => current.map((bet) => (bet.id === editingBetId ? updatedBet : bet)));
      setMessage("Bet updated successfully.");
      resetBetForm();
      return;
    }

    const { data, error } = await supabase.from("bets").insert(betToDatabaseRow(betPayload, session.user.id)).select().single();
    if (error) {
      setMessage("Could not add bet: " + error.message);
      return;
    }
    setBets((current) => [databaseRowToBet(data), ...current]);
    resetBetForm();
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
  if (activePage === "edge" && session) return <EdgePage setActivePage={setActivePage} onSaveMulti={saveMultiAsBet} accessToken={session?.access_token} gridBuildStats={gridBuildStats} />;
  if (activePage === "settings" && session) return <SettingsPage setActivePage={setActivePage} bets={bets} exportCsv={exportCsv} exportBackup={exportBackup} clearAllBets={clearAllBets} fileInputRef={fileInputRef} importBackup={importBackup} darkMode={darkMode} setDarkMode={chooseTheme} />;
  if (recoveryMode) return <PasswordRecoveryScreen newPassword={newPassword} setNewPassword={setNewPassword} loading={authLoading} message={message} onSubmit={handleUpdatePassword} />;
  if (!session && activePage !== "auth") return <LandingPage setActivePage={setActivePage} setAuthMode={setAuthMode} />;
  if (!session) return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} loading={authLoading} message={message} onSubmit={handleAuthSubmit} onResetPassword={handlePasswordResetRequest} />;

  return (
    <div className="min-h-screen bg-[#E8E2D4] pb-24 text-[#11203B] md:pb-0">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl">

          <TopNav activePage={activePage} setActivePage={setActivePage} handleLogout={handleLogout} />

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
              mobile uses the bottom nav for navigation. */}
          <div className="space-y-6">
          {/* 2026 Layout B editorial header — 52px display title, eyebrow
              meta (date + email), action buttons + sport filter right-aligned. */}
          <header className="grid gap-10 border-b border-[var(--border-new)] pb-9 md:grid-cols-[1.4fr_1fr] md:items-end">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3-new)]">{activePage === "tracker" ? `${new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })} — ${bets.length} bets logged` : `${new Date().toLocaleDateString("en-AU", { month: "long", year: "numeric" })} · ${session.user.email}`}</p>
              <h1 className="mt-3.5 text-[40px] font-semibold leading-[0.95] tracking-[-0.04em] md:text-[52px]">
                {activePage === "tracker" ? <>My bets,<br />by the numbers.</> : <>Track every bet.<br />Read every result.</>}
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
                <Button onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><span className="mr-1 text-base font-normal leading-none">+</span> Add bet</Button>
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
            <Card className="border-[#C49A4A]/40 bg-[#C49A4A]/15">
              <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#11203B]">Welcome to Pickd</p>
                  <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#11203B]">Start by adding your first bet.</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">Once you add a bet, your dashboard will start showing profit/loss, win rate, ROI, sport history and graph trends.</p>
                </div>
                <Button type="button" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="w-full rounded-2xl px-5 py-3 sm:w-auto">Add first bet</Button>
              </div>
            </Card>
          ) : null}

          {/* Filter + feedback cards removed in Layout B port — sport filter
              lives in the header now; feedback link is in the footer. */}

          {/* Editorial stat strip — Layout B. Hairline dividers between cells,
              no card backgrounds, massive mono numerals. */}
          <section className="grid grid-cols-2 border-y border-[var(--border-new)] py-9 lg:grid-cols-4">
            <div className="relative px-0 pr-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">{selectedSportFilter === "All sports" ? "Profit / loss" : selectedSportFilter + " P/L"}</div>
              <div className={"mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none " + (stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{formatCurrency(stats.totalProfit)}</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Overall betting result</div>
            </div>
            <div className="relative px-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">{selectedSportFilter === "All sports" ? "Win rate" : selectedSportFilter + " win rate"}</div>
              <div className="mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">{stats.winRate.toFixed(1)}%</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]"><span className="mono-nums">{stats.wins}</span>W · <span className="mono-nums">{stats.losses}</span>L</div>
            </div>
            <div className="relative px-0 pr-7 mt-9 lg:mt-0 lg:px-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">{selectedSportFilter === "All sports" ? "ROI" : selectedSportFilter + " ROI"}</div>
              <div className={"mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none " + (stats.roi >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{(stats.roi >= 0 ? "+" : "") + stats.roi.toFixed(1)}%</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]"><span className="mono-nums">{formatCurrency(stats.totalStaked)}</span> staked</div>
            </div>
            <div className="relative px-7 mt-9 lg:mt-0 lg:pl-7 lg:pr-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">{selectedSportFilter === "All sports" ? "Total staked" : selectedSportFilter + " staked"}</div>
              <div className="mono-nums text-[36px] md:text-[44px] font-semibold tracking-[-0.04em] leading-none text-[var(--text-new)]">{formatCurrency(stats.totalStaked)}</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Returned <span className="mono-nums">{formatCurrency(stats.totalReturned)}</span></div>
            </div>
          </section>

          {/* Add Bet + Chart — Dashboard page only. Layout B editorial: both
              unboxed, hairline section dividers, bare-underline form inputs.
              The chart sits on the page background instead of in a card. */}
          {activePage === "app" ? (
          <section className="grid gap-10 border-b border-[var(--border-new)] py-10 lg:grid-cols-5">
            <div className="lg:col-span-2" ref={formRef} onPaste={editingBetId ? undefined : handleBetslipPaste}>
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
                  className={"mb-6 rounded-xl border border-dashed px-4 py-4 transition-colors " + (betslipDragOver ? "border-[var(--accent-new)] bg-[var(--accent-soft-new)]" : "border-[var(--border-new)] bg-[var(--surface-new)]")}
                >
                  {!betslipImage && !betslipParsing ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="pointer-events-none">
                        <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)]">Quick add · AI vision</div>
                        <div className="mt-1.5 text-[13px] text-[var(--text-2-new)]">
                          {betslipDragOver ? (
                            <span className="text-[var(--accent-new)] font-medium">Drop the screenshot to read it</span>
                          ) : (
                            <>
                              <span className="text-[var(--text-new)] font-medium">Drop, paste, or upload a betslip screenshot</span> — we'll read the stake, odds and legs and fill the form for you.
                            </>
                          )}
                        </div>
                      </div>
                      <label className="cursor-pointer rounded-lg border border-[var(--border-new)] bg-transparent px-3.5 py-2 text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--text-2-new)] hover:border-[var(--border-strong-new)] hover:text-[var(--text-new)]">
                        Upload image
                        <input type="file" accept="image/*" onChange={handleBetslipFile} className="hidden" />
                      </label>
                    </div>
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
                <div className="flex items-center justify-between border-t border-[var(--border-new)] pt-4">
                  <div className="text-xs text-[var(--text-3-new)]">Est. P/L: <span className="mono-nums font-medium text-[var(--text-new)]">{form.result === "pending" ? "—" : formatCurrency(calculateProfitLoss(form.result, form.stake, form.result === "loss" ? 0 : form.returnAmount))}</span></div>
                  <Button type="submit">{editingBetId ? "Update bet" : "Save bet"}</Button>
                </div>
              </form>
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
              <div className="mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none text-[var(--positive-new)]">{formatCurrency(stats.biggestWin)}</div>
              <div className="mt-3.5 text-xs text-[var(--text-3-new)]">Top single-bet result</div>
            </div>
            <div className="relative px-7 lg:border-r lg:border-[var(--border-new)]">
              <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-[var(--text-3-new)] mb-3.5">Biggest loss</div>
              <div className={"mono-nums text-[28px] md:text-[36px] font-semibold tracking-[-0.03em] leading-none " + (stats.biggestLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-2-new)]")}>{formatCurrency(stats.biggestLoss)}</div>
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
            const recentForm = settled.slice(-20).reverse();
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
                      <div className={"mono-nums mt-1 text-[20px] font-semibold leading-none " + (stats.totalProfit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{formatCurrency(stats.totalProfit)}</div>
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
                        <div className={"mono-nums mt-2 text-[24px] font-semibold leading-none " + (gridBuildStats.profit >= 0 ? "text-[var(--positive-new)]" : "text-[var(--danger-new)]")}>{formatCurrency(gridBuildStats.profit)}</div>
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
            return (
              <>
                {/* Filter + sort row */}
                <div className="flex items-center justify-between border-b border-[var(--border-new)] py-5">
                  <div className="flex flex-wrap gap-1.5">
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
                        className={"cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition-colors " + (statusFilter === tab.key ? "border-[var(--text-new)] bg-[var(--text-new)] font-medium text-[var(--bg-new)]" : "border-[var(--border-new)] bg-transparent text-[var(--text-2-new)] hover:border-[var(--border-strong-new)]")}
                      >
                        {tab.label} <span className={statusFilter === tab.key ? "ml-1 opacity-60" : "ml-1 text-[var(--text-3-new)]"}>{tab.count}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.06em] text-[var(--text-3-new)]">
                    Sort
                    <span className="cursor-pointer text-[12px] normal-case tracking-normal text-[var(--text-2-new)] hover:text-[var(--text-new)]">Most recent</span>
                  </div>
                </div>

                {/* Mobile cards */}
                <div className="space-y-1 border-b border-[var(--border-new)] py-2 md:hidden">
                  {showing.map((bet) => (
                    <div key={bet.id} className="border-b border-[var(--border-new)] py-4 last:border-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className={"h-2 w-2 shrink-0 rounded-full " + dotClass(bet.result)} />
                          <div>
                            <div className="flex items-baseline gap-2">
                              <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3-new)]">{bet.sport || "OTHER"}</span>
                              <span className="text-sm font-medium text-[var(--text-new)]">{betTitle(bet)}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--text-3-new)]">{bet.date}{bet.bookmaker ? ` · ${bet.bookmaker}` : ""}</div>
                          </div>
                        </div>
                        <span className={"mono-nums text-sm font-medium " + (bet.profitLoss >= 0 ? "text-[var(--positive-new)]" : bet.profitLoss < 0 ? "text-[var(--danger-new)]" : "text-[var(--text-3-new)]")}>{bet.result === "pending" ? "—" : formatCurrency(bet.profitLoss)}</span>
                      </div>
                      <div className="mt-2 flex justify-between text-[11px] text-[var(--text-3-new)]">
                        <span>Stake <span className="mono-nums text-[var(--text-2-new)]">{formatCurrency(bet.stake)}</span></span>
                        <span>Return <span className="mono-nums text-[var(--text-2-new)]">{formatCurrency(bet.returnAmount)}</span></span>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button onClick={() => startEditingBet(bet)} className="rounded border border-[var(--border-new)] px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-[var(--text-2-new)] hover:text-[var(--text-new)]">Edit</button>
                        <button onClick={() => deleteBet(bet.id)} className="rounded border border-[var(--border-new)] px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-[var(--text-2-new)] hover:border-[var(--danger-new)] hover:text-[var(--danger-new)]">Delete</button>
                      </div>
                    </div>
                  ))}
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
                                          const label = hit === "won" ? "✓" : hit === "lost" ? "✗" : "·";
                                          const labelClass = hit === "won" ? "bg-[var(--positive-soft-new)] text-[var(--positive-new)]" : hit === "lost" ? "bg-[var(--danger-soft-new)] text-[var(--danger-new)]" : "bg-[var(--surface-2-new)] text-[var(--text-3-new)]";
                                          return (
                                            <div key={i} className={"grid grid-cols-[28px_1fr_80px] items-center gap-4 px-4 py-3 " + (i > 0 ? "border-t border-[var(--border-new)]" : "")}>
                                              <div className={"grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold " + labelClass}>{label}</div>
                                              <div>
                                                <div className="text-[13px] font-medium text-[var(--text-new)]">{leg.player || leg.name || `Leg ${i + 1}`}{leg.line ? <span className="font-normal text-[var(--text-3-new)]"> — {leg.line}</span> : null}</div>
                                                {leg.game || leg.result || leg.reason ? (
                                                  <div className="mt-0.5 text-[11px] text-[var(--text-3-new)]">
                                                    {leg.game ? <span>{leg.game}</span> : null}
                                                    {leg.game && (leg.result || leg.reason) ? " · " : ""}
                                                    {leg.result ? <span>{leg.result}</span> : leg.reason ? <span>{leg.reason}</span> : null}
                                                  </div>
                                                ) : null}
                                              </div>
                                              <div className="mono-nums text-right text-[13px] text-[var(--text-2-new)]">{leg.odds ? `$${formatOdds(leg.odds)}` : "—"}</div>
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
    </div>
  );
}

runBasicTests();
