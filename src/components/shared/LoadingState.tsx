"use client";

import React from "react";
import { GraduationCap } from "lucide-react";

/**
 * শেয়ার্ড লোডিং অ্যানিমেশন — যেখানে ডেটা আনতে দেরি হয় সেখানে দেখানো হয়।
 *
 * • variant="card"   → বড় কার্ডে অ্যানিমেটেড skeleton + ঘূর্ণায়মান রিং (পেজ/সেকশন লোড)
 * • variant="list"   → তালিকার জন্য কয়েকটি skeleton সারি (তালিকা লোড)
 * • variant="inline" → ছোট, এক লাইনে (বাটন/ছোট অংশ)
 *
 * সবই indigo থিম ও font-bengali-সহ; কোনো নতুন dependency নেই (Tailwind animate-)।
 */

interface LoadingStateProps {
  /** বাংলা লেবেল (যেমন "প্রশ্ন লোড হচ্ছে...") */
  label?: string;
  /** ছোট সহায়ক লেখা */
  hint?: string;
  variant?: "card" | "list" | "inline";
  /** skeleton সারি কতটি (variant="list") */
  rows?: number;
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  label = "লোড হচ্ছে...",
  hint,
  variant = "card",
  rows = 4,
  className = ""
}) => {
  if (variant === "inline") {
    return (
      <span className={`inline-flex items-center gap-2 text-slate-500 font-bold ${className}`}>
        <span className="relative flex h-4 w-4 items-center justify-center">
          <span className="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60 animate-ping" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-600" />
        </span>
        <span className="text-xs">{label}</span>
      </span>
    );
  }

  if (variant === "list") {
    return (
      <div className={`space-y-2.5 font-bengali ${className}`} role="status" aria-live="polite">
        {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-3.5 rounded-2xl border border-slate-200 bg-white"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="w-9 h-9 rounded-xl bg-slate-200 animate-pulse shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 rounded-full bg-slate-200 animate-pulse" style={{ width: `${70 - i * 8}%` }} />
              <div className="h-2.5 rounded-full bg-slate-100 animate-pulse" style={{ width: `${45 - i * 4}%` }} />
            </div>
          </div>
        ))}
        <p className="text-center text-[11px] font-bold text-slate-400 pt-1">{label}</p>
      </div>
    );
  }

  // variant === "card"
  return (
    <div
      className={`bg-white rounded-3xl border border-slate-200 shadow-sm p-6 sm:p-8 font-bengali ${className}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center text-center gap-3">
        {/* অ্যানিমেটেড আইকন + রিং */}
        <div className="relative inline-flex items-center justify-center">
          <span className="absolute h-16 w-16 rounded-full border-4 border-indigo-100" />
          <span className="absolute h-16 w-16 rounded-full border-4 border-transparent border-t-indigo-600 animate-spin" />
          <span className="relative w-9 h-9 rounded-2xl bg-gradient-to-tr from-amber-400 to-indigo-500 p-0.5">
            <span className="w-full h-full bg-white rounded-[13px] flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-indigo-600" />
            </span>
          </span>
        </div>

        <p className="text-sm font-black text-slate-700">{label}</p>
        {hint && <p className="text-[11px] text-slate-400 font-bold max-w-xs leading-relaxed">{hint}</p>}

        {/* অ্যানিমেটেড প্রগ্রেস-বল (indeterminate) */}
        <div className="w-full max-w-xs h-1.5 rounded-full bg-slate-100 overflow-hidden mt-1">
          <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 animate-[loadingbar_1.4s_ease-in-out_infinite]" />
        </div>

        {/* skeleton কার্ড */}
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-3 rounded-2xl border border-slate-100 bg-slate-50/60 space-y-2">
              <div className="h-3 rounded-full bg-slate-200 animate-pulse" style={{ width: `${80 - i * 10}%` }} />
              <div className="h-2.5 rounded-full bg-slate-100 animate-pulse" style={{ width: `${55 - i * 6}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
