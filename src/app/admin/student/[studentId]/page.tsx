"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Award,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Lock,
  Medal,
  Target,
  Trophy,
  XCircle
} from "lucide-react";
import { getStudentExamHistoryForTeacher } from "@/actions/student-actions";
import { Submission } from "@/types/submission";
import { toBengaliDigits, formatBangladeshDate } from "@/lib/utils";

interface ExamMeta {
  passMark: number;
  subject: string;
  course: string;
}

interface HistoryData {
  student: {
    id: string;
    name: string;
    email?: string;
    courses?: string[];
    photoURL?: string;
  } | null;
  submissions: Submission[];
  examsMeta: Record<string, ExamMeta>;
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function formatBdDateTimeSec(isoString: string) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  const bd = new Date(d.getTime() + 6 * 60 * 60 * 1000);
  const dateStr = `${toBengaliDigits(bd.getUTCDate())}/${toBengaliDigits(bd.getUTCMonth() + 1)}/${toBengaliDigits(bd.getUTCFullYear())}`;
  
  let hours = bd.getUTCHours();
  const minutes = bd.getUTCMinutes();
  const seconds = bd.getUTCSeconds();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  
  const mm = minutes < 10 ? `০${toBengaliDigits(minutes)}` : toBengaliDigits(minutes);
  const ss = seconds < 10 ? `০${toBengaliDigits(seconds)}` : toBengaliDigits(seconds);
  const hh = toBengaliDigits(hours);
  
  return `${dateStr}, ${hh}:${mm}:${ss} ${ampm}`;
}

function calculateStartTimeStr(isoString?: string, timeSpentStr?: string) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (timeSpentStr) {
    const match = timeSpentStr.match(/(\d+)\s*মি\.\s*(\d+)\s*সে\./);
    if (match) {
      const mins = parseInt(match[1]);
      const secs = parseInt(match[2]);
      d.setSeconds(d.getSeconds() - (mins * 60 + secs));
    }
  }
  return formatBdDateTimeSec(d.toISOString());
}

