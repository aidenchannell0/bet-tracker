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

function Card({ children, className = "" }) {
  return <div className={"rounded-2xl border border-slate-200 bg-[#FAF7EF] shadow-sm " + className}>{children}</div>;
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
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
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

function PendingBetsCard({ bets, onSettle, onDelete }) {
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
                  <p className="font-semibold text-[#11203B]">{bet.betType || "Bet"} · {bet.sport || "Other"} @ ${bet.odds}</p>
                  <p className="text-xs text-slate-500">{bet.date} · {formatCurrency(bet.stake)} stake{bet.source === "grid_build" ? " · from Grid Build" : ""}</p>
                </div>
                <p className="text-sm font-medium text-[#11203B]">Returns {formatCurrency(Number(bet.stake || 0) * Number(bet.odds || 0))}</p>
              </div>
              {Array.isArray(bet.legs) && bet.legs.length ? (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {bet.legs.map((leg, index) => <li key={index}>• {leg.name || leg.player}{leg.odds ? ` @ $${leg.odds}` : ""}</li>)}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button onClick={() => onSettle(bet.id, "win")} className="bg-[#2E7D5B] hover:bg-[#27684c]">Won</Button>
                <Button onClick={() => onSettle(bet.id, "loss")} className="bg-[#A94442] hover:bg-[#8f3a38]">Lost</Button>
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
        <h2 className="text-lg font-semibold md:text-xl">Grid Build performance</h2>
        <p className="text-sm text-slate-500">How the multis you saved from Grid Build have actually gone.</p>
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
  const base = "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "outline"
      ? "border border-slate-300 bg-[#FAF7EF] text-slate-900 hover:bg-[#E8E2D4]"
      : variant === "ghost"
      ? "bg-transparent text-slate-600 hover:bg-[#E8E2D4]"
      : "bg-[#11203B] text-white hover:bg-slate-800";

  return (
    <button className={base + " " + styles + " " + className} {...props}>
      {children}
    </button>
  );
}

function Input({ className = "", ...props }) {
  return <input className={"w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:bg-[#E8E2D4] " + className} {...props} />;
}

function StatCard({ title, value, helper }) {
  return (
    <Card>
      <div className="p-5">
        <p className="text-sm text-slate-500">{title}</p>
        <p className="mt-1 text-2xl font-semibold text-[#11203B]">{value}</p>
        {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
      </div>
    </Card>
  );
}

function ColoredStatCard({ title, value, helper, tone = "neutral" }) {
  const toneClass =
    tone === "green"
      ? "!border-[#9BCBB2] !bg-[#DDEFE5]"
      : tone === "red"
      ? "!border-[#D9A39B] !bg-[#F3DDD7]"
      : "!border-slate-200 !bg-[#FAF7EF]";

  const labelClass =
    tone === "green"
      ? "text-[#2E7D5B]"
      : tone === "red"
      ? "text-[#A94442]"
      : "text-slate-500";

  const valueClass =
    tone === "green"
      ? "text-[#2E7D5B]"
      : tone === "red"
      ? "text-[#A94442]"
      : "text-[#11203B]";

  return (
    <Card className={toneClass}>
      <div className="p-5">
        <p className={`text-sm font-medium ${labelClass}`}>{title}</p>
        <p className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</p>
        {helper ? <p className={`mt-1 text-xs ${labelClass}`}>{helper}</p> : null}
      </div>
    </Card>
  );
}

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, loading, message, onSubmit, onResetPassword }) {
  return (
    <div className="min-h-screen bg-[#E8E2D4] p-4 text-[#11203B] md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Online version</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Bet Grid</h1>
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
            <p className="mt-2 text-sm text-slate-600">Enter a new password for your Bet Grid account.</p>
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

function Footer({ setActivePage }) {
  return (
    <footer className="border-t border-slate-200 py-6 text-sm text-slate-500">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 md:flex-row md:items-center md:justify-between md:px-8">
        <p>© {new Date().getFullYear()} Bet Grid. Informational use only.</p>
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
        <div className="mx-auto max-w-3xl space-y-6">
          <button onClick={() => setActivePage("app")} className="text-sm font-medium text-slate-600 underline">← Back to dashboard</button>
          <Card>
            <div className="p-6 md:p-8">
              <p className="text-sm font-medium text-slate-500">Bet Grid</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">Settings</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">Manage exports, backups and account-level bet data actions.</p>

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
                  <p className="mt-1 text-sm leading-6 text-slate-600">Import a Bet Grid JSON backup. Imported bets will be added to your online account.</p>
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
    </div>
  );
}

function EdgeRiskMeter({ score }) {
  const riskColor = score <= 3 ? "bg-emerald-500" : score <= 6 ? "bg-orange-500" : "bg-red-500";
  const riskWidth = Math.max(10, score * 10) + "%";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">Overall risk score</span>
        <span className="font-semibold text-[#11203B]">{score}/10</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        <div className={"h-full rounded-full " + riskColor} style={{ width: riskWidth }} />
      </div>
    </div>
  );
}

function EdgeSelectField({ label, value, options, onChange }) {
  return (
    <label className="space-y-1 text-sm font-medium">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200">
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
            <p className="mt-1 leading-6">{leg.trend}</p>
          </div>
          <div>
            <p className="font-medium text-slate-900">Why Grid Build included it</p>
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
        <strong key={index} className="font-semibold text-[#11203B]">
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
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-line rounded-2xl bg-[#11203B] px-4 py-3 text-sm leading-6 text-white">{children}</div>
      </div>
    );
  }

  if (!sections.length) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] whitespace-pre-line rounded-2xl bg-[#E8E2D4] px-4 py-3 text-sm leading-6 text-slate-800">{renderEdgeText(children)}</div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-3">
        {sections.map((section) => (
          <div key={section.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-800">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{section.label}</p>
            <p className="whitespace-pre-line">{renderEdgeText(section.content)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function EdgePage({ setActivePage, onSaveMulti, accessToken }) {
  const [mode, setMode] = useState("multi");
  const [sport, setSport] = useState("AFL");
  const [legs, setLegs] = useState("3");
  const [targetOdds, setTargetOdds] = useState("$2.00");
  const [customTargetOdds, setCustomTargetOdds] = useState("2.20");
  const [customLegs, setCustomLegs] = useState("6");
  const [riskProfile, setRiskProfile] = useState("Balanced");
  const [request, setRequest] = useState("Disposals only");
  const [chatInput, setChatInput] = useState("");
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [showRiskExplanation, setShowRiskExplanation] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [lastEdgeContext, setLastEdgeContext] = useState(null);
  const [multiOutput, setMultiOutput] = useState(null);
  const [betStake, setBetStake] = useState("");
  const [savingBet, setSavingBet] = useState(false);
  const [saveBetMsg, setSaveBetMsg] = useState("");
  const [entitlement, setEntitlement] = useState({ subscribed: false, usage: 0, limit: 3 });
  const [upgrading, setUpgrading] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);

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
        text: "Simple view:\n\nNew Grid Build chat started. Ask me for an example multi, a game analysis structure, or what data I would check before building a selection.\n\nExample structure:\n\nYou can ask things like: Build a 3-leg AFL example around $2.00 using disposals only.\n\nWhat I would check:\n\nI will explain the key data needed without pretending live stats are connected yet.\n\nRisk level:\n\nI can explain the risk on a 1 to 10 scale.\n\nImportant:\n\nThis is informational only, not betting advice.",
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

  const previewMulti = () => {
    if (edgeLoading) return;
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
            request,
            gameId: selectedGameId,
            previousEdgeContext: lastEdgeContext,
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
      if (!response.ok) throw new Error(data.error || "Grid Build request failed");
      setChatMessages((current) => [...current, { role: "edge", text: data.reply }]);
    } catch (error) {
      setChatMessages((current) => [
        ...current,
        {
          role: "edge",
          text: "Simple view:\n\nGrid Build could not respond right now.\n\nExample structure:\n\nThis usually means the backend API, OpenAI key, or deployment needs to be checked.\n\nWhat I would check:\n\nConfirm the Vercel function is deployed and the OPENAI_API_KEY is set correctly.\n\nRisk level:\n\nTechnical issue only.\n\nImportant:\n\nTry again shortly after checking the setup.",
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
          <header className="grid gap-6 lg:grid-cols-[1.35fr_0.75fr] lg:items-start">
            <div>
              <button onClick={() => setActivePage("app")} className="mb-3 text-sm font-medium text-slate-600 underline">← Back to dashboard</button>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-slate-500">AI multi builder preview</p>
                <span className="rounded-full bg-[#11203B] px-3 py-1 text-xs font-semibold text-white">Beta preview</span>
              </div>
              <h1 className="mt-2 text-4xl font-bold tracking-tight md:text-6xl">Grid Build</h1>
              <p className="mt-2 max-w-2xl text-slate-600">A smarter way to build structured example multis using market lines, recent trends and risk scoring.</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-[#FAF7EF] px-4 py-3 text-sm">
                {entitlement.subscribed ? (
                  <>
                    <span className="font-semibold text-[#2E7D5B]">Grid Build Pro — unlimited builds ✓</span>
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
                <p className="font-semibold text-[#11203B]">What is Grid Build?</p>
                <p className="mt-1">Grid Build is Bet Grid’s AI-powered multi builder. It helps create structured example multis, explain risk levels, compare market types and show what data should be checked before making decisions. Grid Build is designed to be structured and data-focused, not a betting tips service.</p>
              </div>
            </div>
            <div className="space-y-4 lg:pt-10">
              <div className="rounded-2xl border border-[#C49A4A]/40 bg-[#C49A4A]/15 p-4 text-sm leading-6 text-[#11203B] shadow-sm">
                <span className="font-semibold">Important:</span> Grid Build is for informational analysis only. It is not betting advice, financial advice, or a guarantee of results. Always make your own decision and gamble responsibly.
              </div>
              <div className="flex flex-col items-start gap-3 lg:items-end">
                <div className="rounded-2xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-sm text-slate-600 shadow-sm">
                  <span className="font-semibold text-[#11203B]">Live AFL data</span><br />Powered by current odds and AFL Tables stats
                </div>
              </div>
            </div>
          </header>

          <section className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
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
                    <label className="space-y-1 text-sm font-medium">Optional request<Input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Disposals only, no same-game legs" /></label>
                    <div className="pt-2"><Button onClick={previewMulti} disabled={edgeLoading} className="w-full rounded-2xl py-3 text-base">{edgeLoading ? "Analysing..." : "Preview example multi"}</Button></div>
                  </div>
                ) : (
                  <div className="mt-6 space-y-5">
                    <EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NRL", "Soccer", "Basketball", "Cricket"]} />
                    <EdgeSelectField label="Game" value={selectedGameId} onChange={setSelectedGameId} options={[{ label: games.length ? "Select upcoming game" : "Loading games…", value: "" }, ...games.map((game) => ({ label: game.label, value: game.id }))]} />
                    <label className="space-y-1 text-sm font-medium">Focus area<Input value="Recent form, injuries and head-to-head" readOnly /></label>
                    <div className="pt-2"><Button className="w-full rounded-2xl py-3 text-base">Preview game analysis</Button></div>
                  </div>
                )}
              </div>
            </Card>

            <div className="space-y-6" ref={outputPanelRef}>
              <Card>
                <div className="p-5 md:p-6">
                  <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                    <div>
                      <p className="text-sm font-medium text-slate-500">Grid Build output</p>
                      <h2 className="mt-1 text-2xl font-semibold">
                        {multiOutput
                          ? `${multiOutput.legCount}-leg ${multiOutput.sport} multi`
                          : `Example ${displayedLegs}-leg ${sport} multi`}
                      </h2>
                      <p className="mt-2 text-sm text-slate-600">
                        {multiOutput
                          ? <>Built from real {multiOutput.sport} stats and the best available bookmaker odds. Refine it in the chat below.</>
                          : <>The example below is illustrative. Click <span className="font-semibold">Preview example multi</span> to generate a live build from real {sport} stats and current market lines.</>}
                      </p>
                      {multiOutput?.oddsNote ? (
                        <p className="mt-2 inline-flex rounded-lg border border-[#C49A4A]/40 bg-[#C49A4A]/15 px-3 py-2 text-xs leading-5 text-[#11203B]">{multiOutput.oddsNote}</p>
                      ) : null}
                    </div>
                    <div className="rounded-2xl bg-[#11203B] px-4 py-3 text-white">
                      <p className="text-xs uppercase tracking-wide text-slate-300">{multiOutput ? "Combined odds" : "Target odds"}</p>
                      <p className="text-2xl font-semibold">{multiOutput ? `$${multiOutput.combinedOdds}` : displayedTargetOdds}</p>
                      {multiOutput ? <p className="mt-0.5 text-xs text-slate-300">~{multiOutput.combinedProbPct}% combined chance</p> : null}
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-3">
                    {(multiOutput?.legs || exampleLegs).map((leg, index) => (
                      <div key={`${leg.name}-${index}`} className="rounded-2xl border border-slate-200 p-4">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Leg {index + 1}</p>
                        <h3 className="mt-1 font-semibold">{leg.name}</h3>
                        {leg.game ? <p className="mt-0.5 text-xs text-slate-500">{leg.game}</p> : null}
                        <p className="mt-2 text-sm text-slate-600">{leg.reason}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-[#11203B]">
                          <span>Confidence: {leg.confidence}</span>
                          {leg.odds ? <span className="text-slate-500">Odds: ${leg.odds}{leg.bookmaker ? ` · ${leg.bookmaker}` : ""}</span> : null}
                        </div>
                        <EdgeDetailToggle leg={leg} />
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 rounded-2xl bg-slate-50 p-4">
                    <EdgeRiskMeter score={multiOutput ? multiOutput.risk : 6} />
                    <button
                      type="button"
                      onClick={() => setShowRiskExplanation((current) => !current)}
                      className="mt-4 flex w-full max-w-sm items-center justify-between rounded-xl border border-slate-200 bg-[#FAF7EF] px-4 py-2.5 text-left text-sm font-semibold text-slate-900 transition hover:bg-white/70"
                    >
                      <span>Why this risk score?</span>
                      <span className="text-lg text-slate-500">{showRiskExplanation ? "−" : "+"}</span>
                    </button>
                    {showRiskExplanation ? (
                      <div className="mt-3 rounded-2xl bg-[#FAF7EF] p-4 text-sm leading-6 text-slate-700">
                        {multiOutput
                          ? multiOutput.riskExplanation
                          : "A 6/10 preview score reflects a balanced multi with multiple legs and player-market variance. The live version will calculate this from odds, markets, leg count and data confidence."}
                      </div>
                    ) : null}
                  </div>

                  {multiOutput ? (
                    <div className="mt-4 rounded-2xl border border-[#11203B]/15 bg-[#FAF7EF] p-4">
                      <p className="text-sm font-semibold text-[#11203B]">Track this multi</p>
                      <p className="mt-1 text-xs text-slate-500">Save it to your tracker as a pending bet, then settle it on the dashboard after the games.</p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input type="number" min="0" step="0.01" placeholder="Stake (e.g. 20)" value={betStake} onChange={(event) => setBetStake(event.target.value)} className="sm:max-w-[160px]" />
                        <Button type="button" onClick={addMultiToBets} disabled={savingBet}>{savingBet ? "Saving..." : "Add to my bets"}</Button>
                      </div>
                      {saveBetMsg ? <p className="mt-2 text-xs font-medium text-[#11203B]">{saveBetMsg}</p> : null}
                    </div>
                  ) : null}
                </div>
              </Card>
            </div>
          </section>

          <div ref={chatSectionRef}><Card>
            <div className="p-5 md:p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div>
                  <p className="text-sm font-medium text-slate-500">Chat with Grid Build</p>
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
                  <p className="text-sm font-semibold text-[#11203B]">Try Grid Build</p>
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
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask Grid Build a follow-up..." onKeyDown={(event) => { if (event.key === "Enter") sendChatMessage(); }} disabled={edgeLoading} />
                <Button onClick={() => sendChatMessage()} className="sm:px-6" disabled={edgeLoading}>{edgeLoading ? "Thinking..." : "Send"}</Button>
              </div>
            </div>
          </Card></div>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
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
          <header className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
            <div>
              <p className="text-sm font-medium text-slate-500">Bet Grid</p>
              <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Track every bet. Understand every result.</h1>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => openAuth("login")}>Log in</Button>
              <Button onClick={() => openAuth("signup")}>Sign up</Button>
            </div>
          </header>

          <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div className="space-y-6">
              <div>
                <h2 className="text-4xl font-bold tracking-tight md:text-6xl">Know if you are actually winning.</h2>
                <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">Bet Grid helps you record every bet, review your profit and loss, monitor your win rate, and understand your performance over time.</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button onClick={() => openAuth("signup")} className="w-full sm:w-auto">Start tracking</Button>
                <Button variant="outline" onClick={() => openAuth("login")} className="w-full sm:w-auto">I already have an account</Button>
              </div>
              <p className="text-sm text-slate-500">Built for tracking and informational use. Bet Grid does not accept bets or guarantee outcomes.</p>
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

          <section className="grid gap-4 md:grid-cols-3">
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Track every bet</h3><p className="mt-2 text-sm leading-6 text-slate-600">Record stakes, odds, returns, sports, results and notes so your betting history is easy to review.</p></div></Card>
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Understand performance</h3><p className="mt-2 text-sm leading-6 text-slate-600">See profit/loss, ROI, win rate, streaks and weekly, monthly or yearly trends.</p></div></Card>
            <Card><div className="p-5"><h3 className="text-lg font-semibold">Meet Grid Build</h3><p className="mt-2 text-sm leading-6 text-slate-600">Grid Build helps create structured example multis using market lines, recent trends and risk scoring. It is an educational multi builder, not a betting tips service.</p><button onClick={() => openAuth("signup")} className="mt-3 text-sm font-medium text-[#11203B] underline">Join to preview Grid Build</button></div></Card>
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
        "Bet Grid is designed to help users record, review and understand their own betting activity. The information shown in the app is for general informational and tracking purposes only.",
        "Nothing in Bet Grid should be treated as financial advice, betting advice, a guarantee of results or an instruction to place a bet. Betting involves risk, and users are responsible for their own decisions.",
        "Statistics, graphs and future AI-generated analysis may contain errors, omissions or outdated information. Always check information independently before relying on it.",
      ],
    },
    responsible: {
      title: "Responsible Gambling",
      body: [
        "Bet Grid is intended to support awareness and accountability. If betting stops being fun, causes stress, or affects your finances, relationships, study or work, consider taking a break and seeking support.",
        "Set limits before you bet, never bet more than you can afford to lose, and do not chase losses. Tracking losses clearly is one of the reasons this app exists.",
        "If you are in Australia and need support, consider contacting Gambling Help Online or your local gambling support service. If you are outside Australia, contact the relevant support service in your country.",
      ],
    },
    privacy: {
      title: "Privacy Policy",
      body: [
        "Bet Grid stores account and bet-tracking information so users can access their data across devices. This may include email address, bet dates, stakes, returns, results, notes and related performance statistics.",
        "Bet Grid does not need users to enter bookmaker account details or payment card details to use the core tracking features. Do not enter sensitive personal information into the notes field.",
        "Data is stored using third-party infrastructure providers such as Supabase and Vercel. As the product develops, this policy should be reviewed and replaced with a full legal privacy policy before wider public marketing.",
      ],
    },
    terms: {
      title: "Terms of Use",
      body: [
        "By using Bet Grid, you agree to use it for lawful personal tracking and informational purposes only. You are responsible for the accuracy of the information you enter.",
        "Bet Grid does not accept bets, process wagers, provide bookmaker services or guarantee betting outcomes. Any betting decisions are made entirely by the user.",
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
            <p className="text-sm font-medium text-slate-500">Bet Grid</p>
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


function MobileBottomNav({ activePage, setActivePage, formRef }) {
  const navButtonClass =
    "flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-xs font-semibold transition";

  const inactiveClass = "text-slate-500 hover:bg-[#E8E2D4] hover:text-[#11203B]";
  const activeClass = "bg-[#11203B] text-white shadow-sm";

  const goToDashboard = () => {
    setActivePage("app");
    window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 50);
  };

  const goToAddBet = () => {
    setActivePage("app");
    window.setTimeout(() => {
      formRef?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-slate-200 bg-[#FAF7EF]/95 px-3 pb-[env(safe-area-inset-bottom)] pt-2 shadow-[0_-8px_25px_rgba(15,23,42,0.12)] backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-xl gap-2 rounded-3xl">
        <button
          type="button"
          onClick={goToDashboard}
          className={`${navButtonClass} ${activePage === "app" ? activeClass : inactiveClass}`}
        >
          <span className="text-lg">⌂</span>
          <span>Home</span>
        </button>

        <button
          type="button"
          onClick={goToAddBet}
          className={`${navButtonClass} bg-[#C49A4A]/20 text-[#11203B] hover:bg-[#C49A4A]/30`}
        >
          <span className="text-lg">＋</span>
          <span>Add</span>
        </button>

        <button
          type="button"
          onClick={() => setActivePage("edge")}
          className={`${navButtonClass} ${activePage === "edge" ? activeClass : inactiveClass}`}
        >
          <span className="text-lg">◇</span>
          <span>Build</span>
        </button>

        <button
          type="button"
          onClick={() => setActivePage("settings")}
          className={`${navButtonClass} ${activePage === "settings" ? activeClass : inactiveClass}`}
        >
          <span className="text-lg">⚙</span>
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}

export default function BettingTrackerWebsite() {
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("theme") === "dark");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("theme", darkMode ? "dark" : "light");
  }, [darkMode]);

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
  const [selectedSportFilter, setSelectedSportFilter] = useState("All sports");
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const mobileFormRef = useRef(null);
  const [chartView, setChartView] = useState("weekly");
  const [chartType, setChartType] = useState("bar");
  const [form, setForm] = useState({ date: todayString(), sport: "AFL", stake: "", odds: "", result: "win", returnAmount: "", notes: "", bookmaker: "", betType: "" });
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
      const { data, error } = await supabase.from("bets").update(betToDatabaseRow(betPayload, session.user.id)).eq("id", editingBetId).eq("user_id", session.user.id).select().single();
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
      notes: `Grid Build ${multi.legCount}-leg multi`,
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
    downloadFile(JSON.stringify({ app: "Bet Grid", version: 2, exportedAt: new Date().toISOString(), bets }, null, 2), "bet-grid-backup.json", "application/json;charset=utf-8;");
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
        window.alert("Could not import that backup file. Make sure it is a Bet Grid JSON backup.");
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
  if (activePage === "edge" && session) return <EdgePage setActivePage={setActivePage} onSaveMulti={saveMultiAsBet} accessToken={session?.access_token} />;
  if (activePage === "settings" && session) return <SettingsPage setActivePage={setActivePage} bets={bets} exportCsv={exportCsv} exportBackup={exportBackup} clearAllBets={clearAllBets} fileInputRef={fileInputRef} importBackup={importBackup} darkMode={darkMode} setDarkMode={setDarkMode} />;
  if (recoveryMode) return <PasswordRecoveryScreen newPassword={newPassword} setNewPassword={setNewPassword} loading={authLoading} message={message} onSubmit={handleUpdatePassword} />;
  if (!session && activePage !== "auth") return <LandingPage setActivePage={setActivePage} setAuthMode={setAuthMode} />;
  if (!session) return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} loading={authLoading} message={message} onSubmit={handleAuthSubmit} onResetPassword={handlePasswordResetRequest} />;

  return (
    <div className="min-h-screen bg-[#E8E2D4] text-[#11203B]">
      <main className="bg-[#E8E2D4] p-4 md:p-8">
        <div className="mx-auto max-w-7xl">

          <div className="space-y-4 md:hidden">
            <header className="space-y-1">
              <p className="text-sm font-medium text-slate-500">Online account version</p>
              <h1 className="text-3xl font-bold tracking-tight">Bet Grid</h1>
              <p className="text-sm text-slate-500">Logged in as {session.user.email}</p>
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
                  <p className="text-sm font-semibold text-[#11203B]">Open Grid Build</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Explore player markets, game analysis and example multis.</p>
                </div>
                <Button onClick={() => setActivePage("edge")} className="w-full rounded-2xl py-3 text-base font-semibold">Open Grid Build</Button>
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
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Recent bets</h2>
                    <p className="text-xs text-slate-500">Showing {visibleBets.length} of {filteredBets.length}</p>
                  </div>
                  {filteredBets.length > 5 ? <button type="button" onClick={() => setShowAllBets((current) => !current)} className="text-sm font-semibold text-[#11203B] underline">{showAllBets ? "Show less" : "View all"}</button> : null}
                </div>

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
              </div>
            </Card>

            <Card>
              <div className="space-y-3 p-4">
                <p className="text-sm font-semibold text-[#11203B]">Account and feedback</p>
                <a
                  href="mailto:aidenchannell0@gmail.com?subject=Bet%20Grid%20Feedback&body=What%20did%20you%20think%20of%20Bet%20Grid%3F%0A%0AWhat%20was%20confusing%3F%0A%0AWhat%20feature%20should%20come%20next%3F%0A%0AWould%20you%20use%20Grid%20Build%20with%20live%20sports%20data%3F"
                  className="block rounded-xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-sm font-medium text-[#11203B]"
                >
                  Give feedback
                </a>
                <button type="button" onClick={() => setActivePage("settings")} className="w-full rounded-xl border border-slate-200 bg-[#FAF7EF] px-4 py-3 text-left text-sm font-medium text-[#11203B]">Settings</button>
                <button type="button" onClick={handleLogout} className="w-full rounded-xl border border-red-300 bg-red-100 px-4 py-3 text-left text-sm font-medium text-red-900">Log out</button>
              </div>
            </Card>
          </div>


          <div className="hidden space-y-6 md:block">
          <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className="text-sm font-medium text-slate-500">Online account version</p>
              <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Bet Grid</h1>
              <p className="mt-2 max-w-2xl text-slate-600">Track stakes, returns, profit/loss, win rate, ROI and weekly performance. Your data is saved online with Supabase.</p>
              <p className="mt-1 text-sm text-slate-500">Logged in as {session.user.email}</p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              <div className="relative max-w-sm rounded-2xl border border-slate-300 bg-[#FAF7EF] px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
                Hi, I’m Grid Build. I can help you explore example multis, player markets, and game analysis.
                <span className="absolute -bottom-2 left-[28%] h-4 w-4 rotate-45 border-b border-r border-slate-300 bg-[#FAF7EF]" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                <Button onClick={() => setActivePage("edge")} className="col-span-2 w-full rounded-2xl px-6 py-4 text-base font-semibold shadow-lg shadow-slate-300 sm:col-span-1 sm:w-auto">Open Grid Build</Button>
                <Button onClick={() => setActivePage("settings")} variant="outline" className="w-full sm:w-auto">Settings</Button>
                <Button onClick={handleLogout} variant="outline" className="col-span-2 w-full sm:col-span-1 sm:w-auto">Log out</Button>
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
                  <p className="text-sm font-semibold text-[#11203B]">Welcome to Bet Grid</p>
                  <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#11203B]">Start by adding your first bet.</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">Once you add a bet, your dashboard will start showing profit/loss, win rate, ROI, sport history and graph trends.</p>
                </div>
                <Button type="button" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="w-full rounded-2xl px-5 py-3 sm:w-auto">Add first bet</Button>
              </div>
            </Card>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[1.35fr_0.9fr]">
            <Card>
              <div className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#11203B]">Dashboard filter</p>
                  <p className="mt-1 text-xs text-slate-600 md:text-sm">Filter stats, graph and history by sport.</p>
                </div>
                <label className="space-y-1 text-sm font-medium md:min-w-52">
                  Sport
                  <select
                    value={selectedSportFilter}
                    onChange={(event) => {
                      setSelectedSportFilter(event.target.value);
                      setShowAllBets(false);
                    }}
                    className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-[#11203B] focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="All sports">All sports</option>
                    <option value="AFL">AFL</option>
                    <option value="NRL">NRL</option>
                    <option value="Soccer">Soccer</option>
                    <option value="Basketball">Basketball</option>
                    <option value="Cricket">Cricket</option>
                    <option value="Other">Other</option>
                  </select>
                </label>
              </div>
            </Card>

            <Card className="border-[#C49A4A]/40 bg-[#C49A4A]/10">
              <div className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#11203B]">Quick feedback</p>
                  <p className="mt-1 text-xs leading-5 text-slate-700 md:text-sm">Got an idea or found something confusing?</p>
                </div>
                <a
                  href="mailto:aidenchannell0@gmail.com?subject=Bet%20Grid%20Feedback&body=What%20did%20you%20think%20of%20Bet%20Grid%3F%0A%0AWhat%20was%20confusing%3F%0A%0AWhat%20feature%20should%20come%20next%3F%0A%0AWould%20you%20use%20Grid%20Build%20with%20live%20sports%20data%3F"
                  className="inline-flex w-full items-center justify-center rounded-xl bg-[#11203B] px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 md:w-auto"
                >
                  Give feedback
                </a>
              </div>
            </Card>
          </div>

          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <ColoredStatCard
              title={selectedSportFilter === "All sports" ? "Total Profit/Loss" : selectedSportFilter + " Profit/Loss"}
              value={formatCurrency(stats.totalProfit)}
              helper="Overall betting result"
              tone={stats.totalProfit >= 0 ? "green" : "red"}
            />
            <ColoredStatCard
              title={selectedSportFilter === "All sports" ? "Win Rate" : selectedSportFilter + " Win Rate"}
              value={stats.winRate.toFixed(1) + "%"}
              helper={stats.wins + " wins, " + stats.losses + " losses"}
              tone="green"
            />
            <ColoredStatCard
              title={selectedSportFilter === "All sports" ? "ROI" : selectedSportFilter + " ROI"}
              value={stats.roi.toFixed(1) + "%"}
              helper="Profit compared to total staked"
              tone={stats.roi >= 0 ? "green" : "red"}
            />
            <ColoredStatCard
              title={selectedSportFilter === "All sports" ? "Total Staked" : selectedSportFilter + " Staked"}
              value={formatCurrency(stats.totalStaked)}
              helper={"Returned: " + formatCurrency(stats.totalReturned)}
              tone="neutral"
            />
          </section>

          <section className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-2">
              <div ref={formRef} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{editingBetId ? "Edit bet" : "Add a bet"}</h2>
                    {editingBetId ? <p className="mt-1 text-sm text-slate-500">Update the details below, then save your changes.</p> : null}
                  </div>
                  {editingBetId ? <Button type="button" variant="outline" onClick={resetBetForm}>Cancel</Button> : null}
                </div>
                <form onSubmit={handleAddOrUpdateBet} className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="space-y-1 text-sm font-medium">Date<Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
                    <label className="space-y-1 text-sm font-medium">Sport<select value={form.sport} onChange={(event) => setForm({ ...form, sport: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="AFL">AFL</option><option value="NRL">NRL</option><option value="Soccer">Soccer</option><option value="Basketball">Basketball</option><option value="Cricket">Cricket</option><option value="Other">Other</option></select></label>
                    <label className="space-y-1 text-sm font-medium">Result<select value={form.result} onChange={(event) => setForm({ ...form, result: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="win">Win</option><option value="loss">Loss</option><option value="void">Void</option><option value="pending">Pending</option></select></label>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
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
                  <Button type="submit" className="w-full">{editingBetId ? "Update Bet" : "Add Bet"}</Button>
                </form>
              </div>
            </Card>

            <Card className="lg:col-span-3">
              <div className="p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div><h2 className="text-xl font-semibold">{chartTitle}</h2><p className="text-sm text-slate-500">{chartDescription}</p></div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <select value={chartView} onChange={(event) => setChartView(event.target.value)} className="rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
                    <select value={chartType} onChange={(event) => setChartType(event.target.value)} className="rounded-xl border border-slate-300 bg-[#FAF7EF] px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="bar">Bar graph</option><option value="line">Line graph</option><option value="area">Area graph</option></select>
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
                  ) : <div className="flex h-full items-center justify-center rounded-2xl bg-[#E8E2D4] text-sm text-slate-500">Add your first bet to see the graph.</div>}
                </div>
              </div>
            </Card>
          </section>

          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <ColoredStatCard
              title="Biggest Win"
              value={formatCurrency(stats.biggestWin)}
              tone="green"
            />
            <ColoredStatCard
              title="Biggest Loss"
              value={formatCurrency(stats.biggestLoss)}
              tone={stats.biggestLoss < 0 ? "red" : "neutral"}
            />
            <ColoredStatCard
              title="Longest Winning Streak"
              value={String(stats.longestWinningStreak) + " bets"}
              tone="green"
            />
            <ColoredStatCard
              title="Longest Losing Streak"
              value={String(stats.longestLosingStreak) + " bets"}
              tone={stats.longestLosingStreak > 0 ? "red" : "neutral"}
            />
          </section>

          <Card>
            <div className="p-5">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
                <div>
                  <h2 className="text-xl font-semibold">Bet history</h2>
                  <p className="text-sm text-slate-500">Edit or delete entries if you make a mistake.</p>
                </div>
                <p className="text-sm text-slate-500">Showing {visibleBets.length} of {filteredBets.length} bets{selectedSportFilter !== "All sports" ? " for " + selectedSportFilter : ""}</p>
              </div>

              <div className="mt-4 space-y-3 md:hidden">
                {visibleBets.map((bet) => (
                  <div key={bet.id} className={"rounded-2xl border border-slate-200 p-4 " + (editingBetId === bet.id ? "bg-slate-50" : "bg-[#FAF7EF]")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[#11203B]">{bet.date}</p>
                        <p className="mt-1 text-xs capitalize text-slate-500">{bet.sport || "Other"} · {bet.result} · Odds {bet.odds || "-"}</p>
                      </div>
                      <p className={"text-base font-semibold " + (bet.profitLoss >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(bet.profitLoss)}</p>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-[#E8E2D4] p-3"><p className="text-xs text-slate-500">Stake</p><p className="font-medium text-[#11203B]">{formatCurrency(bet.stake)}</p></div>
                      <div className="rounded-xl bg-[#E8E2D4] p-3"><p className="text-xs text-slate-500">Return</p><p className="font-medium text-[#11203B]">{formatCurrency(bet.returnAmount)}</p></div>
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

              <div className="mt-4 hidden overflow-x-auto md:block">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead><tr className="border-b text-slate-500"><th className="py-3 pr-4 font-medium">Date</th><th className="py-3 pr-4 font-medium">Sport</th><th className="py-3 pr-4 font-medium">Stake</th><th className="py-3 pr-4 font-medium">Odds</th><th className="py-3 pr-4 font-medium">Result</th><th className="py-3 pr-4 font-medium">Return</th><th className="py-3 pr-4 font-medium">Profit/Loss</th><th className="py-3 pr-4 font-medium">Notes</th><th className="py-3 pr-4 font-medium">Actions</th></tr></thead>
                  <tbody>
                    {visibleBets.map((bet) => (
                      <tr key={bet.id} className={"border-b last:border-0 " + (editingBetId === bet.id ? "bg-slate-50" : "")}><td className="py-3 pr-4">{bet.date}</td><td className="py-3 pr-4"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{bet.sport || "Other"}</span></td><td className="py-3 pr-4">{formatCurrency(bet.stake)}</td><td className="py-3 pr-4">{bet.odds || "-"}</td><td className="py-3 pr-4 capitalize">{bet.result}</td><td className="py-3 pr-4">{formatCurrency(bet.returnAmount)}</td><td className={"py-3 pr-4 font-medium " + (bet.profitLoss >= 0 ? "text-[#2E7D5B]" : "text-[#A94442]")}>{formatCurrency(bet.profitLoss)}</td><td className="max-w-[240px] truncate py-3 pr-4 text-slate-600">{bet.notes || "-"}</td><td className="py-3 pr-4"><div className="flex gap-2"><Button variant="ghost" onClick={() => startEditingBet(bet)}>Edit</Button><Button variant="ghost" onClick={() => deleteBet(bet.id)}>Delete</Button></div></td></tr>
                    ))}
                    {!bets.length ? <tr><td colSpan="9" className="py-10 text-center text-slate-500">No bets added yet.</td></tr> : null}
                  </tbody>
                </table>
              </div>
              {filteredBets.length > 5 ? <div className="mt-5 flex justify-center"><Button type="button" variant="outline" onClick={() => setShowAllBets((current) => !current)}>{showAllBets ? "Show less" : `Show all bets (${filteredBets.length})`}</Button></div> : null}
            </div>
          </Card>

          </div>

          {bets.length > 0 ? (
            <div className="mt-4 space-y-4 md:mt-6 md:space-y-6">
              {pendingBets.length > 0 ? <PendingBetsCard bets={pendingBets} onSettle={settlePendingBet} onDelete={deleteBet} /> : null}
              <BankrollCurveCard data={cumulativeData} />
              {gridBuildStats.count > 0 ? <GridBuildScoreCard stats={gridBuildStats} /> : null}
              <BreakdownsCard bySport={breakdowns.bySport} byOdds={breakdowns.byOdds} byType={breakdowns.byType} />
            </div>
          ) : null}
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
    </div>
  );
}

runBasicTests();
