"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Zap,
  Play,
  Clock,
  BookOpen,
  CircleHelp,
  CheckCircle2,
  UserPlus
} from "lucide-react";
import { Exam } from "@/types/exam";
import { toBengaliDigits, sortExamsForStudents } from "@/lib/utils";
import { useCompletedExams } from "@/lib/use-completed-exams";
import { parseBangladeshDateTime, getTrueDate, syncBangladeshNetworkTime } from "@/lib/bangladesh-time";

interface LiveExamsBoxProps {
  exams: Record<string, Exam>;
  onSelectLiveExam: (examId: string) => void;
  onOpenEnrollModal?: () => void;
}

/**
 * "লাইভ এক্সাম" — হোম পেজের একটা পূর্ণ-প্রস্থ ইনলাইন বক্স (মোডাল ছাড়া):
 * বক্সের ভেতরে সব চলমান লাইভ পরীক্ষা সিরিয়ালি (একের পর একটা) সাজানো থাকে —
 * যেকোনোটিতে ট্যাপ করলেই সরাসরি অংশ নেওয়া যায়। (বাংলাদেশ সময় অনুযায়ী লাইভ শনাক্তকরণ)
 */
export const LiveExamsBox: React.FC<LiveExamsBoxProps> = ({
  exams,
  onSelectLiveExam,
  onOpenEnrollModal
}) => {
  const [currentDate, setCurrentDate] = useState<Date>(() => getTrueDate());

  useEffect(() => {
    const timer = setInterval(() => setCurrentDate(getTrueDate()), 10000);
    // মাউন্টে নেটওয়ার্ক-টাইম সিঙ্ক — ডিভাইস ঘড়ি নয়
    syncBangladeshNetworkTime().then(() => setCurrentDate(getTrueDate()));
    return () => clearInterval(timer);
  }, []);

  // বর্তমানে চলমান (লাইভ) পরীক্ষা — বাংলাদেশ সময় অনুযায়ী
  const liveKeys = useMemo(
    () =>
      Object.entries(exams)
        .filter(([_, ex]) => {
          if (!ex.startTime) return false;
          const start = parseBangladeshDateTime(ex.startTime);
          if (!start || currentDate < start) return false;
          if (ex.endTime) {
            const end = parseBangladeshDateTime(ex.endTime);
            if (end && currentDate > end) return false;
          } else if (ex.leaderboardEndTime) {
            const end = parseBangladeshDateTime(ex.leaderboardEndTime);
            if (end && currentDate > end) return false;
          }
          return true;
        })
        .sort(sortExamsForStudents)
        .map(([k]) => k),
    [exams, currentDate]
  );

  const completedExams = useCompletedExams();

  if (liveKeys.length === 0) return null;

  return (
    <section className="relative font-bengali rounded-3xl bg-white border border-red-200 shadow-sm overflow-hidden">
      {/* হেডার — পূর্ণ প্রস্থ লাল */}
      <div className="bg-gradient-to-r from-red-600 to-red-700 text-white px-4 sm:px-6 py-4 sm:py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-white/20 flex items-center justify-center shrink-0 shadow-sm">
            <Zap className="w-6 h-6 fill-white" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-black text-white text-lg sm:text-xl leading-tight">লাইভ এক্সাম</h3>
              <span className="bg-white/20 text-white border border-white/30 text-[10px] sm:text-[11px] font-black px-2 py-0.5 rounded-full flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> চলছে
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-rose-100 font-bold mt-0.5">
              {toBengaliDigits(liveKeys.length)}টি পরীক্ষা এখন চলমান — যেকোনোটা ট্যাপ করে সরাসরি অংশ নিন
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto justify-between sm:justify-end">
          <span className="bg-white/20 text-white border border-white/30 text-xs sm:text-sm font-black px-3 py-1.5 rounded-xl flex items-center gap-1.5">
            <Zap className="w-4 h-4 fill-white" />
            {toBengaliDigits(liveKeys.length)}টি চলমান
          </span>
          {onOpenEnrollModal && (
            <button
              type="button"
              onClick={onOpenEnrollModal}
              className="bg-white text-red-700 hover:bg-red-50 font-black px-3 py-2 rounded-xl text-[11px] sm:text-xs shadow-sm transition cursor-pointer flex items-center gap-1.5"
            >
              <UserPlus className="w-3.5 h-3.5" /> Enroll Now
            </button>
          )}
        </div>
      </div>

      {/* তালিকা — সব live সিরিয়ালি */}
      <div className="p-3 sm:p-4 space-y-2.5 bg-slate-50">
        {liveKeys.map((k, idx) => {
          const ex = exams[k];
          const isCompleted = completedExams.has(k);
          const qCount = ex.questions?.length || 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onSelectLiveExam(k)}
              className="w-full text-left bg-white rounded-2xl border border-red-200/80 hover:border-red-400 hover:shadow-md transition p-3.5 sm:p-4 cursor-pointer group"
            >
              <div className="flex items-center gap-3">
                {/* ক্রমিক নাম্বার */}
                <span className="shrink-0 w-8 h-8 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm font-black flex items-center justify-center">
                  {toBengaliDigits(idx + 1)}
                </span>

                {/* সামনের লাল লোগো */}
                <span className="hidden sm:flex shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-red-700 text-white items-center justify-center shadow-md shadow-red-600/25 group-hover:scale-105 transition">
                  <Zap className="w-5 h-5 fill-white" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    <span className="bg-slate-200 text-black text-[11px] font-black px-2 py-0.5 rounded-lg border border-slate-300">
                      {ex.course}
                    </span>
                    <span className="bg-red-100 text-red-800 text-[10px] font-black px-2 py-0.5 rounded-md border border-red-300 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-ping" /> Live
                    </span>
                    {ex.isFree && (
                      <span className="bg-emerald-100 text-emerald-900 text-[10px] font-black px-2 py-0.5 rounded-lg border border-emerald-300 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" /> ফ্রি
                      </span>
                    )}
                    {isCompleted && (
                      <span className="bg-emerald-600 text-white text-[10px] font-black px-2 py-0.5 rounded-md flex items-center gap-0.5">
                        <CheckCircle2 className="w-2.5 h-2.5" /> সম্পন্ন
                      </span>
                    )}
                  </div>
                  <h4 className="font-black text-black text-sm sm:text-base group-hover:text-red-800 transition leading-snug">
                    {ex.title}
                  </h4>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-600 font-bold flex-wrap">
                    <span className="flex items-center gap-1">
                      <BookOpen className="w-3.5 h-3.5 text-red-700" /> {ex.subject}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-red-600" /> {toBengaliDigits(ex.timerMinutes)} মিনিট
                    </span>
                    <span className="flex items-center gap-1">
                      <CircleHelp className="w-3.5 h-3.5 text-red-600" /> {toBengaliDigits(qCount)}টি প্রশ্ন
                    </span>
                  </div>
                </div>

                {/* ডানে অংশ-নিন বাটন */}
                <span className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-red-600 to-red-700 text-white text-[11px] sm:text-xs font-black px-3 py-2 group-hover:from-red-700 group-hover:to-red-800 transition shadow-md shadow-red-600/25">
                  <Play className="w-3.5 h-3.5 fill-white text-white" />
                  <span className="hidden sm:inline">অংশ নিন</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <p className="bg-slate-50 px-4 sm:px-6 py-2.5 border-t border-slate-200 text-[10px] text-slate-500 font-bold">
        ⚡ চলমান পরীক্ষা শুরুর পর যে-কোনো সময়ে ট্যাপ করলেই অংশ নিতে পারবেন — শেষ হওয়ার আগেই উত্তর জমা দিন।
      </p>
    </section>
  );
};
