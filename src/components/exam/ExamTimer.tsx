"use client";

import React, { useEffect, useState, useRef } from "react";
import { Timer } from "lucide-react";
import { getTrueNowMs } from "@/lib/bangladesh-time";
import { toBengaliDigits } from "@/lib/utils";

interface ExamTimerProps {
  initialSeconds: number;
  onTimeExpire: () => void;
  onTimeUpdate?: (secondsLeft: number) => void;
}

const LOW_SECONDS = 60;

export const ExamTimer: React.FC<ExamTimerProps> = ({
  initialSeconds,
  onTimeExpire,
  onTimeUpdate
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState(initialSeconds);
  const onTimeExpireRef = useRef(onTimeExpire);
  const onTimeUpdateRef = useRef(onTimeUpdate);

  useEffect(() => {
    onTimeExpireRef.current = onTimeExpire;
    onTimeUpdateRef.current = onTimeUpdate;
  });

  useEffect(() => {
    if (initialSeconds <= 0) return;

    setSecondsRemaining(initialSeconds);
    const endServerTime = getTrueNowMs() + initialSeconds * 1000;

    const interval = setInterval(() => {
      const remainingMs = Math.max(0, endServerTime - getTrueNowMs());
      const remainingSecs = Math.ceil(remainingMs / 1000);

      setSecondsRemaining(remainingSecs);
      if (onTimeUpdateRef.current) {
        onTimeUpdateRef.current(remainingSecs);
      }

      if (remainingMs <= 0) {
        clearInterval(interval);
        if (onTimeExpireRef.current) {
          onTimeExpireRef.current();
        }
      }
    }, 500);

    return () => clearInterval(interval);
  }, [initialSeconds]);

  const m = Math.max(0, Math.floor(secondsRemaining / 60));
  const s = Math.max(0, secondsRemaining % 60);
  const isLow = secondsRemaining <= LOW_SECONDS;
  const timeFormatted = `${toBengaliDigits(m.toString().padStart(2, "0"))}:${toBengaliDigits(s.toString().padStart(2, "0"))}`;

  return (
    <div
      className={`flex items-center gap-2 rounded-2xl px-3.5 py-2 font-mono font-black text-base sm:text-xl transition-colors ${
        isLow
          ? "bg-rose-600 text-white shadow-md shadow-rose-600/30 animate-pulse"
          : "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-600/25"
      }`}
    >
      <Timer className={`w-5 h-5 ${isLow ? "" : "text-indigo-200"}`} />
      <span>{timeFormatted}</span>
    </div>
  );
};
