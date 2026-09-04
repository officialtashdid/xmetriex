"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  GraduationCap,
  Shield,
  Mail,
  Key,
  Eye,
  EyeOff,
  Loader2,
  ArrowLeft,
  Lock,
  Sparkles
} from "lucide-react";
import { supabase } from "@/lib/supabase";

/**
 * শিক্ষক/অ্যাডমিন প্যানেলের লগইন ল্যান্ডিং পেজ (/admin)।
 * ইমেইল+পাসওয়ার্ড (Supabase Authentication) — সফল হলে সার্ভার-সাইড
 * verifyTeacherSession দিয়ে নিশ্চিত হয়ে প্যানেল রিলোড হয়।
 */
export const AdminLogin: React.FC = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [infoMsg, setInfoMsg] = useState("");

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setInfoMsg("");
    setIsLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      // SECURITY: verify server-side that this account is actually a teacher
      const { verifyTeacherSession } = await import("@/actions/admin-actions");
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const verified = await verifyTeacherSession(session?.access_token);
      if (!verified.ok) {
        await supabase.auth.signOut();
        throw new Error("এই অ্যাকাউন্টে শিক্ষক প্যানেলের অনুমতি নেই।");
      }

      sessionStorage.setItem(
        "teacher_user",
        JSON.stringify({ email: verified.email || data.user?.email || "শিক্ষক", role: "admin" })
      );
      // সেশন-কুকি সিঙ্ক হয়ে নতুন করে যাচাই হোক — প্যানেল খুলবে
      window.location.reload();
    } catch (err: any) {
      setErrorMsg(err.message || "অথেনটিকেশনে সমস্যা হয়েছে।");
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email) {
      const input = prompt("আপনার নিবন্ধিত শিক্ষক ইমেইল এড্রেসটি দিন:");
      if (!input) return;
      setEmail(input);
    }
    try {
      const siteUrl = typeof window !== "undefined" ? window.location.origin : "https://aarohon.com";
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: siteUrl });
      if (error) throw error;
      setInfoMsg(`আপনার ইমেইল (${email})-এ একটি পাসওয়ার্ড রিসেট লিংক পাঠানো হয়েছে।`);
    } catch (err: any) {
      setErrorMsg(err.message || "পাসওয়ার্ড রিসেট লিংক পাঠাতে সমস্যা হয়েছে।");
    }
  };

  return (
    <div className="relative min-h-dvh w-full bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900 overflow-hidden flex items-center justify-center p-4 sm:p-6 font-bengali">
      {/* Decorative blobs */}
      <div className="absolute -top-24 -left-24 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-amber-400/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-40 h-40 bg-violet-500/10 rounded-full blur-2xl pointer-events-none" />

      {/* Back to home */}
      <Link
        href="/"
        className="absolute top-5 left-5 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-200 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 px-3.5 py-2 rounded-xl transition cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" /> হোমে ফিরুন
      </Link>

      <div className="relative w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-7 space-y-3">
          <div className="inline-flex items-center gap-3">
            <span className="bg-gradient-to-tr from-amber-400 to-indigo-500 p-3 rounded-2xl shadow-lg shadow-black/30">
              <GraduationCap className="w-8 h-8 text-slate-900" />
            </span>
            <span className="text-3xl font-black tracking-wide text-white">আরোহণ</span>
          </div>
          <div className="space-y-1">
            <h1 className="text-lg sm:text-xl font-black text-white flex items-center justify-center gap-2">
              <Shield className="w-5 h-5 text-amber-300" /> শিক্ষক প্যানেল
            </h1>
            <p className="text-xs sm:text-sm text-indigo-300/90 font-medium">
              পরীক্ষা, প্রশ্নব্যাংক, কোর্স ও শিক্ষার্থীদের নিয়ন্ত্রণ — একটি সুরক্ষিত জায়গায়
            </p>
          </div>
        </div>

        {/* Login card */}
        <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-2xl shadow-black/40 border border-white/10 space-y-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-indigo-500" /> শিক্ষক লগইন
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
              <Sparkles className="w-3 h-3" /> Supabase সুরক্ষা
            </span>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl text-xs font-medium border bg-rose-50 text-rose-700 border-rose-200">
              {errorMsg}
            </div>
          )}
          {infoMsg && (
            <div className="p-3 rounded-xl text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
              {infoMsg}
            </div>
          )}

          <form onSubmit={handleEmailAuth} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                <Mail className="w-3.5 h-3.5 text-indigo-500" /> ইমেইল এড্রেস
              </label>
              <input
                type="email"
                required
                placeholder="teacher@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-xs sm:text-sm bg-slate-50/50"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-xs font-semibold text-slate-700 flex items-center gap-1">
                  <Key className="w-3.5 h-3.5 text-indigo-500" /> পাসওয়ার্ড
                </label>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer"
                >
                  পাসওয়ার্ড ভুলে গেছেন?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  placeholder="কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 pr-11 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-xs sm:text-sm bg-slate-50/50"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label="পাসওয়ার্ড দেখুন/লুকান"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-xl transition text-xs sm:text-sm shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> যাচাই হচ্ছে...
                </>
              ) : (
                <>
                  <Shield className="w-4 h-4" /> প্যানেলে প্রবেশ করুন
                </>
              )}
            </button>
          </form>

          <p className="text-[10px] text-slate-400 text-center leading-relaxed">
            শুধুমাত্র অনুমোদিত শিক্ষক/অ্যাডমিন অ্যাকাউন্ট প্রবেশ করতে পারবে। অননুমোদিত প্রবেশের
            চেষ্টা নিরীক্ষণ করা হয়।
          </p>
        </div>
      </div>
    </div>
  );
};
