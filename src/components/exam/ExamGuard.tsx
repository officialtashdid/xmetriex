"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { ShieldAlert, Timer } from "lucide-react";
import { toBengaliDigits } from "@/lib/utils";

interface ExamGuardProps {
  /** পরীক্ষা শুরু হয়ে গেলে true — তখনই নিরীক্ষণ চলে */
  active: boolean;
  /** tab/উইন্ডো ছাড়া → সতর্ক; এতবার ছাড়লে অটো-সাবমিট */
  maxLeaves?: number;
  /** অটো-সাবমিট কলব্যাক (ডেমো নয় — আসল জমা) */
  onAutoSubmit?: () => void;
}

/**
 * এক্সাম-সুরক্ষা:
 *  • tab/উইন্ডো ছেড়ে গেলে সতর্কতা (কঠোর: নির্দিষ্টবার ছাড়লে অটো-সাবমিট)
 *  • copy/right-click/print-block (ব্রাউজার-স্তরের deterrent)
 *
 * সীমা: পূর্ণ স্ক্রিনশট/রেকর্ডিং আটকানো ওয়েবে অসম্ভব — এটি শুধু শক্তিশালী নিরুৎসাহন।
 */
export const ExamGuard: React.FC<ExamGuardProps> = ({
  active,
  maxLeaves = 3,
  onAutoSubmit
}) => {
  const [warning, setWarning] = useState(false);
  const [finalStrike, setFinalStrike] = useState(false);
  const [countdown, setCountdown] = useState<number>(0);

  const activeRef = useRef(active);
  const onAutoSubmitRef = useRef(onAutoSubmit);
  const leaveCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const warnedRef = useRef(false);
  const autoSubmittedRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
    onAutoSubmitRef.current = onAutoSubmit;
    // সক্রিয় না থাকলে রিসেট
    if (!active) {
      leaveCountRef.current = 0;
      warnedRef.current = false;
      autoSubmittedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
  }, [active, onAutoSubmit]);

  const fireAutoSubmit = useCallback(() => {
    if (autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    if (onAutoSubmitRef.current) onAutoSubmitRef.current();
  }, []);

  // অটো-সাবমিট কাউন্টডাউন শুরু
  const startAutoSubmit = useCallback(() => {
    if (warnedRef.current) return;
    warnedRef.current = true;
    setWarning(true);
    setCountdown(10);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        const next = c - 1;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          setWarning(false);
          fireAutoSubmit();
        }
        return next;
      });
    }, 1000);
  }, [fireAutoSubmit]);

  const resetCountdown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setWarning(false);
    setFinalStrike(false);
    warnedRef.current = false;
    setCountdown(0);
  }, []);

  // tab/উইন্ডো ছাড়া ও ফেরা ধরা — visibility-based
  useEffect(() => {
    if (!active) return;

    let awayTimer: ReturnType<typeof setTimeout> | null = null;
    // "ছাড়া" গণনার সময়সীমা — এই সময়ের মধ্যে ফিরে এলে স্ট্রাইক গোনা হয় না (মোবাইলে
    // দ্রুত অ্যাপ-স্যুইচ/নোটিফিকেশন ভিজিটে যেন মিথ্যা ধরা না পড়ে)
    const AWAY_THRESHOLD_MS = 4000;
    let hiddenSince: number | null = null;

    const scheduleAwayTimer = () => {
      if (awayTimer) clearTimeout(awayTimer);
      awayTimer = setTimeout(() => {
        if (!activeRef.current) return;
        // ৪ সেকেন্ডের বেশি দূরে ছিল → স্ট্রাইক
        const nowCount = leaveCountRef.current + 1;
        leaveCountRef.current = nowCount;
        if (nowCount >= maxLeaves) {
          if (!autoSubmittedRef.current && !warnedRef.current) {
            setFinalStrike(true);
            startAutoSubmit();
          }
        } else {
          setFinalStrike(false);
          setWarning(true);
          if (timerRef.current) clearInterval(timerRef.current);
          let t = 3;
          setCountdown(t);
          timerRef.current = setInterval(() => {
            t -= 1;
            setCountdown(t);
            if (t <= 0) {
              if (timerRef.current) clearInterval(timerRef.current);
              setWarning(false);
              warnedRef.current = false;
              setCountdown(0);
            }
          }, 1000);
        }
      }, AWAY_THRESHOLD_MS);
    };

    const onVisibility = () => {
      if (!activeRef.current) return;
      if (document.hidden) {
        hiddenSince = Date.now();
        scheduleAwayTimer();
      } else {
        hiddenSince = null;
        if (awayTimer) {
          clearTimeout(awayTimer);
          awayTimer = null;
        }
        resetCountdown();
      }
    };

    const onBlur = () => {
      // blur-এ সরাসরি কিছু করি না — শুধু গোপন (hidden) হলেই গণনা।
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      if (awayTimer) clearTimeout(awayTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // কপি/প্রিন্ট/মেনু ব্লক
  useEffect(() => {
    if (!active) return;
    const prevent = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      // Ctrl+P (print), Ctrl+C/X/A (copy/cut/select), Ctrl+Shift+I (devtools)
      if (ctrl && ["p", "c", "x", "a", "s"].includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
      // F12 / PrtSc (প্রিন্টস্ক্রিন keydown-এ cancel করা যায় কিছু ব্রাউজারে)
      if (e.key === "F12" || e.key === "PrintScreen") {
        e.preventDefault();
      }
    };
    const onContext = (e: Event) => e.preventDefault();
    const onCopy = prevent;
    const onSelectStart = prevent;

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("copy", onCopy);
    document.addEventListener("selectstart", onSelectStart);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("selectstart", onSelectStart);
    };
  }, [active]);

  // সতর্ক ওভারলে
  if (!active) return null;

  return (
    <>
      {/* কঠোর সতর্ক + অটো-সাবমিট কাউন্টডাউন */}
      {warning && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm font-bengali">
          <div className="bg-white rounded-3xl max-w-sm w-full p-6 text-center space-y-4 shadow-2xl">
            <div className="w-14 h-14 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900">পরীক্ষার পেজ ছেড়ে যাবেন না</h3>
              <p className="text-xs sm:text-sm text-slate-500 mt-1 font-bold leading-relaxed">
                {finalStrike
                  ? "এটি চালিয়ে গেলে উত্তরপত্র স্বয়ংক্রিয়ভাবে জমা হয়ে যাবে। পরীক্ষার পেজে ফিরে আসুন!"
                  : "পরীক্ষার সময় অন্য ট্যাব/অ্যাপে যাওয়া যাবে না। দয়া করে পরীক্ষার পেজে ফিরে আসুন।"}
              </p>
            </div>
            {finalStrike ? (
              <div className="flex items-center justify-center gap-2 text-rose-600 font-black">
                <Timer className="w-5 h-5 animate-pulse" />
                <span>{toBengaliDigits(countdown)} সেকেন্ডের মধ্যে সাবমিট হবে</span>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2 text-amber-600 font-black">
                <ShieldAlert className="w-5 h-5" />
                <span>সতর্কতা — পরীক্ষার পেজে ফিরে আসুন</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                resetCountdown();
                window.focus();
              }}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 rounded-2xl text-sm transition cursor-pointer"
            >
              পরীক্ষায় ফিরে যান
            </button>
          </div>
        </div>
      )}
    </>
  );
};
