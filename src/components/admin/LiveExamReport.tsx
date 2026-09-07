"use client";

import React, { useState, useMemo } from "react";
import {
  Activity,
  X,
  RefreshCw,
  Loader2,
  GraduationCap,
  BookOpen,
  FileText,
  Users,
  Inbox
} from "lucide-react";
import {
  getLiveExamParticipation,
  getLiveExamParticipants,
  LiveExamRow
} from "@/actions/analytics-actions";
import { toBengaliDigits } from "@/lib/utils";

/**
 * শিক্ষক প্যানেলের "লাইভ অংশগ্রহণ" বাটন + মোডাল।
 * Course → Subject → Exam cascading dropdown; পরীক্ষা বাছাই করলে কারা লাইভ
 * দিয়েছে (শুধু নাম) দেখা যায়।
 */
export const LiveExamReport: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LiveExamRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [course, setCourse] = useState("");
  const [subject, setSubject] = useState("");
  const [examKey, setExamKey] = useState("");

  const [names, setNames] = useState<string[] | null>(null);
  const [namesLoading, setNamesLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    setCourse("");
    setSubject("");
    setExamKey("");
    setNames(null);
    try {
      const res = await getLiveExamParticipation();
      setRows(res);
    } catch {
      setError("ডেটা লোড করা যায়নি। আবার চেষ্টা করুন।");
    }
    setLoading(false);
  };

  const openModal = () => {
    setOpen(true);
    if (!rows) load();
  };
  const closeModal = () => setOpen(false);

  // Cascading options
  const courses = useMemo(() => {
    const seen = new Set<string>();
    (rows || []).forEach((r) => seen.add(r.course));
    return Array.from(seen);
  }, [rows]);

  const subjects = useMemo(() => {
    const seen = new Set<string>();
    (rows || []).forEach((r) => {
      if (course && r.course === course) seen.add(r.subject);
    });
    return Array.from(seen);
  }, [rows, course]);

  const exams = useMemo(
    () => (rows || []).filter((r) => (!course || r.course === course) && (!subject || r.subject === subject)),
    [rows, course, subject]
  );

  const selectedExam = exams.find((e) => e.examKey === examKey) || null;

  const fetchNames = async (key: string) => {
    setNames(null);
    setNamesLoading(true);
    const res = await getLiveExamParticipants(key);
    setNames(res.names);
    setNamesLoading(false);
  };

  const onCourseChange = (val: string) => {
    setCourse(val);
    setSubject("");
    setExamKey("");
    setNames(null);
  };
  const onSubjectChange = (val: string) => {
    setSubject(val);
    setExamKey("");
    setNames(null);
  };
  const onExamChange = (key: string) => {
    setExamKey(key);
    setNames(null);
    if (key) fetchNames(key);
  };

  const selectCls =
    "w-full px-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer";

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="inline-flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
        title="কোর্স → সাবজেক্ট → পরীক্ষা বেছে কারা লাইভ দিয়েছে দেখুন"
      >
        <Activity className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">লাইভ অংশগ্রহণ</span>
        <span className="sm:hidden">লাইভ অংশগ্রহণ</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 font-bengali">
          <div className="bg-white rounded-3xl w-full max-w-lg max-h-[92vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 bg-gradient-to-r from-indigo-900 to-slate-900 text-white shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-10 h-10 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center shrink-0">
                  <Activity className="w-5 h-5 text-emerald-300" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-black text-sm sm:text-base truncate">লাইভ পরীক্ষায় অংশগ্রহণ</h3>
                  <p className="text-[11px] text-indigo-200 truncate">কোর্স → সাবজেক্ট → পরীক্ষা বেছে নিন</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={load}
                  aria-label="রিফ্রেশ"
                  title="রিফ্রেশ"
                  className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  aria-label="বন্ধ করুন"
                  className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-grow overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
              {loading && rows === null ? (
                <div className="flex items-center justify-center gap-2 py-14 text-slate-400 text-xs font-bold">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-600" /> ডেটা লোড হচ্ছে...
                </div>
              ) : error ? (
                <div className="text-center py-10 text-rose-600 text-xs font-bold">{error}</div>
              ) : !rows || rows.length === 0 ? (
                <div className="text-center py-12 text-slate-400 space-y-1.5">
                  <Inbox className="w-9 h-9 mx-auto text-slate-300" />
                  <p className="text-sm font-bold text-slate-500">এখনও কোনো লাইভ অংশগ্রহণ নেই</p>
                  <p className="text-xs">কোনো লাইভ পরীক্ষায় স্টুডেন্ট অংশ নিলে এখানে দেখাবে।</p>
                </div>
              ) : (
                <>
                  {/* Course */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-black text-slate-700 mb-1.5">
                      <GraduationCap className="w-3.5 h-3.5 text-indigo-500" /> কোর্স
                    </label>
                    <select
                      value={course}
                      onChange={(e) => onCourseChange(e.target.value)}
                      className={selectCls}
                    >
                      <option value="">— কোর্স বেছে নিন —</option>
                      {courses.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Subject */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-black text-slate-700 mb-1.5">
                      <BookOpen className="w-3.5 h-3.5 text-indigo-500" /> সাবজেক্ট
                    </label>
                    <select
                      value={subject}
                      onChange={(e) => onSubjectChange(e.target.value)}
                      disabled={!course || subjects.length === 0}
                      className={`${selectCls} disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed`}
                    >
                      <option value="">— সাবজেক্ট বেছে নিন —</option>
                      {subjects.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Exam */}
                  <div>
                    <label className="flex items-center gap-1.5 text-xs font-black text-slate-700 mb-1.5">
                      <FileText className="w-3.5 h-3.5 text-indigo-500" /> পরীক্ষা
                    </label>
                    <select
                      value={examKey}
                      onChange={(e) => onExamChange(e.target.value)}
                      disabled={!subject || exams.length === 0}
                      className={`${selectCls} disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed`}
                    >
                      <option value="">— পরীক্ষা বেছে নিন —</option>
                      {exams.map((e) => (
                        <option key={e.examKey} value={e.examKey}>
                          {e.title} ({toBengaliDigits(e.liveCount)} জন)
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Participants */}
                  {selectedExam && (
                    <div className="pt-1 space-y-2.5">
                      <div className="flex items-center justify-between gap-2 rounded-2xl bg-indigo-50 border border-indigo-100 px-3.5 py-2.5">
                        <div className="min-w-0">
                          <p className="text-[11px] text-indigo-500 font-bold">যারা লাইভ দিয়েছেন</p>
                          <p className="font-black text-indigo-950 text-sm truncate">{selectedExam.title}</p>
                        </div>
                        {names && (
                          <span className="inline-flex items-center gap-1 bg-white text-indigo-700 font-black text-xs px-2.5 py-1 rounded-lg border border-indigo-200 shrink-0">
                            <Users className="w-3 h-3" /> {toBengaliDigits(names.length)} জন
                          </span>
                        )}
                      </div>

                      {namesLoading ? (
                        <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-xs font-bold">
                          <Loader2 className="w-4 h-4 animate-spin text-indigo-600" /> নাম লোড হচ্ছে...
                        </div>
                      ) : names === null ? (
                        <div className="text-center py-6 text-xs text-slate-400">পরীক্ষা বাছাই করলে নাম দেখা যাবে</div>
                      ) : names.length === 0 ? (
                        <div className="text-center py-8 text-xs text-slate-400">এই পরীক্ষায় এখনও কেউ লাইভ দেয়নি</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {names.map((n, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1.5 bg-slate-100 border border-slate-200 text-slate-800 text-xs font-bold px-2.5 py-1.5 rounded-lg"
                            >
                              <span className="w-5 h-5 rounded-md bg-indigo-600 text-white text-[10px] font-black flex items-center justify-center shrink-0">
                                {(n || "?").charAt(0).toUpperCase()}
                              </span>
                              {n}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
