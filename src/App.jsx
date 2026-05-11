import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

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
}

runBasicTests();

function Card({ children, className = "" }) {
  return <div className={"rounded-2xl border border-slate-200 bg-white shadow-sm " + className}>{children}</div>;
}

function Button({ children, className = "", variant = "primary", ...props }) {
  const base = "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles = variant === "outline" ? "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100" : variant === "ghost" ? "bg-transparent text-slate-600 hover:bg-slate-100" : "bg-slate-950 text-white hover:bg-slate-800";
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

              {message ? <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div> : null}

              <Button type="submit" className="mt-3 w-full" disabled={loading}>
                {loading ? "Please wait..." : authMode === "login" ? "Log in" : authMode === "signup" ? "Sign up" : "Send reset link"}
              </Button>
            </form>

            {authMode === "login" ? (
              <button type="button" onClick={onResetPassword} className="mt-3 w-full text-center text-sm font-medium text-slate-950 underline">Forgot password?</button>
            ) : null}

            <div className="mt-4 text-center text-sm text-slate-600">
              {authMode === "login" ? "Need an account? " : authMode === "signup" ? "Already have an account? " : "Remembered your password? "}
              <button type="button" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")} className="font-medium text-slate-950 underline">
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
    <div className="min-h-screen bg-slate-50 p-4 text-slate-950 md:p-8">
      <div className="mx-auto flex min-h-[80vh] max-w-xl items-center justify-center">
        <Card className="w-full">
          <div className="p-6 md:p-8">
            <p className="text-sm font-medium text-slate-500">Password reset</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Set a new password</h1>
            <p className="mt-2 text-sm text-slate-600">Enter a new password for your Bet Tracker account.</p>
            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="space-y-1 text-sm font-medium">
                New password
                <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Minimum 6 characters" required />
              </label>
              {message ? <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{message}</div> : null}
              <Button type="submit" className="mt-3 w-full" disabled={loading}>{loading ? "Updating..." : "Update password"}</Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
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
  const [bets, setBets] = useState([]);
  const [loadingBets, setLoadingBets] = useState(false);
  const [editingBetId, setEditingBetId] = useState(null);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const [chartView, setChartView] = useState("weekly");
  const emptyForm = { date: todayString(), stake: "", odds: "", result: "win", returnAmount: "", notes: "" };
  const [form, setForm] = useState(emptyForm);

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
    setForm({
      date: bet.date,
      stake: String(bet.stake || ""),
      odds: String(bet.odds || ""),
      result: bet.result,
      returnAmount: String(bet.returnAmount || ""),
      notes: bet.notes || "",
    });
    setMessage("Editing bet from " + bet.date + ". Make changes and click Update Bet.");
    window.setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  const handleAddOrUpdateBet = async (event) => {
    event.preventDefault();
    if (!supabase || !session?.user?.id) return;
    const stakeNum = Number(form.stake);
    const oddsNum = Number(form.odds || 0);
    const returnNum = form.result === "loss" ? 0 : Number(form.returnAmount || 0);
    if (!form.date || !stakeNum || stakeNum <= 0) return;

    const betPayload = normaliseBet({
      date: form.date,
      stake: stakeNum,
      odds: oddsNum,
      result: form.result,
      returnAmount: returnNum,
      profitLoss: calculateProfitLoss(form.result, stakeNum, returnNum),
      notes: form.notes.trim(),
    });

    if (editingBetId) {
      const { data, error } = await supabase
        .from("bets")
        .update(betToDatabaseRow(betPayload, session.user.id))
        .eq("id", editingBetId)
        .eq("user_id", session.user.id)
        .select()
        .single();

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

  const riskWarning = stats.totalProfit < 0 && stats.longestLosingStreak >= 3;

  if (!hasSupabaseKeys) {
    return (
      <div className="min-h-screen bg-slate-50 p-8 text-slate-950">
        <Card className="mx-auto max-w-xl">
          <div className="p-6">
            <h1 className="text-2xl font-bold">Supabase keys missing</h1>
            <p className="mt-2 text-sm text-slate-600">Check your .env file and make sure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. Restart Vite after saving .env.</p>
          </div>
        </Card>
      </div>
    );
  }

  if (recoveryMode) {
    return <PasswordRecoveryScreen newPassword={newPassword} setNewPassword={setNewPassword} loading={authLoading} message={message} onSubmit={handleUpdatePassword} />;
  }

  if (!session) {
    return <AuthScreen authMode={authMode} setAuthMode={setAuthMode} email={email} setEmail={setEmail} password={password} setPassword={setPassword} loading={authLoading} message={message} onSubmit={handleAuthSubmit} onResetPassword={handlePasswordResetRequest} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 text-slate-950 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-sm font-medium text-slate-500">Online account version</p>
            <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Bet Tracker</h1>
            <p className="mt-2 max-w-2xl text-slate-600">Track stakes, returns, profit/loss, win rate, ROI and weekly performance. Your data is saved online with Supabase.</p>
            <p className="mt-1 text-sm text-slate-500">Logged in as {session.user.email}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={exportCsv} variant="outline" disabled={!bets.length}>Export CSV</Button>
            <Button onClick={exportBackup} variant="outline" disabled={!bets.length}>Export Backup</Button>
            <Button onClick={() => fileInputRef.current && fileInputRef.current.click()} variant="outline">Import Backup</Button>
            <Button onClick={clearAllBets} variant="outline" disabled={!bets.length}>Clear All</Button>
            <Button onClick={handleLogout} variant="outline">Log out</Button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={importBackup} className="hidden" />
          </div>
        </header>

        {message ? <Card><div className="p-4 text-sm text-slate-700">{message}</div></Card> : null}
        {loadingBets ? <Card><div className="p-4 text-sm text-slate-700">Loading your saved bets...</div></Card> : null}
        {riskWarning ? <Card className="border-red-200 bg-red-50"><div className="p-4 text-sm text-red-800">Warning: you are currently down overall and have had a losing streak of {stats.longestLosingStreak} bets. Consider reducing stake size or taking a break.</div></Card> : null}

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Total Profit/Loss" value={formatCurrency(stats.totalProfit)} helper="Overall betting result" />
          <StatCard title="Win Rate" value={stats.winRate.toFixed(1) + "%"} helper={stats.wins + " wins, " + stats.losses + " losses"} />
          <StatCard title="ROI" value={stats.roi.toFixed(1) + "%"} helper="Profit compared to total staked" />
          <StatCard title="Total Staked" value={formatCurrency(stats.totalStaked)} helper={"Returned: " + formatCurrency(stats.totalReturned)} />
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
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1 text-sm font-medium">Date<Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Result<select value={form.result} onChange={(event) => setForm({ ...form, result: event.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="win">Win</option><option value="loss">Loss</option><option value="void">Void</option></select></label>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <label className="space-y-1 text-sm font-medium">Stake<Input type="number" min="0" step="0.01" placeholder="50" value={form.stake} onChange={(event) => setForm({ ...form, stake: event.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Odds<Input type="number" min="0" step="0.01" placeholder="2.00" value={form.odds} onChange={(event) => setForm({ ...form, odds: event.target.value })} /></label>
                  <label className="space-y-1 text-sm font-medium">Return<Input type="number" min="0" step="0.01" placeholder="100" value={form.returnAmount} onChange={(event) => setForm({ ...form, returnAmount: event.target.value })} disabled={form.result === "loss"} /></label>
                </div>
                <label className="space-y-1 text-sm font-medium">Notes<Input placeholder="Optional note" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
                <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">Estimated profit/loss: {formatCurrency(calculateProfitLoss(form.result, form.stake, form.result === "loss" ? 0 : form.returnAmount))}</div>
                <Button type="submit" className="w-full">{editingBetId ? "Update Bet" : "Add Bet"}</Button>
              </form>
            </div>
          </Card>

          <Card className="lg:col-span-3">
            <div className="p-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div><h2 className="text-xl font-semibold">{chartTitle}</h2><p className="text-sm text-slate-500">{chartDescription}</p></div>
                <select value={chartView} onChange={(event) => setChartView(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-200"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
              </div>
              <div className="mt-4 h-80">
                {chartData.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 10, right: 20, left: 20, bottom: 30 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" label={{ value: xAxisLabel, position: "insideBottom", offset: -10 }} />
                      <YAxis label={{ value: "Profit/Loss ($AUD)", angle: -90, position: "insideLeft", offset: -5 }} />
                      <Tooltip formatter={(value) => formatCurrency(value)} />
                      <Bar dataKey="profitLoss" radius={[10, 10, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <div className="flex h-full items-center justify-center rounded-2xl bg-slate-100 text-sm text-slate-500">Add your first bet to see the graph.</div>}
              </div>
            </div>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Biggest Win" value={formatCurrency(stats.biggestWin)} />
          <StatCard title="Biggest Loss" value={formatCurrency(stats.biggestLoss)} />
          <StatCard title="Longest Winning Streak" value={String(stats.longestWinningStreak) + " bets"} />
          <StatCard title="Longest Losing Streak" value={String(stats.longestLosingStreak) + " bets"} />
        </section>

        <Card>
          <div className="p-5">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><h2 className="text-xl font-semibold">Bet history</h2><p className="text-sm text-slate-500">Edit or delete entries if you make a mistake.</p></div><p className="text-sm text-slate-500">{bets.length} total bets</p></div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead><tr className="border-b text-slate-500"><th className="py-3 pr-4 font-medium">Date</th><th className="py-3 pr-4 font-medium">Stake</th><th className="py-3 pr-4 font-medium">Odds</th><th className="py-3 pr-4 font-medium">Result</th><th className="py-3 pr-4 font-medium">Return</th><th className="py-3 pr-4 font-medium">Profit/Loss</th><th className="py-3 pr-4 font-medium">Notes</th><th className="py-3 pr-4 font-medium">Actions</th></tr></thead>
                <tbody>
                  {bets.map((bet) => (
                    <tr key={bet.id} className={"border-b last:border-0 " + (editingBetId === bet.id ? "bg-slate-50" : "")}><td className="py-3 pr-4">{bet.date}</td><td className="py-3 pr-4">{formatCurrency(bet.stake)}</td><td className="py-3 pr-4">{bet.odds || "-"}</td><td className="py-3 pr-4 capitalize">{bet.result}</td><td className="py-3 pr-4">{formatCurrency(bet.returnAmount)}</td><td className={"py-3 pr-4 font-medium " + (bet.profitLoss >= 0 ? "text-emerald-700" : "text-red-700")}>{formatCurrency(bet.profitLoss)}</td><td className="max-w-[240px] truncate py-3 pr-4 text-slate-600">{bet.notes || "-"}</td><td className="py-3 pr-4"><div className="flex gap-2"><Button variant="ghost" onClick={() => startEditingBet(bet)}>Edit</Button><Button variant="ghost" onClick={() => deleteBet(bet.id)}>Delete</Button></div></td></tr>
                  ))}
                  {!bets.length ? <tr><td colSpan="8" className="py-10 text-center text-slate-500">No bets added yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
