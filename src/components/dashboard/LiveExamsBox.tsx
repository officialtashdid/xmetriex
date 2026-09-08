"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Zap,
  Play,
  Clock,
  BookOpen,
  CircleHelp,
  CheckCircle2,
  X,
  ChevronRight,
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
 * "লাইভ এক্সাম" — হোম পেজে একটা কমপ্যাক্ট বক্স:
 * ট্যাপ করলে একটা উইন্ডো (মোডাল) খোলে, সেখানে চলমান সব লাইভ পরীক্ষার তালিকা
 * থেকে সরাসরি অংশ নেওয়া যায়। (বাংলাদেশ সময় অনুযায়ী লাইভ শনাক্তকরণ)
 */
export const LiveExamsBox: React.FC<LiveExamsBoxProps> = ({
  exams,
  onSelectLiveExam,
  onOpenEnrollModal
}) => {
  const [open, setOpen] = useState(false);
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

  const startExam = (key: string) => {
    setOpen(false);
    onSelectLiveExam(key);
  };

  return (
    <>
      {/* ---------- ১) কমপ্যাক্ট বক্স (হালকা লাল — ট্যাপ → উইন্ডো) ---------- */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left font-bengali rounded-3xl bg-gradient-to-r from-red-100 via-red-50 to-white border border-red-200 shadow-sm hover:shadow-md transition-all duration-200 group cursor-pointer p-4 sm:p-5 active:scale-[0.995] h-full"
      >
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-red-600 text-white flex items-center justify-center shadow-md shadow-red-600/30 shrink-0 group-hover:scale-105 transition">
            <Zap className="w-6 h-6 fill-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-black text-black text-base sm:text-lg leading-tight">লাইভ এক্সাম</h3>
              <span className="bg-red-100 text-red-800 border border-red-300 text-[10px] font-black px-2 py-0.5 rounded-full flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" /> চলছে
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-slate-700 font-bold mt-0.5">
              {toBengaliDigits(liveKeys.length)}টি পরীক্ষা এখন চলমান — ট্যাপ করে দেখুন ও অংশ নিন
            </p>
          </div>
          <span className="shrink-0 inline-flex items-center gap-1 rounded-xl bg-red-600 text-white text-xs font-black px-3 py-2 group-hover:bg-red-700 transition shadow-sm">
            দেখুন <ChevronRight className="w-4 h-4" />
          </span>
        </div>
      </button>

      {/* ---------- ২) উইন্ডো (মোডাল): চলমান সব লাইভ এক্সাম ---------- */}
      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center font-bengali"
          role="dialog"
          aria-modal="true"
        >
          {/* backdrop */}
          <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

          <div className="relative w-full sm:max-w-2xl max-h-[88vh] flex flex-col bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-6 duration-300">
            {/* হেডার */}
            <div className="bg-gradient-to-r from-red-600 to-red-700 text-white px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                  <Zap className="w-5 h-5 fill-white" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-black text-base leading-tight">লাইভ এক্সাম</h3>
                  <p className="text-[11px] text-rose-100 font-bold">
                    {toBengaliDigits(liveKeys.length)}টি পরীক্ষা চলমান — যেকোনোটা বেছে সরাসরি অংশ নিন
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onOpenEnrollModal && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpenEnrollModal();
                    }}
                    className="bg-white/20 hover:bg-white/35 text-white border border-white/30 font-bold px-3 py-1.5 rounded-xl text-[11px] shadow-sm transition cursor-pointer flex items-center gap-1"
                  >
                    <UserPlus className="w-3.5 h-3.5" /> Enroll Now
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/30 text-white flex items-center justify-center transition cursor-pointer"
                  aria-label="বন্ধ করুন"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* তালিকা */}
            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2.5 bg-slate-50">
              {liveKeys.map((k) => {
                const ex = exams[k];
                const isCompleted = completedExams.has(k);
                const qCount = ex.questions?.length || 0;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => startExam(k)}
                    className="w-full text-left bg-gradient-to-r from-red-50/70 to-white rounded-2xl border border-red-200/80 hover:border-red-400 hover:shadow-md transition p-3 sm:p-3.5 cursor-pointer group"
                  >
                    <div className="flex items-center gap-3">
                      {/* সামনের লাল লোগো */}
                      <span className="shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-red-700 text-white flex items-center justify-center shadow-md shadow-red-600/25 group-hover:scale-105 transition">
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
                            <span className="bg-red-100 text-red-800 text-[10px] font-black px-2 py-0.5 rounded-lg border border-red-300 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-red-700" /> ফ্রি
                            </span>
                          )}
                          {isCompleted && (
                            <span className="bg-red-600 text-white text-[10px] font-black px-2 py-0.5 rounded-md flex items-center gap-0.5">
                              <CheckCircle2 className="w-2.5 h-2.5" /> সম্পন্ন
                            </span>
                          )}
                        </div>
                        <h4 className="font-black text-black text-sm sm:text-base group-hover:text-red-800 transition leading-snug">
                          {ex.title}
                        </h4>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-red-900 font-bold flex-wrap">
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

                      {/* ডানে লাল অংশ-নিন বাটন */}
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
          </div>
        </div>
      )}
    </>
  );
};
