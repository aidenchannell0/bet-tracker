import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
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
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value || 0));
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
    stake: Number(row.stake || 0),
    odds: Number(row.odds || 0),
    result: row.result,
    returnAmount: Number(row.return_amount || 0),
    profitLoss: Number(row.profit_loss || 0),
    notes: String(row.notes || ""),
    createdAt: row.created_at,
  };
}

function betToDatabaseRow(bet, userId) {
  return {
    user_id: userId,
    date: bet.date,
    stake: bet.stake,
    odds: bet.odds,
    result: bet.result,
    return_amount: bet.returnAmount,
    profit_loss: bet.profitLoss,
    notes: bet.notes,
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
    stake,
    odds: Number(source.odds || 0),
    result,
    returnAmount,
    profitLoss,
    notes: String(source.notes || ""),
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
  console.assert(databaseRowToBet({ id: "1", date: "2026-05-04", stake: 10, odds: 2, result: "win", return_amount: 20, profit_loss: 10 }).returnAmount === 20, "Database row mapping test failed");
  console.assert(csvCell('hello "mate"') === '"hello ""mate"""', "CSV escaping test failed");
  console.assert(["login", "signup", "reset"].includes("reset"), "Auth mode test failed");
  console.assert(typeof hasSupabaseKeys === "boolean", "Supabase key detection test failed");
  console.assert(typeof LandingPage === "function", "Landing page component test failed");
}

function Card({ children, className = "" }) {
  return <div className={"rounded-2xl border border-slate-200 bg-white shadow-sm " + className}>{children}</div>;
}

function Button({ children, className = "", variant = "primary", ...props }) {
  const base = "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "outline"
      ? "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100"
      : variant === "ghost"
      ? "bg-transparent text-slate-600 hover:bg-slate-100"
      : "bg-slate-950 text-white hover:bg-slate-800";
  return <button className={base + " " + styles + " " + className} {...props}>{children}</button>;
}

function Input({ className = "", ...props }) {
  return <input className={"w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 " + className} {...props} />;
}

function StatCard({ title, value, helper }) {
  return (
    <Card>
      <div className="p-5">
        <p className="text-sm text-slate-500">{title}</p>
        <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
        {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
      </div>
    </Card>
  );
}

function AuthScreen({ authMode, setAuthMode, email, setEmail, password, setPassword, loading, message, onSubmit, onResetPassword }) {
  return (
    <div className="min-h-screen bg-slate-50 p-4 text-slate-950 md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Online version</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Bet Tracker</h1>
            <p className="mt-2 text-sm text-slate-600">Create an account or log in to save your bets online and access them from any device.</p>
            {authMode === "reset" ? <p className="mt-2 text-sm text-slate-600">Enter your email and we will send you a password reset link.</p> : null}
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="space-y-1 text-sm font-medium">Email<Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label>
              {authMode !== "reset" ? <label className="space-y-1 text-sm font-medium">Password<Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Minimum 6 characters" required /></label> : null}
              {message ? <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div> : null}
              <Button type="submit" className="mt-3 w-full" disabled={loading}>{loading ? "Please wait..." : authMode === "login" ? "Log in" : authMode === "signup" ? "Sign up" : "Send reset link"}</Button>
            </form>
            {authMode === "login" ? <button type="button" onClick={onResetPassword} className="mt-3 w-full text-center text-sm font-medium text-slate-950 underline">Forgot password?</button> : null}
            <div className="mt-4 text-center text-sm text-slate-600">
              {authMode === "login" ? "Need an account? " : authMode === "signup" ? "Already have an account? " : "Remembered your password? "}
              <button type="button" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")} className="font-medium text-slate-950 underline">{authMode === "login" ? "Sign up" : "Log in"}</button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function PasswordRecoveryScreen({ newPassword, setNewPassword, loading, message, onSubmit }) {
  return (
    <div className="min-h-screen bg-slate-50 p-4 text-slate-950 md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Password reset</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Set a new password</h1>
            <p className="mt-2 text-sm text-slate-600">Enter a new password for your Bet Tracker account.</p>
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="space-y-1 text-sm font-medium">New password<Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Minimum 6 characters" required /></label>
              {message ? <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div> : null}
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
        <p>© {new Date().getFullYear()} Bet Tracker. Informational use only.</p>
        <div className="flex flex-wrap gap-4">
          <button onClick={() => setActivePage("disclaimer")} className="hover:text-slate-950">Disclaimer</button>
          <button onClick={() => setActivePage("responsible")} className="hover:text-slate-950">Responsible Gambling</button>
          <button onClick={() => setActivePage("privacy")} className="hover:text-slate-950">Privacy</button>
          <button onClick={() => setActivePage("terms")} className="hover:text-slate-950">Terms</button>
        </div>
      </div>
    </footer>
  );
}

function EdgeRiskMeter({ score }) {
  const riskColor = score <= 3 ? "bg-emerald-500" : score <= 6 ? "bg-orange-500" : "bg-red-500";
  const riskWidth = Math.max(10, score * 10) + "%";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-slate-700">Overall risk score</span><span className="font-semibold text-slate-950">{score}/10</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className={"h-full rounded-full " + riskColor} style={{ width: riskWidth }} /></div>
    </div>
  );
}

function EdgeSelectField({ label, value, options, onChange }) {
  return (
    <label className="space-y-1 text-sm font-medium">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200">
        {options.map((option) => <option key={option}>{option}</option>)}
      </select>
    </label>
  );
}

function EdgeMessage({ role, children }) {
  const isEdge = role === "edge";
  const text = String(children || "");

  const sectionLabels = ["Simple view", "Example structure", "What I would check", "Risk level", "Important"];

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

      sections.push({ label, content });
    });

    return sections;
  };

  const sections = isEdge ? parseSections(text) : [];

  if (!isEdge) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-line rounded-2xl bg-slate-950 px-4 py-3 text-sm leading-6 text-white">
          {children}
        </div>
      </div>
    );
  }

  if (!sections.length) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] whitespace-pre-line rounded-2xl bg-slate-100 px-4 py-3 text-sm leading-6 text-slate-800">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-3">
        {sections.map((section) => (
          <div key={section.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-800">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{section.label}</p>
            <p className="whitespace-pre-line">{section.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function EdgeDetailToggle({ leg }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm font-medium text-slate-800 hover:bg-slate-100"
      >
        <span>{open ? "Hide detailed form" : "Show detailed form"}</span>
        <span className="text-slate-500">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
          <div className="grid grid-cols-2 gap-2">
            {leg.details.map((item) => (
              <div key={item.label} className="rounded-lg bg-white p-3">
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className="mt-1 font-semibold text-slate-950">{item.value}</p>
              </div>
            ))}
          </div>
          <div>
            <p className="font-medium text-slate-900">Recent trend</p>
            <p className="mt-1 leading-6">{leg.trend}</p>
          </div>
          <div>
            <p className="font-medium text-slate-900">Why Edge included it</p>
            <p className="mt-1 leading-6">{leg.extraReason}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EdgePage({ setActivePage }) {
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
  const [chatMessages, setChatMessages] = useState([
    { role: "user", text: "Can you only use disposals in the multi?" },
    { role: "edge", text: "Yes. I rebuilt the example using disposals-only legs. In the live version, each leg will include exact supporting data such as recent hit rate, average and market availability." },
  ]);
  const displayedTargetOdds = targetOdds === "Custom" && customTargetOdds ? "$" + customTargetOdds : targetOdds;
  const displayedLegs = legs === "Custom" && customLegs ? customLegs : legs;
  const exampleLegs = [
    { name: "Player A 25+ disposals", confidence: "78%", reason: "Example data: cleared 25+ in 7 of the last 8 games, averaging 29.4 disposals across that span.", details: [{ label: "Last 8 hit rate", value: "7/8" }, { label: "Last 8 average", value: "29.4" }, { label: "Season average", value: "27.8" }, { label: "Lowest in last 8", value: "23" }, { label: "Highest in last 8", value: "36" }, { label: "Role note", value: "Primary mid" }], trend: "Recent disposal counts: 31, 28, 34, 26, 30, 23, 36, 27. He has only missed the 25+ line once in this sample.", extraReason: "This leg is included because the recent hit rate is strong, the average sits above the line, and the player role supports repeat disposal volume." },
    { name: "Player B 25+ disposals", confidence: "74%", reason: "Example data: cleared 25+ in 8 of the last 10 games, averaging 28.1 disposals across that span.", details: [{ label: "Last 10 hit rate", value: "8/10" }, { label: "Last 10 average", value: "28.1" }, { label: "Season average", value: "26.9" }, { label: "Lowest in last 10", value: "21" }, { label: "Highest in last 10", value: "35" }, { label: "Role note", value: "Inside/outside mid" }], trend: "Recent disposal counts: 29, 31, 27, 24, 30, 28, 35, 21, 26, 30. The two misses were close to the line rather than major role drops.", extraReason: "This leg is included because the player has shown a stable disposal floor and has cleared the selected line in most recent matches." },
    { name: "Player C 20+ disposals", confidence: "71%", reason: "Example data: cleared 20+ in 6 of the last 8 games, with a stable midfield role in recent matches.", details: [{ label: "Last 8 hit rate", value: "6/8" }, { label: "Last 8 average", value: "23.6" }, { label: "Season average", value: "22.4" }, { label: "Lowest in last 8", value: "17" }, { label: "Highest in last 8", value: "30" }, { label: "Role note", value: "Mid rotation" }], trend: "Recent disposal counts: 24, 22, 19, 26, 30, 17, 25, 23. This is a lower line, but the role is slightly less secure than the first two legs.", extraReason: "This leg is included because the lower line helps keep the overall multi near the target odds while still being supported by recent form." },
  ];
  const resetEdgeChat = () => {
    setChatMessages([
      {
        role: "edge",
        text: "Simple view:\n\nNew Edge chat started. Ask me for an example multi, a game analysis structure, or what data I would check before building a selection.\n\nExample structure:\n\nYou can ask things like: Build a 3-leg AFL example around $2.00 using disposals only.\n\nWhat I would check:\n\nI will explain the key data needed without pretending live stats are connected yet.\n\nRisk level:\n\nI can explain the risk on a 1 to 10 scale.\n\nImportant:\n\nThis is informational only, not betting advice.",
      },
    ]);
    setChatInput("");
  };

  const clearEdgeChat = () => {
    setChatMessages([]);
    setChatInput("");
  };

  const sendChatMessage = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || edgeLoading) return;

    const userMessage = { role: "user", text: trimmed };
    setChatMessages((current) => [...current, userMessage]);
    setChatInput("");
    setEdgeLoading(true);

    try {
      const response = await fetch("/api/edge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          context: {
            mode,
            sport,
            legs: displayedLegs,
            targetOdds: displayedTargetOdds,
            riskProfile,
            request,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Edge request failed");
      }

      setChatMessages((current) => [...current, { role: "edge", text: data.reply }]);
    } catch (error) {
      setChatMessages((current) => [
        ...current,
        {
          role: "edge",
          text: "Edge could not respond right now. Check that the backend API and OpenAI key are set up correctly, then try again.",
        },
      ]);
    } finally {
      setEdgeLoading(false);
    }
  };
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <main className="p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div><button onClick={() => setActivePage("app")} className="mb-3 text-sm font-medium text-slate-600 underline">← Back to dashboard</button><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-slate-500">AI analyst preview</p><span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-semibold text-white">Beta preview</span></div><h1 className="mt-2 text-4xl font-bold tracking-tight md:text-6xl">Edge</h1><p className="mt-2 max-w-2xl text-slate-600">A smarter way to explore example multis, game analysis and risk, built around clear data instead of vague tips.</p><div className="mt-4 max-w-3xl rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><span className="font-semibold">Important:</span> Edge is for informational analysis only. It is not betting advice, financial advice, or a guarantee of results. Do not place a bet based only on Edge. Always make your own decision, check current odds and team news, and gamble responsibly.</div></div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm"><span className="font-semibold text-slate-950">Preview mode</span><br />Live AI and sports data coming later</div>
          </header>
          <section className="grid gap-6 lg:grid-cols-[380px_1fr]">
            <Card><div className="p-5"><div className="grid gap-2 rounded-2xl bg-slate-100 p-1 sm:grid-cols-2"><button onClick={() => setMode("multi")} className={"rounded-xl px-4 py-3 text-sm font-semibold transition " + (mode === "multi" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950")}>Example Multi</button><button onClick={() => setMode("analysis")} className={"rounded-xl px-4 py-3 text-sm font-semibold transition " + (mode === "analysis" ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:text-slate-950")}>Game Analysis</button></div>
              {mode === "multi" ? <div className="mt-6 space-y-5"><EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NRL", "Soccer", "Basketball", "Cricket"]} /><EdgeSelectField label="Games" value="Tonight's games" onChange={() => {}} options={["Tonight's games", "Selected game only", "This weekend"]} /><EdgeSelectField label="Number of legs" value={legs} onChange={setLegs} options={["Any", "2", "3", "4", "5", "Custom"]} />{legs === "Custom" ? <label className="space-y-1 text-sm font-medium">Custom number of legs<Input type="number" min="1" step="1" value={customLegs} onChange={(event) => setCustomLegs(event.target.value)} placeholder="e.g. 6" /></label> : null}<EdgeSelectField label="Target odds" value={targetOdds} onChange={setTargetOdds} options={["$1.50", "$2.00", "$3.00", "$5.00", "Custom"]} />{targetOdds === "Custom" ? <label className="space-y-1 text-sm font-medium">Custom target odds<Input type="number" min="1" step="0.01" value={customTargetOdds} onChange={(event) => setCustomTargetOdds(event.target.value)} placeholder="e.g. 2.20" /></label> : null}<EdgeSelectField label="Risk profile" value={riskProfile} onChange={setRiskProfile} options={["Safer", "Balanced", "Aggressive"]} /><label className="space-y-1 text-sm font-medium">Optional request<Input value={request} onChange={(event) => setRequest(event.target.value)} placeholder="e.g. Disposals only, no same-game legs" /></label><div className="pt-2"><Button className="w-full rounded-2xl py-3 text-base">Preview example multi</Button></div></div> : <div className="mt-6 space-y-5"><EdgeSelectField label="Sport" value={sport} onChange={setSport} options={["AFL", "NRL", "Soccer", "Basketball", "Cricket"]} /><EdgeSelectField label="Game" value="Select upcoming game" onChange={() => {}} options={["Select upcoming game", "Team A vs Team B", "Team C vs Team D"]} /><label className="space-y-1 text-sm font-medium">Focus area<Input value="Recent form, injuries and head-to-head" readOnly /></label><Button className="w-full rounded-2xl py-3 text-base">Preview game analysis</Button></div>}
            </div></Card>
            <div className="space-y-6"><Card><div className="p-5 md:p-6"><div className="flex flex-col justify-between gap-3 md:flex-row md:items-start"><div><p className="text-sm font-medium text-slate-500">Edge output</p><h2 className="mt-1 text-2xl font-semibold">Example {displayedLegs}-leg {sport} multi</h2><p className="mt-2 text-sm text-slate-600">This is placeholder preview data only. The live version will use current odds, market availability and sport-specific statistics before producing outputs.</p></div><div className="rounded-2xl bg-slate-950 px-4 py-3 text-white"><p className="text-xs uppercase tracking-wide text-slate-300">Target odds</p><p className="text-2xl font-semibold">{displayedTargetOdds}</p></div></div><div className="mt-6 grid gap-4 md:grid-cols-3">{exampleLegs.map((leg, index) => <div key={leg.name} className="rounded-2xl border border-slate-200 p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Leg {index + 1}</p><h3 className="mt-1 font-semibold">{leg.name}</h3><p className="mt-2 text-sm text-slate-600">{leg.reason}</p><p className="mt-3 text-sm font-medium text-slate-950">Confidence: {leg.confidence}</p><EdgeDetailToggle leg={leg} /></div>)}</div><div className="mt-6 grid gap-4 md:grid-cols-[1fr_1.2fr]"><div className="rounded-2xl bg-slate-100 p-4"><EdgeRiskMeter score={6} /></div><div className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-700"><p className="font-medium text-slate-900">Why this risk score?</p><p className="mt-1">A 6/10 preview score reflects a balanced multi with multiple legs and player-market variance. The live version will calculate this from odds, markets, leg count and data confidence.</p></div></div><div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900"><span className="font-semibold">Not betting advice:</span> Edge does not provide betting advice, financial advice, guaranteed outcomes, or instructions to place a bet. Any multi shown here is only an example construction for informational purposes. Odds, markets, injuries and team news may change. You are responsible for your own decisions. Gamble responsibly.</div></div></Card><Card><div className="p-5 md:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><p className="text-sm font-medium text-slate-500">Chat with Edge</p><h2 className="text-xl font-semibold">Refine the build naturally</h2></div><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={resetEdgeChat}>New chat</Button><Button type="button" variant="ghost" onClick={clearEdgeChat}>Clear chat</Button><span className="rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white">Preview mode</span></div></div><div className="mt-5 space-y-3">{chatMessages.map((message, index) => <EdgeMessage key={index} role={message.role}>{message.text}</EdgeMessage>)}</div><div className="mt-5 flex flex-col gap-2 sm:flex-row"><Input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask Edge a follow-up..." onKeyDown={(event) => { if (event.key === "Enter") sendChatMessage(); }} disabled={edgeLoading} /><Button onClick={sendChatMessage} className="sm:px-6" disabled={edgeLoading}>{edgeLoading ? "Thinking..." : "Send"}</Button></div></div></Card></div>
          </section>
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
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <main className="p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-10">
          <header className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><p className="text-sm font-medium text-slate-500">Bet Tracker</p><h1 className="text-3xl font-bold tracking-tight md:text-5xl">Track every bet. Understand every result.</h1></div><div className="flex gap-2"><Button variant="outline" onClick={() => openAuth("login")}>Log in</Button><Button onClick={() => openAuth("signup")}>Sign up</Button></div></header>
          <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center"><div className="space-y-6"><div><h2 className="text-4xl font-bold tracking-tight md:text-6xl">Know if you are actually winning.</h2><p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">Bet Tracker helps you record every bet, review your profit and loss, monitor your win rate, and understand your performance over time.</p></div><div className="flex flex-col gap-3 sm:flex-row"><Button onClick={() => openAuth("signup")} className="w-full sm:w-auto">Start tracking</Button><Button variant="outline" onClick={() => openAuth("login")} className="w-full sm:w-auto">I already have an account</Button></div><p className="text-sm text-slate-500">Built for tracking and informational use. Bet Tracker does not accept bets or guarantee outcomes.</p></div><Card><div className="p-5 md:p-6"><p className="text-sm font-medium text-slate-500">Dashboard preview</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">Total Profit/Loss</p><p className="mt-1 text-2xl font-semibold text-emerald-700">+$246.50</p></div><div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">Win Rate</p><p className="mt-1 text-2xl font-semibold">58.3%</p></div><div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">ROI</p><p className="mt-1 text-2xl font-semibold">12.8%</p></div><div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">Longest Win Streak</p><p className="mt-1 text-2xl font-semibold">5 bets</p></div></div><div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="mb-3 flex items-center justify-between text-sm"><span className="font-medium">Weekly profit/loss</span><span className="text-slate-500">Example</span></div><div className="flex h-32 items-end gap-3"><div className="h-16 flex-1 rounded-t-xl bg-slate-300" /><div className="h-24 flex-1 rounded-t-xl bg-slate-900" /><div className="h-10 flex-1 rounded-t-xl bg-slate-300" /><div className="h-28 flex-1 rounded-t-xl bg-slate-900" /><div className="h-20 flex-1 rounded-t-xl bg-slate-300" /></div></div></div></Card></section>
          <section className="grid gap-4 md:grid-cols-3"><Card><div className="p-5"><h3 className="text-lg font-semibold">Track every bet</h3><p className="mt-2 text-sm leading-6 text-slate-600">Record stakes, odds, returns, results and notes so your betting history is easy to review.</p></div></Card><Card><div className="p-5"><h3 className="text-lg font-semibold">Understand performance</h3><p className="mt-2 text-sm leading-6 text-slate-600">See profit/loss, ROI, win rate, streaks and weekly, monthly or yearly trends.</p></div></Card><Card><div className="p-5"><h3 className="text-lg font-semibold">Edge is coming</h3><p className="mt-2 text-sm leading-6 text-slate-600">Soon, Edge will help users explore data-backed game analysis and example bet constructions.</p><button onClick={() => openAuth("signup")} className="mt-3 text-sm font-medium text-slate-950 underline">Join to preview Edge</button></div></Card></section>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
    </div>
  );
}

function SettingsPage({ setActivePage, bets, exportCsv, exportBackup, clearAllBets, fileInputRef, importBackup }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <main className="p-4 md:p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <button onClick={() => setActivePage("app")} className="text-sm font-medium text-slate-600 underline">← Back to dashboard</button>
          <Card>
            <div className="p-6 md:p-8">
              <p className="text-sm font-medium text-slate-500">Bet Tracker</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">Settings</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">Manage exports, backups and account-level bet data actions.</p>

              <div className="mt-6 space-y-5">
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
                  <p className="mt-1 text-sm leading-6 text-slate-600">Import a Bet Tracker JSON backup. Imported bets will be added to your online account.</p>
                  <div className="mt-4">
                    <Button onClick={() => fileInputRef.current && fileInputRef.current.click()} variant="outline">Import Backup</Button>
                    <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importBackup} className="hidden" />
                  </div>
                </div>

                <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
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

function LegalPage({ page, setActivePage }) {
  const content = {
    disclaimer: { title: "Disclaimer", body: ["Bet Tracker is designed to help users record, review and understand their own betting activity. The information shown in the app is for general informational and tracking purposes only.", "Nothing in Bet Tracker should be treated as financial advice, betting advice, a guarantee of results or an instruction to place a bet. Betting involves risk, and users are responsible for their own decisions.", "Statistics, graphs and future AI-generated analysis may contain errors, omissions or outdated information. Always check information independently before relying on it."] },
    responsible: { title: "Responsible Gambling", body: ["Bet Tracker is intended to support awareness and accountability. If betting stops being fun, causes stress, or affects your finances, relationships, study or work, consider taking a break and seeking support.", "Set limits before you bet, never bet more than you can afford to lose, and do not chase losses. Tracking losses clearly is one of the reasons this app exists.", "If you are in Australia and need support, consider contacting Gambling Help Online or your local gambling support service. If you are outside Australia, contact the relevant support service in your country."] },
    privacy: { title: "Privacy Policy", body: ["Bet Tracker stores account and bet-tracking information so users can access their data across devices. This may include email address, bet dates, stakes, returns, results, notes and related performance statistics.", "Bet Tracker does not need users to enter bookmaker account details or payment card details to use the core tracking features. Do not enter sensitive personal information into the notes field.", "Data is stored using third-party infrastructure providers such as Supabase and Vercel. As the product develops, this policy should be reviewed and replaced with a full legal privacy policy before wider public marketing."] },
    terms: { title: "Terms of Use", body: ["By using Bet Tracker, you agree to use it for lawful personal tracking and informational purposes only. You are responsible for the accuracy of the information you enter.", "Bet Tracker does not accept bets, process wagers, provide bookmaker services or guarantee betting outcomes. Any betting decisions are made entirely by the user.", "The app may change, experience downtime, or contain errors while it is being developed. These terms are a working draft and should be reviewed by a qualified lawyer before commercial launch."] },
  };
  const selected = content[page] || content.disclaimer;
  return <div className="min-h-screen bg-slate-50 p-4 text-slate-950 md:p-8"><div className="mx-auto max-w-3xl space-y-6"><button onClick={() => setActivePage("app")} className="text-sm font-medium text-slate-600 underline">← Back to dashboard</button><Card><div className="p-6 md:p-8"><p className="text-sm font-medium text-slate-500">Bet Tracker</p><h1 className="mt-1 text-3xl font-bold tracking-tight">{selected.title}</h1><div className="mt-6 space-y-4 text-sm leading-7 text-slate-700">{selected.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div><div className="mt-6 rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">This page is a working draft for an early-stage product and is not a substitute for legal advice.</div></div></Card></div></div>;
}

export default function BettingTrackerWebsite() {
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
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const [chartView, setChartView] = useState("weekly");
  const [form, setForm] = useState({ date: todayString(), stake: "", odds: "", result: "win", returnAmount: "", notes: "" });

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

  const stats = useMemo(() => {
    const totalStaked = bets.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    const totalReturned = bets.reduce((sum, bet) => sum + Number(bet.returnAmount || 0), 0);
    const totalProfit = bets.reduce((sum, bet) => sum + Number(bet.profitLoss || 0), 0);
    const completedBets = bets.filter((bet) => bet.result === "win" || bet.result === "loss");
    const wins = bets.filter((bet) => bet.result === "win").length;
    const losses = bets.filter((bet) => bet.result === "loss").length;
    const winRate = completedBets.length ? (wins / completedBets.length) * 100 : 0;
    const roi = totalStaked ? (totalProfit / totalStaked) * 100 : 0;
    const biggestWin = bets.length ? Math.max(...bets.map((bet) => Number(bet.profitLoss || 0))) : 0;
    const biggestLoss = bets.length ? Math.min(...bets.map((bet) => Number(bet.profitLoss || 0))) : 0;
    let currentLosingStreak = 0;
    let longestLosingStreak = 0;
    let currentWinningStreak = 0;
    let longestWinningStreak = 0;
    [...bets].sort((a, b) => (parseBetDate(a.date)?.getTime() || 0) - (parseBetDate(b.date)?.getTime() || 0)).forEach((bet) => {
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
  }, [bets]);

  const chartData = useMemo(() => {
    const grouped = bets.reduce((acc, bet) => {
      const periodInfo = getPeriodInfo(bet.date, chartView);
      if (!acc[periodInfo.key]) acc[periodInfo.key] = { sortKey: periodInfo.key, label: periodInfo.label, profitLoss: 0 };
      acc[periodInfo.key].profitLoss += Number(bet.profitLoss || 0);
      return acc;
    }, {});
    return Object.values(grouped).map((item) => ({ ...item, profitLoss: Number(item.profitLoss.toFixed(2)) })).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [bets, chartView]);

  const chartTitle = chartView === "monthly" ? "Monthly profit/loss" : chartView === "yearly" ? "Yearly profit/loss" : "Weekly profit/loss";
  const chartDescription = chartView === "monthly" ? "Grouped by the month of each bet." : chartView === "yearly" ? "Grouped by the year of each bet." : "Grouped by Monday to Sunday week ranges.";
  const xAxisLabel = chartView === "weekly" ? "Week Range" : chartView === "monthly" ? "Month" : "Year";

  const resetBetForm = () => {
    setEditingBetId(null);
    setForm({ date: todayString(), stake: "", odds: "", result: "win", returnAmount: "", notes: "" });
  };

  const startEditingBet = (bet) => {
    setEditingBetId(bet.id);
    setForm({ date: bet.date, stake: String(bet.stake || ""), odds: String(bet.odds || ""), result: bet.result, returnAmount: String(bet.returnAmount || ""), notes: bet.notes || "" });
    setMessage("Editing bet from " + bet.date + ". Make changes and click Update Bet.");
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const handleAddOrUpdateBet = async (event) => {
    event.preventDefault();
    if (!supabase || !session?.user?.id) return;
    const stakeNum = Number(form.stake);
    const oddsNum = Number(form.odds || 0);
    const returnNum = form.result === "loss" ? 0 : Number(form.returnAmount || 0);
    if (!form.date || !stakeNum || stakeNum <= 0) return;
    const betPayload = normaliseBet({ date: form.date, stake: stakeNum, odds: oddsNum, result: form.result, returnAmount: returnNum, profitLoss: calculateProfitLoss(form.result, stakeNum, returnNum), notes: form.notes.trim() });
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

  const clearAllBets = async () => {
    const confirmed = window.confirm("Are you sure you want to delete all saved bets?");
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
    const headers = ["Date", "Stake", "Odds", "Result", "Return", "Profit/Loss", "Notes"];
    const rows = bets.map((bet) => [csvCell(bet.date), csvCell(bet.stake), csvCell(bet.odds), csvCell(bet.result), csvCell(bet.returnAmount), csvCell(bet.profitLoss), csvCell(bet.notes)]);
    const csv = [headers.map(csvCell), ...rows].map((row) => row.join(",")).join("\n");
    downloadFile(csv, "bet-tracker.csv", "text/csv;charset=utf-8;");
  };

  const exportBackup = () => {
    downloadFile(JSON.stringify({ app: "Bet Tracker", version: 2, exportedAt: new Date().toISOString(), bets }, null, 2), "bet-tracker-backup.json", "application/json;charset=utf-8;");
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
        window.alert("Could not import that backup file. Make sure it is a Bet Tracker JSON backup.");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  };

  const sortedBets = [...bets].sort((a, b) => {
    const dateA = parseBetDate(a.date)?.getTime() || 0;
    const dateB = parseBetDate(b.date)?.getTime() || 0;
    if (dateB !== dateA) return dateB - dateA;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
  const visibleBets = showAllBets ? sortedBets : sortedBets.slice(0, 5);

  const riskWarning = stats.totalProfit < 0 && stats.longestLosingStreak >= 3;

  if (!hasSupabaseKeys) return <div className="min-h-screen bg-slate-50 p-8 text-slate-950"><Card className="mx-auto max-w-xl"><div className="p-6"><h1 className="text-2xl font-bold">Supabase keys missing</h1><p className="mt-2 text-sm text-slate-600">Check your .env file and make sure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. Restart Vite after saving .env.</p></div></Card></div>;
  if (["disclaimer", "responsible", "privacy", "terms"].includes(activePage)) return <LegalPage page={activePage} setActivePage={setActivePage} />;
  if (activePage === "edge" && session) return <EdgePage setActivePage={setActivePage} />;
  if (activePage === "settings" && session) return <SettingsPage setActivePage={setActivePage} bets={bets} exportCsv={exportCsv} exportBackup={exportBackup} clearAllBets={clearAllBets} fileInputRef={fileInputRef} importBackup={importBackup} />;
  if (recoveryMode) return <PasswordRecoveryScreen newPassword={newPassword} setNewPassword={setNewPassword} loading={authLoading} message={message} onSubmit={handleUpdatePassword} />;
  if (!session && activePage !== "auth") return <LandingPage setActivePage={setActivePage} setAuthMode={setAuthMode} />;
  if (!session) return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} loading={authLoading} message={message} onSubmit={handleAuthSubmit} onResetPassword={handlePasswordResetRequest} />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <main className="p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="text-sm font-medium text-slate-500">Online account version</p><h1 className="text-3xl font-bold tracking-tight md:text-5xl">Bet Tracker</h1><p className="mt-2 max-w-2xl text-slate-600">Track stakes, returns, profit/loss, win rate, ROI and weekly performance. Your data is saved online with Supabase.</p><p className="mt-1 text-sm text-slate-500">Logged in as {session.user.email}</p></div><div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap"><Button onClick={() => setActivePage("edge")} className="col-span-2 w-full rounded-2xl px-6 py-4 text-base font-semibold shadow-lg shadow-slate-300 sm:col-span-1 sm:w-auto">Ask Edge</Button><Button onClick={() => setActivePage("settings")} variant="outline" className="w-full sm:w-auto">Settings</Button><Button onClick={handleLogout} variant="outline" className="col-span-2 w-full sm:col-span-1 sm:w-auto">Log out</Button></div></header>
          {message ? <Card><div className="p-4 text-sm text-slate-700">{message}</div></Card> : null}{loadingBets ? <Card><div className="p-4 text-sm text-slate-700">Loading your saved bets...</div></Card> : null}{riskWarning ? <Card className="border-red-200 bg-red-50"><div className="p-4 text-sm text-red-800">Warning: you are currently down overall and have had a losing streak of {stats.longestLosingStreak} bets. Consider reducing stake size or taking a break.</div></Card> : null}
          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"><StatCard title="Total Profit/Loss" value={formatCurrency(stats.totalProfit)} helper="Overall betting result" /><StatCard title="Win Rate" value={stats.winRate.toFixed(1) + "%"} helper={stats.wins + " wins, " + stats.losses + " losses"} /><StatCard title="ROI" value={stats.roi.toFixed(1) + "%"} helper="Profit compared to total staked" /><StatCard title="Total Staked" value={formatCurrency(stats.totalStaked)} helper={"Returned: " + formatCurrency(stats.totalReturned)} /></section>
          <section className="grid gap-6 lg:grid-cols-5"><Card className="lg:col-span-2"><div ref={formRef} className="p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{editingBetId ? "Edit bet" : "Add a bet"}</h2>{editingBetId ? <p className="mt-1 text-sm text-slate-500">Update the details below, then save your changes.</p> : null}</div>{editingBetId ? <Button type="button" variant="outline" onClick={resetBetForm}>Cancel</Button> : null}</div><form onSubmit={handleAddOrUpdateBet} className="mt-5 space-y-4"><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Date<Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label><label className="space-y-1 text-sm font-medium">Result<select value={form.result} onChange={(event) => setForm({ ...form, result: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="win">Win</option><option value="loss">Loss</option><option value="void">Void</option></select></label></div><div className="grid gap-4 sm:grid-cols-3"><label className="space-y-1 text-sm font-medium">Stake<Input type="number" min="0" step="0.01" placeholder="50" value={form.stake} onChange={(event) => setForm({ ...form, stake: event.target.value })} /></label><label className="space-y-1 text-sm font-medium">Odds<Input type="number" min="0" step="0.01" placeholder="2.00" value={form.odds} onChange={(event) => setForm({ ...form, odds: event.target.value })} /></label><label className="space-y-1 text-sm font-medium">Return<Input type="number" min="0" step="0.01" placeholder="100" value={form.returnAmount} onChange={(event) => setForm({ ...form, returnAmount: event.target.value })} disabled={form.result === "loss"} /></label></div><label className="space-y-1 text-sm font-medium">Notes<Input placeholder="Optional note" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label><div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">Estimated profit/loss: {formatCurrency(calculateProfitLoss(form.result, form.stake, form.result === "loss" ? 0 : form.returnAmount))}</div><Button type="submit" className="w-full">{editingBetId ? "Update Bet" : "Add Bet"}</Button></form></div></Card><Card className="lg:col-span-3"><div className="p-5"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><h2 className="text-xl font-semibold">{chartTitle}</h2><p className="text-sm text-slate-500">{chartDescription}</p></div><select value={chartView} onChange={(event) => setChartView(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></div><div className="mt-4 h-80">{chartData.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 30 }}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" label={{ value: xAxisLabel, position: "insideBottom", offset: -10 }} /><YAxis label={{ value: "Profit/Loss ($AUD)", angle: -90, position: "insideLeft", offset: -5 }} /><Tooltip formatter={(value) => formatCurrency(value)} /><Bar dataKey="profitLoss" radius={[10, 10, 0, 0]} /></BarChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center rounded-2xl bg-slate-100 text-sm text-slate-500">Add your first bet to see the graph.</div>}</div></div></Card></section>
          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"><StatCard title="Biggest Win" value={formatCurrency(stats.biggestWin)} /><StatCard title="Biggest Loss" value={formatCurrency(stats.biggestLoss)} /><StatCard title="Longest Winning Streak" value={String(stats.longestWinningStreak) + " bets"} /><StatCard title="Longest Losing Streak" value={String(stats.longestLosingStreak) + " bets"} /></section>
          <Card><div className="p-5"><div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><h2 className="text-xl font-semibold">Bet history</h2><p className="text-sm text-slate-500">Edit or delete entries if you make a mistake.</p></div><p className="text-sm text-slate-500">Showing {visibleBets.length} of {bets.length} bets</p></div><div className="mt-4 space-y-3 md:hidden">{visibleBets.map((bet) => <div key={bet.id} className={"rounded-2xl border border-slate-200 p-4 " + (editingBetId === bet.id ? "bg-slate-50" : "bg-white")}><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-950">{bet.date}</p><p className="mt-1 text-xs capitalize text-slate-500">{bet.result} · Odds {bet.odds || "-"}</p></div><p className={"text-base font-semibold " + (bet.profitLoss >= 0 ? "text-emerald-700" : "text-red-700")}>{formatCurrency(bet.profitLoss)}</p></div><div className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-slate-100 p-3"><p className="text-xs text-slate-500">Stake</p><p className="font-medium text-slate-950">{formatCurrency(bet.stake)}</p></div><div className="rounded-xl bg-slate-100 p-3"><p className="text-xs text-slate-500">Return</p><p className="font-medium text-slate-950">{formatCurrency(bet.returnAmount)}</p></div></div>{bet.notes ? <p className="mt-3 text-sm text-slate-600">{bet.notes}</p> : null}<div className="mt-4 grid grid-cols-2 gap-2"><Button variant="outline" onClick={() => startEditingBet(bet)} className="w-full">Edit</Button><Button variant="ghost" onClick={() => deleteBet(bet.id)} className="w-full">Delete</Button></div></div>)}{!bets.length ? <div className="rounded-2xl bg-slate-100 p-8 text-center text-sm text-slate-500">No bets added yet.</div> : null}</div><div className="mt-4 hidden overflow-x-auto md:block"><table className="w-full min-w-[820px] text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="py-3 pr-4 font-medium">Date</th><th className="py-3 pr-4 font-medium">Stake</th><th className="py-3 pr-4 font-medium">Odds</th><th className="py-3 pr-4 font-medium">Result</th><th className="py-3 pr-4 font-medium">Return</th><th className="py-3 pr-4 font-medium">Profit/Loss</th><th className="py-3 pr-4 font-medium">Notes</th><th className="py-3 pr-4 font-medium">Actions</th></tr></thead><tbody>{visibleBets.map((bet) => <tr key={bet.id} className={"border-b last:border-0 " + (editingBetId === bet.id ? "bg-slate-50" : "")}><td className="py-3 pr-4">{bet.date}</td><td className="py-3 pr-4">{formatCurrency(bet.stake)}</td><td className="py-3 pr-4">{bet.odds || "-"}</td><td className="py-3 pr-4 capitalize">{bet.result}</td><td className="py-3 pr-4">{formatCurrency(bet.returnAmount)}</td><td className={"py-3 pr-4 font-medium " + (bet.profitLoss >= 0 ? "text-emerald-700" : "text-red-700")}>{formatCurrency(bet.profitLoss)}</td><td className="max-w-[240px] truncate py-3 pr-4 text-slate-600">{bet.notes || "-"}</td><td className="py-3 pr-4"><div className="flex gap-2"><Button variant="ghost" onClick={() => startEditingBet(bet)}>Edit</Button><Button variant="ghost" onClick={() => deleteBet(bet.id)}>Delete</Button></div></td></tr>)}{!bets.length ? <tr><td colSpan="8" className="py-10 text-center text-slate-500">No bets added yet.</td></tr> : null}</tbody></table></div>{bets.length > 5 ? <div className="mt-5 flex justify-center"><Button type="button" variant="outline" onClick={() => setShowAllBets((current) => !current)}>{showAllBets ? "Show less" : `Show all bets (${bets.length})`}</Button></div> : null}</div></Card>
        </div>
      </main>
      <Footer setActivePage={setActivePage} />
      <Analytics />
    </div>
  );
}

runBasicTests();
