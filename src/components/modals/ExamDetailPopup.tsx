"use client";

import React, { useState, useEffect } from "react";
import { X, Clock, Loader2, CheckCircle2, XCircle, MinusCircle, Award, CalendarDays, ListChecks, ChevronDown, ChevronUp } from "lucide-react";
import { Submission } from "@/types/submission";
import { Exam, QuestionItem, QuestionSolution } from "@/types/exam";
import { getExamSolutions } from "@/actions/exam-actions";
import { fetchExamWithQuestions } from "@/actions/admin-actions";
import { isAnswerTimeReached } from "@/lib/bangladesh-time";
import { formatBangladeshClock, toBengaliDigits } from "@/lib/utils";

import { BookmarkButton } from "@/components/shared/BookmarkButton";
import { saveMistakesFromSubmission } from "@/lib/mistake-bookmark-store";

interface ExamDetailPopupProps {
  isOpen: boolean;
  submission: Submission | null;
  exam: Exam | null;
  onClose: () => void;
}

const optLabels = ["ক", "খ", "গ", "ঘ"];

export const ExamDetailPopup: React.FC<ExamDetailPopupProps> = ({
  isOpen,
  submission,
  exam,
  onClose,
}) => {
  const [solutions, setSolutions] = useState<QuestionSolution[] | null>(null);
  const [examQuestions, setExamQuestions] = useState<QuestionItem[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // আগে সংক্ষিপ্ত (brief) ফলাফল — শিক্ষার্থী চাইলে "বিস্তারিত" চেপে প্রশ্ন-রিভিউ খোলে
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (isOpen && submission) {
      setIsLoading(true);
      Promise.all([
        fetchExamWithQuestions(submission.examKey),
        getExamSolutions(submission.examKey)
      ])
        .then(([ex, sols]) => {
          setExamQuestions(ex?.questions || null);
          setSolutions(sols);
          setIsLoading(false);
          const qs =
            ex?.questions && ex.questions.length > 0
              ? ex.questions
              : exam?.questions || [];
          if (sols && qs.length > 0 && submission.studentId) {
            saveMistakesFromSubmission(
              submission.studentId,
              submission.examTitle,
              qs,
              sols,
              submission.answers || [],
              ex?.subject || exam?.subject || ""
            );
          }
        })
        .catch((err) => {
          console.error("Failed to load exam solutions:", err);
          setIsLoading(false);
        });
    }
  }, [isOpen, submission, exam]);

  if (!isOpen || !submission) return null;

  const canShowAnswers = exam ? isAnswerTimeReached(exam) : true;

  const displayQuestions =
    examQuestions && examQuestions.length > 0
      ? examQuestions
      : exam?.questions?.[0]?.q
        ? exam.questions || []
        : [];

  const total = displayQuestions.length || submission.totalQuestions || 0;
  const correct = Number(submission.correct ?? 0);
  const incorrect = Number(submission.incorrect ?? 0);
  const skipped = Math.max(0, total - correct - incorrect);
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-slate-100 overflow-y-auto font-bengali">
      <div className="max-w-3xl mx-auto p-3 sm:p-6 space-y-4">
        {/* Top bar */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3 flex items-center justify-between gap-3 sticky top-3 z-10">
          <div className="min-w-0">
            <h3 className="text-sm sm:text-lg font-black text-slate-900 truncate">{submission.examTitle}</h3>
            <p className="text-[11px] sm:text-xs text-slate-500">
              {exam?.course ? `${exam.course} · ` : ""}
              {submission.submittedAtISO ? formatBangladeshClock(submission.submittedAtISO) : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="বন্ধ করুন"
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!canShowAnswers ? (
          <div className="bg-white rounded-3xl border border-amber-200 p-8 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-amber-100 flex items-center justify-center mx-auto">
              <Clock className="w-7 h-7 text-amber-600 animate-pulse" />
            </div>
            <h4 className="font-bold text-amber-950 text-lg">ফলাফল ও মার্ক্স এখনও অপ্রকাশিত</h4>
            <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              শিক্ষক কর্তৃক ফলাফল রিলিজ করার পর প্রতিটি প্রশ্নের সঠিক উত্তর, আপনার উত্তর ও পূর্ণাঙ্গ ব্যাখ্যা দেখতে পাবেন।
            </p>
            {exam?.endTime && (
              <div className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 px-3.5 py-1.5 rounded-xl text-xs text-amber-900 font-medium">
                <CalendarDays className="w-3.5 h-3.5" /> পরীক্ষা সমাপ্তির সময়: {formatBangladeshClock(exam.endTime)}
              </div>
            )}
          </div>
        ) : isLoading ? (
          <div className="text-center py-16 text-slate-400 flex items-center justify-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-indigo-600" /> সম্পূর্ণ প্রশ্ন লোড হচ্ছে...
          </div>
        ) : displayQuestions.length === 0 ? (
          <p className="text-xs text-slate-500 text-center py-12">এই পরীক্ষার প্রশ্নাবলি আর উপলব্ধ নেই।</p>
        ) : (
          <>
            {/* সংক্ষিপ্ত ফলাফল (brief) — মোবাইল-ফ্রেন্ডলি */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5 space-y-3">
              {/* স্কোর হিরো */}
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm shrink-0">
                  <Award className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-500 font-bold">চূড়ান্ত স্কোর</p>
                  <p className="text-2xl font-black text-slate-900 leading-tight">
                    {toBengaliDigits(submission.score ?? 0)}
                    <span className="text-sm text-slate-400 font-bold"> / {toBengaliDigits(total)}</span>
                  </p>
                </div>
                <span className="ml-auto shrink-0 inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 border border-indigo-200 px-3 py-1.5 rounded-xl text-xs font-black">
                  সঠিকতা {toBengaliDigits(accuracy)}%
                </span>
              </div>

              {/* প্রগ্রেস বার */}
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden flex">
                <div className="bg-emerald-500" style={{ width: `${total ? (correct / total) * 100 : 0}%` }} />
                <div className="bg-rose-400" style={{ width: `${total ? (incorrect / total) * 100 : 0}%` }} />
              </div>

              {/* ৩টি মেট্রিক — মোবাইলে গ্রিড, টেক্সট ওভারফ্লো করে না */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2.5 text-center">
                  <div className="text-base font-black text-emerald-800">{toBengaliDigits(correct)}</div>
                  <div className="text-[10px] text-emerald-700 font-bold mt-0.5">সঠিক</div>
                </div>
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-2.5 text-center">
                  <div className="text-base font-black text-rose-800">{toBengaliDigits(incorrect)}</div>
                  <div className="text-[10px] text-rose-700 font-bold mt-0.5">ভুল</div>
                </div>
                <div className="bg-slate-100 border border-slate-200 rounded-xl p-2.5 text-center">
                  <div className="text-base font-black text-slate-700">{toBengaliDigits(skipped)}</div>
                  <div className="text-[10px] text-slate-500 font-bold mt-0.5">বাদ</div>
                </div>
              </div>

              {/* বিস্তারিত দেখার টগল */}
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="w-full inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 rounded-xl text-sm transition cursor-pointer"
              >
                <ListChecks className="w-4 h-4" />
                {showDetails ? "বিস্তারিত লুকান" : "প্রশ্নভিত্তিক বিস্তারিত দেখুন"}
                {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>

            {/* Full question review — শুধু বিস্তারিত চাইলে */}
            {showDetails && (
              <div className="space-y-4">
                {displayQuestions.map((q, qIdx) => {
                const studentAnsIdx = submission.answers?.[qIdx] ?? null;
                const sol = solutions?.[qIdx] || { correct: 0, exp: "" };
                const isCorrect = studentAnsIdx !== null && studentAnsIdx === sol.correct;
                const isSkipped = studentAnsIdx === null;

                const statusPill = isSkipped ? (
                  <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 px-2 py-0.5 rounded-lg text-[11px] font-black">
                    <MinusCircle className="w-3 h-3" /> বাদ পড়েছে
                  </span>
                ) : isCorrect ? (
                  <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-lg text-[11px] font-black">
                    <CheckCircle2 className="w-3 h-3" /> সঠিক
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 bg-rose-100 text-rose-800 px-2 py-0.5 rounded-lg text-[11px] font-black">
                    <XCircle className="w-3 h-3" /> ভুল
                  </span>
                );

                return (
                  <div
                    key={qIdx}
                    className={`bg-white rounded-2xl border shadow-sm p-4 sm:p-5 ${
                      isSkipped ? "border-slate-200" : isCorrect ? "border-emerald-200" : "border-rose-200"
                    }`}
                  >
                    {/* Question header */}
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="font-black text-slate-900 text-sm sm:text-base leading-relaxed">
                        <span className="text-indigo-600 mr-1.5">{toBengaliDigits(qIdx + 1)}.</span>
                        {q.q}
                      </h4>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <BookmarkButton
                          size="sm"
                          studentId={submission.studentId}
                          question={{
                            q: q.q,
                            opts: q.opts,
                            correct: sol.correct,
                            exp: sol.exp,
                            userAns: studentAnsIdx,
                            examTitle: submission.examTitle,
                            topic: q.topic,
                            subject: exam?.subject || ""
                          }}
                        />
                        {statusPill}
                      </div>
                    </div>

                    {/* Options */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
                      {q.opts.map((opt, oIdx) => {
                        const isAns = oIdx === sol.correct;
                        const isStudent = oIdx === studentAnsIdx;
                        let boxCls = "border-slate-200 bg-slate-50 text-slate-700";
                        if (isAns) boxCls = "border-emerald-300 bg-emerald-50 text-emerald-950 font-bold";
                        if (isStudent && !isAns) boxCls = "border-rose-300 bg-rose-50 text-rose-950 font-bold";
                        if (isAns && isStudent) boxCls = "border-emerald-400 bg-emerald-100 text-emerald-950 font-bold";
                        return (
                          <div key={oIdx} className={`p-2.5 rounded-xl border flex items-center gap-2 text-xs sm:text-sm ${boxCls}`}>
                            <span className="w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 bg-slate-800 text-white">
                              {optLabels[oIdx]}
                            </span>
                            <span className="flex-1">{opt}</span>
                            {isAns && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
                            {isStudent && !isAns && <XCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                          </div>
                        );
                      })}
                    </div>

                    {/* Answer summary */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs sm:text-sm">
                      <span className="text-slate-600">
                        আপনার উত্তর:{" "}
                        <strong className={isCorrect ? "text-emerald-700" : isSkipped ? "text-slate-400" : "text-rose-700"}>
                          {isSkipped ? "দেওয়া হয়নি" : `${optLabels[studentAnsIdx!]} (${q.opts[studentAnsIdx!] || "—"})`}
                        </strong>
                      </span>
                      <span className="text-emerald-700">
                        সঠিক উত্তর:{" "}
                        <strong>
                          {optLabels[sol.correct]} ({q.opts[sol.correct] || "—"})
                        </strong>
                      </span>
                    </div>

                    {/* Explanation */}
                    {sol.exp && (
                      <div className="mt-3 p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-xs sm:text-sm text-slate-700 leading-relaxed">
                        <strong className="text-amber-900 block mb-0.5">ব্যাখ্যা:</strong>
                        {sol.exp}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            )}

            <div className="text-center pb-2">
              <button
                onClick={onClose}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-8 py-3 rounded-xl text-sm cursor-pointer transition"
              >
                বন্ধ করুন
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