const fmtNum = (n: number) => toBengaliDigits(Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function StudentPerformancePage() {
  const params = useParams();
  const router = useRouter();
  const studentId = decodeParam(String(params.studentId || ""));

  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [expandedSubId, setExpandedSubId] = useState<string | number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await getStudentExamHistoryForTeacher(studentId);
        if (cancelled) return;
        if (!res) {
          setDenied(true);
          return;
        }
        setData(res);
      } catch {
        if (!cancelled) setErrorMsg("ডেটা লোড করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const toggleExpand = (id: string | number) => {
    setExpandedSubId(prev => prev === id ? null : id);
  };

  const formatAnswers = (answers: any[]) => {
    if (!answers || !Array.isArray(answers)) return "উত্তর পাওয়া যায়নি";
    return answers.map((a, i) => {
      let ansVal: number | null = null;
      if (typeof a === "number") ansVal = a;
      else if (a && typeof a === "object" && "ans" in a) ansVal = a.ans;
      
      const valStr = ansVal === 0 ? "ক" : ansVal === 1 ? "খ" : ansVal === 2 ? "গ" : ansVal === 3 ? "ঘ" : "—";
      return (
        <span key={i} className={`inline-block px-1.5 py-0.5 m-0.5 rounded text-[11px] font-bold ${ansVal === null ? 'bg-slate-100 text-slate-500' : 'bg-indigo-50 text-indigo-700 border border-indigo-100'}`}>
          {toBengaliDigits(i + 1)}:{valStr}
        </span>
      );
    });
  };

  const stats = useMemo(() => {
    if (!data) return null;
    const subs = data.submissions;
    const evaluated = subs.filter((s) => !s.isPendingEvaluation);
    const avg = evaluated.length
      ? evaluated.reduce((a, s) => a + (Number(s.score) || 0), 0) / evaluated.length
      : 0;
    const best = evaluated.length
      ? Math.max(...evaluated.map((s) => Number(s.score) || 0))
      : 0;
    let passed = 0;
    evaluated.forEach((s) => {
      const meta = data.examsMeta[s.examKey];
      if (meta && (Number(s.score) || 0) >= meta.passMark) passed++;
    });
    return {
      total: subs.length,
      liveCount: subs.filter((s) => s.isLiveSubmission).length,
      practiceCount: subs.length - subs.filter((s) => s.isLiveSubmission).length,
      avg,
      best,
      passed,
      evaluatedCount: evaluated.length
    };
  }, [data]);

  const goBack = () => router.push("/admin?tab=students");

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-slate-100 font-bengali text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
        <p className="text-xs font-bold">পরীক্ষার ফলাফল লোড হচ্ছে...</p>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-slate-100 font-bengali text-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-900 text-amber-400 flex items-center justify-center shadow-lg">
          <Lock className="w-7 h-7" />
        </div>
        <div>
          <h2 className="font-black text-slate-900 text-base">শুধু শিক্ষক প্যানেল থেকে দেখা যায়</h2>
          <p className="text-xs text-slate-500 mt-1.5 font-semibold">
            শিক্ষক হিসেবে লগইন করে আবার চেষ্টা করুন।
          </p>
        </div>
        <button
          onClick={goBack}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-5 py-2.5 rounded-xl transition cursor-pointer shadow-md"
        >
          শিক্ষক প্যানেলে ফিরে যান
        </button>
      </div>
    );
  }

  const student = data?.student;
  const submissions = data?.submissions || [];
  const examsMeta = data?.examsMeta || {};

  return (
    <div className="min-h-screen bg-slate-100 font-bengali">
      <div className="max-w-5xl mx-auto p-3 sm:p-5 md:p-6 space-y-5">
        {/* Top bar */}
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 text-xs text-indigo-700 hover:text-indigo-900 font-bold cursor-pointer bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm transition"
        >
          <ArrowLeft className="w-4 h-4" /> শিক্ষক প্যানেলে ফিরে যান
        </button>

        {/* Student header */}
        <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-3xl p-5 sm:p-7 shadow-sm border border-slate-800">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              {student?.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={student.photoURL}
                  alt=""
                  className="w-14 h-14 rounded-2xl object-cover border-2 border-amber-400/60 shadow-lg"
                />
              ) : (
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-400 to-indigo-400 p-0.5 shadow-lg shrink-0">
                  <div className="w-full h-full bg-slate-900/90 rounded-[14px] flex items-center justify-center text-xl font-black text-amber-300">
                    {(student?.name || "শে")?.trim().charAt(0)}
                  </div>
                </div>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg sm:text-2xl font-black truncate">{student?.name || "শিক্ষার্থী"}</h1>
                  {stats && stats.total > 0 && (
                    <span className="bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-[10px] font-black px-2 py-0.5 rounded-full flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> {toBengaliDigits(stats.total)}টি পরীক্ষা দিয়েছে
                    </span>
                  )}
                </div>
                <p className="text-xs text-indigo-200 font-semibold mt-1 break-all">
                  {student?.email ? `${student.email} · ` : ""}আইডি: {student?.id || studentId}
                </p>
                {student?.courses && student.courses.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {student.courses.map((c) => (
                      <span key={c} className="bg-white/10 border border-white/20 text-[10px] font-bold px-2 py-0.5 rounded-lg">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {!student && (
              <span className="text-[11px] text-amber-300 font-bold bg-white/10 border border-white/15 px-3 py-1.5 rounded-xl shrink-0">
                allowed_students-এ প্রোফাইল নেই (পুরোনো রেকর্ড)
              </span>
            )}
          </div>
        </div>

        {/* Error */}
        {errorMsg && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold rounded-2xl p-4 text-center">
            {errorMsg}
          </div>
        )}

        {/* Stats cards */}
        {stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                <FileText className="w-3.5 h-3.5 text-indigo-500" /> মোট পরীক্ষা
              </div>
              <p className="text-2xl font-black text-slate-900">{toBengaliDigits(stats.total)}</p>
              <p className="text-[11px] text-slate-400 font-semibold">
                লাইভ {toBengaliDigits(stats.liveCount)} · অনুশীলন {toBengaliDigits(stats.practiceCount)}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                <Medal className="w-3.5 h-3.5 text-amber-500" /> গড় স্কোর
              </div>
              <p className="text-2xl font-black text-slate-900">{stats.evaluatedCount > 0 ? fmtNum(stats.avg) : "—"}</p>
              <p className="text-[11px] text-slate-400 font-semibold">মূল্যায়িত {toBengaliDigits(stats.evaluatedCount)}টির ভিত্তিতে</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                <Trophy className="w-3.5 h-3.5 text-indigo-500" /> সর্বোচ্চ স্কোর
              </div>
              <p className="text-2xl font-black text-slate-900">{stats.evaluatedCount > 0 ? fmtNum(stats.best) : "—"}</p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                <Award className="w-3.5 h-3.5 text-emerald-600" /> পাসের সংখ্যা
              </div>
              <p className="text-2xl font-black text-slate-900">{toBengaliDigits(stats.passed)}</p>
              <p className="text-[11px] text-slate-400 font-semibold">পাস মার্কের ভিত্তিতে</p>
            </div>
          </div>
        )}

        {/* Exam history list */}
        <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="font-black text-slate-900 text-base flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-600" /> পরীক্ষা ও প্রাপ্ত নম্বর
              <span className="bg-indigo-50 text-indigo-700 text-xs font-black px-2 py-0.5 rounded-md border border-indigo-200">
                {toBengaliDigits(submissions.length)}টি
              </span>
            </h3>
          </div>

          {submissions.length === 0 ? (
            <div className="text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-200 space-y-2">
              <BookOpen className="w-9 h-9 text-slate-300 mx-auto" />
              <p className="text-xs text-slate-400 font-medium">
                এই শিক্ষার্থীর এখনো কোনো পরীক্ষার রেকর্ড নেই।
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {submissions.map((s, idx) => {
                const meta = examsMeta[s.examKey];
                const isPending = !!s.isPendingEvaluation;
                const isLive = !!s.isLiveSubmission;
                const score = Number(s.score) || 0;
                const isPassed = !isPending && meta ? score >= meta.passMark : undefined;
                const accuracy =
                  s.totalQuestions > 0 ? Math.round(((Number(s.correct) || 0) / s.totalQuestions) * 100) : 0;
                const subId = s.id || idx;
                const isExpanded = expandedSubId === subId;

                return (
                  <div
                    key={subId}
                    className="p-3.5 sm:p-4 rounded-2xl border border-slate-200 bg-white hover:border-indigo-300 transition flex flex-col gap-3 cursor-pointer"
                    onClick={() => toggleExpand(subId)}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-black text-slate-900 text-sm truncate">{s.examTitle}</h4>
                          {meta?.subject && (
                            <span className="bg-slate-100 border border-slate-200 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-md">
                              {meta.subject}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col gap-1 text-[11px] font-semibold text-slate-500">
                          {s.submittedAtISO && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3 text-emerald-500" /> শুরু: {calculateStartTimeStr(s.submittedAtISO, s.timeSpent)}
                            </span>
                          )}
                          {s.submittedAtISO && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3 text-amber-500" /> জমা: {formatBdDateTimeSec(s.submittedAtISO)}
                            </span>
                          )}
                          {s.timeSpent && <span>মোট সময়: {s.timeSpent}</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {isLive ? (
                            <span className="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-black px-2 py-0.5 rounded-md">
                              লাইভ/অফিসিয়াল
                            </span>
                          ) : (
                            <span className="bg-slate-100 text-slate-500 border border-slate-200 text-[10px] font-black px-2 py-0.5 rounded-md">
                              অনুশীলন
                            </span>
                          )}
                          {isPending ? (
                            <span className="bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-black px-2 py-0.5 rounded-md flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" /> অমূল্যায়িত
                            </span>
                          ) : isPassed === true ? (
                            <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black px-2 py-0.5 rounded-md flex items-center gap-1">
                              <CheckCircle2 className="w-2.5 h-2.5" /> পাস
                            </span>
                          ) : isPassed === false ? (
                            <span className="bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-black px-2 py-0.5 rounded-md flex items-center gap-1">
                              <XCircle className="w-2.5 h-2.5" /> ফেল
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 sm:gap-4 shrink-0">
                        <div className="text-right">
                          <p className="text-xl font-black text-slate-900 leading-none">{fmtNum(score)}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-1">স্কোর</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-black text-emerald-600 leading-none">{toBengaliDigits(Number(s.correct) || 0)}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-1">সঠিক</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-black text-rose-600 leading-none">{toBengaliDigits(Number(s.incorrect) || 0)}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-1">ভুল</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-black text-indigo-600 leading-none">{toBengaliDigits(s.totalQuestions || 0)}</p>
                          <p className="text-[10px] text-slate-400 font-semibold mt-1">প্রশ্ন</p>
                        </div>
                        <div
                          className={`w-14 h-14 rounded-2xl border-2 flex items-center justify-center flex-col shrink-0 ${
                            accuracy >= 80
                              ? "border-emerald-400 bg-emerald-50"
                              : accuracy >= 40
                              ? "border-amber-400 bg-amber-50"
                              : "border-rose-300 bg-rose-50"
                          }`}
                        >
                          <span className="text-xs font-black text-slate-800">{toBengaliDigits(accuracy)}%</span>
                          <span className="text-[8px] font-bold text-slate-400">নির্ভুলতা</span>
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-2 pt-3 border-t border-slate-100">
                        <h4 className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1.5">
                          <BookOpen className="w-3.5 h-3.5" /> শিক্ষার্থীর দেওয়া উত্তরসমূহ:
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {formatAnswers(s.answers)}
                        </div>
                      </div>
                    )}

                    {meta?.course && (
                      <p className="text-[10px] text-slate-400 font-semibold border-t border-slate-100 pt-2">
                        কোর্স: {meta.course}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
