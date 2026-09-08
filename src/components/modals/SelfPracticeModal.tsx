"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  X,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  Trophy,
  BookOpen,
  Zap,
  Check,
  AlertCircle,
  ListChecks,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Timer,
  Lock
} from "lucide-react";
import { PracticeQuestion } from "@/lib/practice-helper";
import { toBengaliDigits } from "@/lib/utils";

interface SelfPracticeModalProps {
  isOpen: boolean;
  onClose: () => void;
  questions: PracticeQuestion[];
  subjectName: string;
  mode: "instant" | "exam";
  onRestart: () => void;
  /** আলাদা উইন্ডো/পেজে পুরো-স্ক্রিন সেশন হিসেবে দেখালে true — ওভারলে ছাড়া পেজ-লেআউট। */
  standalone?: boolean;
}

const optLabels = ["ক", "খ", "গ", "ঘ"];

export const SelfPracticeModal: React.FC<SelfPracticeModalProps> = ({
  isOpen,
  onClose,
  questions,
  subjectName,
  mode,
  onRestart,
  standalone = false,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, number>>({});
  const [isFinished, setIsFinished] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(questions.length * 60);
  const [showReviewAfterExam, setShowReviewAfterExam] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const examDeadlineRef = useRef<number>(0);
  const [restartTick, setRestartTick] = useState(0);

  // Restart stability key (unchanged logic) — see prior implementation.
  const questionsKey = useMemo(
    () => questions.map((q) => q.id || q.q).join("|"),
    [questions]
  );

  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(0);
      setUserAnswers({});
      setIsFinished(false);
      setShowReviewAfterExam(false);
      setShowPalette(false);
      setSecondsRemaining(questions.length * 60);
      examDeadlineRef.current = Date.now() + questions.length * 60 * 1000;
    }
  }, [isOpen, questionsKey, restartTick]);

  // Exam mode timer — anchored to an absolute deadline (unchanged logic).
  useEffect(() => {
    if (!isOpen || isFinished || mode !== "exam") return;

    const timer = setInterval(() => {
      const remainingMs = examDeadlineRef.current - Date.now();
      const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
      setSecondsRemaining(remainingSecs);
      if (remainingMs <= 0) {
        clearInterval(timer);
        setIsFinished(true);
      }
    }, 500);

    return () => clearInterval(timer);
  }, [isOpen, isFinished, mode]);

  if (!isOpen) return null;

  if (questions.length === 0) {
    return (
      <div
        className={
          standalone
            ? "min-h-dvh w-full bg-gradient-to-b from-indigo-50/70 via-slate-50 to-violet-50/60 font-bengali flex items-center justify-center p-4"
            : "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm font-bengali"
        }
      >
        <div className="bg-white rounded-3xl p-6 max-w-md w-full text-center space-y-4 shadow-2xl">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto" />
          <h3 className="text-lg font-bold text-slate-900">প্রশ্ন পাওয়া যায়নি</h3>
          <p className="text-xs text-slate-500 leading-relaxed">
            এই বিষয়ে বর্তমানে কোনো প্রশ্ন যুক্ত নেই। অনুগ্রহ করে অন্য কোনো বিষয় নির্বাচন করুন।
          </p>
          <button
            onClick={onClose}
            className="w-full bg-slate-900 text-white font-bold py-2.5 rounded-xl text-xs"
          >
            বন্ধ করুন
          </button>
        </div>
      </div>
    );
  }

  const total = questions.length;
  const answeredCount = Object.keys(userAnswers).length;

  // Calculate results (unchanged)
  let correctCount = 0;
  let incorrectCount = 0;
  questions.forEach((q, idx) => {
    const ans = userAnswers[idx];
    if (ans !== undefined) {
      if (ans === q.correct) correctCount++;
      else incorrectCount++;
    }
  });
  const unansweredCount = total - (correctCount + incorrectCount);
  const score = correctCount * 1 - incorrectCount * 0.5;
  const accuracy = total > 0 ? Math.round((correctCount / total) * 100) : 0;

  const handleSelectOption = (qIdx: number, optIdx: number) => {
    // একটা উত্তর দাগালেই প্রশ্নটি লক হয়ে যায় (উভয় মুডে) — বদলানো যায় না
    if (userAnswers[qIdx] !== undefined) return;
    setUserAnswers((prev) => ({ ...prev, [qIdx]: optIdx }));
  };

  const goPrev = () => {
    if (currentIndex > 0) setCurrentIndex((prev) => prev - 1);
  };

  const goNext = () => {
    if (currentIndex < total - 1) {
      setCurrentIndex((prev) => prev + 1);
    } else if (mode === "instant") {
      setIsFinished(true);
    }
  };

  const jumpTo = (idx: number) => {
    if (idx >= 0 && idx < total) {
      setCurrentIndex(idx);
      setShowPalette(false);
    }
  };

  const handleFinishExam = () => {
    if (answeredCount < total) {
      if (!confirm(`আপনি ${toBengaliDigits(total)}টি প্রশ্নের মধ্যে ${toBengaliDigits(answeredCount)}টির উত্তর দিয়েছেন। আপনি কি পরীক্ষা জমা দিতে চান?`)) {
        return;
      }
    }
    setIsFinished(true);
  };

  const formatTimer = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${toBengaliDigits(m)}:${s < 10 ? "০" : ""}${toBengaliDigits(s)}`;
  };

  const currentQ = questions[currentIndex];
  const isCurrentAnswered = userAnswers[currentIndex] !== undefined;
  const progressPct = Math.round(((currentIndex + 1) / total) * 100);
  const isLowTime = mode === "exam" && secondsRemaining <= 30;

  const handleRestart = () => {
    setRestartTick((t) => t + 1);
    onRestart();
  };

  // আলাদা উইন্ডো/পেজ-সেশন বনাম মোডাল ওভারলে — লেআউট ক্লাস
  const rootCls = standalone
    ? "min-h-dvh w-full bg-gradient-to-b from-indigo-50/70 via-slate-50 to-violet-50/60 font-bengali p-2 sm:p-5"
    : "fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/70 backdrop-blur-sm font-bengali animate-in fade-in duration-200";

  const cardCls = standalone
    ? "bg-white rounded-3xl w-full max-w-4xl mx-auto flex flex-col shadow-2xl border border-slate-100 overflow-hidden h-[calc(100dvh-1rem)] sm:h-[calc(100dvh-2.5rem)]"
    : `bg-white rounded-3xl w-full flex flex-col shadow-2xl border border-slate-100 overflow-hidden ${
        mode === "exam" && !isFinished ? "max-w-4xl max-h-[95vh]" : "max-w-3xl max-h-[92vh]"
      }`;

  // ---------- প্রশ্ন-প্যালেট (দুটো মুডেই এক-প্রশ্ন নেভিগেশনের জন্য) ----------
  const renderPalette = () => (
    <div className="px-4 sm:px-6 py-3 border-b border-slate-100 bg-slate-50/80">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-black text-slate-600 flex items-center gap-1.5">
          <LayoutGrid className="w-3.5 h-3.5 text-indigo-600" /> প্রশ্নপত্র
        </span>
        <span className="text-[10px] font-bold text-slate-400">
          সবুজ = উত্তর দেওয়া • সাদা = বাকি
        </span>
      </div>
      <div className="grid grid-cols-6 sm:grid-cols-10 md:grid-cols-12 gap-1.5">
        {questions.map((_, qi) => {
          const done = userAnswers[qi] !== undefined;
          const isCurrent = qi === currentIndex;
          return (
            <button
              key={qi}
              type="button"
              onClick={() => jumpTo(qi)}
              className={`aspect-square rounded-lg text-xs font-black transition flex items-center justify-center cursor-pointer border ${
                isCurrent
                  ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white border-indigo-600 shadow-sm ring-2 ring-indigo-300"
                  : done
                  ? "bg-emerald-500 text-white border-emerald-500 hover:brightness-110"
                  : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300 hover:text-indigo-700"
              }`}
              title={`${toBengaliDigits(qi + 1)} নং প্রশ্ন`}
            >
              {toBengaliDigits(qi + 1)}
            </button>
          );
        })}
      </div>
    </div>
  );

  // ---------- প্রশ্ন কার্ড (দুটো মুডেই এক-প্রশ্ন) ----------
  const renderQuestionCard = () => (
    <div className="px-4 sm:px-6 py-3 overflow-y-auto flex-grow">
      {/* প্রগ্রেস */}
      <div className="mb-3 space-y-1">
        <div className="flex items-center justify-between text-[11px] text-slate-500 font-medium">
          <span>
            প্রশ্ন: <strong className="text-slate-900">{toBengaliDigits(currentIndex + 1)}</strong> / {toBengaliDigits(total)}
          </span>
          <span>
            উত্তর: <strong className="text-emerald-700">{toBengaliDigits(answeredCount)}</strong> • অগ্রগতি {toBengaliDigits(progressPct)}%
          </span>
        </div>
        <div className="w-full bg-slate-100 rounded-full h-1 overflow-hidden">
          <div
            className="bg-gradient-to-r from-indigo-500 to-violet-600 h-full rounded-full transition-all duration-300"
            style={{ width: `${((currentIndex + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      {/* প্রশ্ন */}
      <div className="bg-gradient-to-br from-indigo-50/80 to-violet-50/50 p-3.5 sm:p-4 rounded-2xl border border-indigo-100">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-indigo-700">
            <span className="w-6 h-6 rounded-lg bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center text-[11px]">
              {toBengaliDigits(currentIndex + 1)}
            </span>
            {currentQ.topic ? `টপিক: ${currentQ.topic}` : "প্রশ্ন"}
          </span>
          {isCurrentAnswered && (
            <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
              <CheckCircle2 className="w-3 h-3" /> উত্তর দেওয়া হয়েছে
            </span>
          )}
        </div>
        <h4 className="mt-1.5 text-[13px] sm:text-sm font-bold text-slate-900 leading-snug">
          {currentQ.q}
        </h4>
      </div>

      {/* অপশন */}
      <div className="mt-3 space-y-1.5">
        {currentQ.opts.map((opt, optIdx) => {
          const isSelected = userAnswers[currentIndex] === optIdx;
          const isCorrect = optIdx === currentQ.correct;

          let optStyle =
            "bg-white border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/40 text-slate-800";
          if (isCurrentAnswered) {
            if (isCorrect) optStyle = "bg-emerald-50 border-emerald-400 text-emerald-950 font-bold ring-1 ring-emerald-300";
            else if (isSelected) optStyle = "bg-rose-50 border-rose-400 text-rose-950 font-bold ring-1 ring-rose-300";
            else optStyle = "bg-slate-50/60 border-slate-200 text-slate-400 opacity-60";
          }

          return (
            <button
              key={optIdx}
              type="button"
              onClick={() => handleSelectOption(currentIndex, optIdx)}
              className={`w-full px-3 py-2 rounded-xl border text-left text-xs sm:text-[13px] transition flex items-center gap-2.5 cursor-pointer shadow-sm ${optStyle}`}
            >
              <span
                className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black border ${
                  isSelected && !isCorrect && isCurrentAnswered
                    ? "bg-rose-500 border-rose-500 text-white"
                    : isCurrentAnswered && isCorrect
                    ? "bg-emerald-500 border-emerald-500 text-white"
                    : "bg-slate-100 text-slate-700 border-slate-200"
                }`}
              >
                {optLabels[optIdx]}
              </span>
              <span className="flex-1 leading-snug">{opt}</span>
              {isCurrentAnswered && (isCorrect ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              ) : isSelected ? (
                <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
              ) : null)}
            </button>
          );
        })}
      </div>

      {/* Instant: ব্যাখ্যা */}
      {isCurrentAnswered && mode === "instant" && (
        <div className="mt-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200 space-y-1 animate-in fade-in duration-200">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-900">
            <HelpCircle className="w-3.5 h-3.5" />
            <span>
              সঠিক উত্তর: ({optLabels[currentQ.correct]}) {currentQ.opts[currentQ.correct]}
            </span>
          </div>
          {currentQ.exp && (
            <p className="text-[11px] text-slate-700 leading-relaxed pt-0.5">
              <strong>ব্যাখ্যা:</strong> {currentQ.exp}
            </p>
          )}
        </div>
      )}

      {/* মক মোড: নিচের ছোট নোট */}
      {mode === "exam" && (
        <p className="mt-2 text-[10px] text-slate-400 font-medium flex items-center gap-1.5">
          <Lock className="w-3 h-3 text-slate-400 shrink-0" /> উত্তর দেওয়া প্রশ্ন আর বদলানো যাবে না —
          প্যালেটে যেকোনো প্রশ্নে যেতে পারবেন।
        </p>
      )}
    </div>
  );

  // ---------- ফলাফল/রিভিউ ----------
  const renderResult = () => (
    <div className="p-5 sm:p-8 overflow-y-auto flex-grow text-center space-y-6">
      <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center mx-auto shadow-lg shadow-indigo-500/25">
        <Trophy className="w-8 h-8" />
      </div>

      <div className="space-y-1">
        <h3 className="text-lg sm:text-xl font-black text-slate-900">অনুশীলন সমাপ্ত হয়েছে! 🎉</h3>
        <p className="text-xs text-slate-500">
          বিষয়: <strong>{subjectName}</strong> • মোট প্রশ্ন: {toBengaliDigits(total)}টি
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 max-w-lg mx-auto text-xs">
        <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200">
          <span className="text-xs text-slate-500 block">মোট প্রশ্ন</span>
          <span className="text-base font-bold text-slate-900">{toBengaliDigits(total)}</span>
        </div>
        <div className="p-3 bg-emerald-50 rounded-2xl border border-emerald-200">
          <span className="text-xs text-emerald-700 block">সঠিক (+১)</span>
          <span className="text-base font-bold text-emerald-800">{toBengaliDigits(correctCount)}</span>
        </div>
        <div className="p-3 bg-rose-50 rounded-2xl border border-rose-200">
          <span className="text-xs text-rose-700 block">ভুল (-০.৫)</span>
          <span className="text-base font-bold text-rose-800">{toBengaliDigits(incorrectCount)}</span>
        </div>
        <div className="p-3 bg-indigo-50 rounded-2xl border border-indigo-200">
          <span className="text-xs text-indigo-700 block">মোট স্কোর</span>
          <span className="text-lg font-black text-indigo-900">{toBengaliDigits(score)}</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 flex-wrap">
        <span className="bg-slate-100 px-4 py-1.5 rounded-full text-xs font-semibold text-slate-700 border border-slate-200">
          অ্যাকুরেসি: <strong className="text-indigo-700">{toBengaliDigits(accuracy)}%</strong>
        </span>
        <button
          type="button"
          onClick={() => setShowReviewAfterExam((prev) => !prev)}
          className="bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 font-semibold px-4 py-1.5 rounded-full text-xs flex items-center gap-1.5 transition cursor-pointer"
        >
          <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
          <span>{showReviewAfterExam ? "উত্তরপত্র লুকান" : "উত্তরপত্র ও সমাধান দেখুন"}</span>
          {showReviewAfterExam ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {showReviewAfterExam && (
        <div className="text-left space-y-4 pt-4 border-t border-slate-200">
          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
            সকল প্রশ্নের সঠিক উত্তর ও ব্যাখ্যা:
          </h4>
          <div className="space-y-4">
            {questions.map((q, qIdx) => {
              const studentAns = userAnswers[qIdx];
              const isAnswered = studentAns !== undefined;
              const isCorrect = isAnswered && studentAns === q.correct;
              return (
                <div
                  key={qIdx}
                  className={`p-4 rounded-2xl border text-xs space-y-3 ${
                    !isAnswered
                      ? "bg-slate-50/80 border-slate-200"
                      : isCorrect
                      ? "bg-emerald-50/40 border-emerald-200"
                      : "bg-rose-50/40 border-rose-200"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-bold text-slate-900 text-xs sm:text-sm leading-relaxed">
                      {toBengaliDigits(qIdx + 1)}. {q.q}
                    </span>
                    {isCorrect ? (
                      <span className="bg-emerald-100 text-emerald-800 text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1 shrink-0">
                        <CheckCircle2 className="w-3 h-3" /> সঠিক
                      </span>
                    ) : isAnswered ? (
                      <span className="bg-rose-100 text-rose-800 text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1 shrink-0">
                        <XCircle className="w-3 h-3" /> ভুল
                      </span>
                    ) : (
                      <span className="bg-slate-200 text-slate-700 text-xs font-bold px-2 py-0.5 rounded shrink-0">ফাঁকা</span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs">
                    {q.opts.map((opt, optIdx) => {
                      const isOptCorrect = optIdx === q.correct;
                      const isOptChosen = studentAns === optIdx;
                      return (
                        <div
                          key={optIdx}
                          className={`p-2 rounded-lg border ${
                            isOptCorrect
                              ? "bg-emerald-100 border-emerald-300 text-emerald-950 font-bold"
                              : isOptChosen
                              ? "bg-rose-100 border-rose-300 text-rose-950 font-bold"
                              : "bg-white border-slate-200/80 text-slate-700"
                          }`}
                        >
                          ({optLabels[optIdx]}) {opt}
                        </div>
                      );
                    })}
                  </div>
                  {q.exp && (
                    <div className="p-3 bg-white/80 rounded-xl border border-slate-200 text-sm text-slate-600 leading-relaxed">
                      <strong>ব্যাখ্যা:</strong> {q.exp}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={rootCls}>
      <div className={cardCls}>
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-white/20 border border-white/20 flex items-center justify-center shrink-0">
              <Zap className="w-5 h-5 fill-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] sm:text-xs bg-white/20 text-white font-bold px-2 py-0.5 rounded-md border border-white/20">
                  {subjectName}
                </span>
                <span className="text-[10px] sm:text-xs bg-white/15 text-indigo-50 font-semibold px-2 py-0.5 rounded-md">
                  {mode === "instant" ? "ইনস্ট্যান্ট প্র্যাকটিস" : "মক টেস্ট"}
                </span>
              </div>
              <h3 className="text-xs sm:text-sm font-bold text-white/95 mt-0.5 truncate">সেলফ-প্র্যাকটিস সেশন</h3>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {mode === "exam" && !isFinished && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-bold text-white bg-white/15 border border-white/20 px-2.5 py-1 rounded-xl">
                  <ListChecks className="w-3.5 h-3.5 text-emerald-200" /> {toBengaliDigits(answeredCount)}/{toBengaliDigits(total)}
                </span>
                <div
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-xl font-mono font-bold ${
                    isLowTime ? "bg-rose-600 text-white animate-pulse" : "bg-white/20 text-white border border-white/20"
                  }`}
                >
                  <Timer className="w-3.5 h-3.5" />
                  <span>{formatTimer(secondsRemaining)}</span>
                </div>
              </div>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center transition cursor-pointer"
              aria-label="বন্ধ করুন"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        {!isFinished ? (
          <>
            {/* প্যালেট টগল বার */}
            <div className="px-4 sm:px-6 py-2 bg-white border-b border-slate-100 flex items-center justify-between shrink-0">
              <span className="text-[11px] font-bold text-slate-500">
                {mode === "instant"
                  ? "ইনস্ট্যান্ট — ক্লিক করলেই সঠিক উত্তর দেখাবে"
                  : "মক টেস্ট — শেষে স্কোরকার্ড"}
              </span>
              <button
                type="button"
                onClick={() => setShowPalette((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[11px] font-black text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-3 py-1.5 rounded-lg transition cursor-pointer"
              >
                <LayoutGrid className="w-3.5 h-3.5" /> প্রশ্নপত্র
                {showPalette ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            </div>

            {showPalette && renderPalette()}

            <div className="flex-1 overflow-y-auto">
              {renderQuestionCard()}
            </div>
          </>
        ) : (
          renderResult()
        )}

        {/* Footer Controls */}
        <div className="px-4 sm:px-6 py-3.5 border-t border-slate-100 bg-white flex items-center justify-between gap-3 shrink-0">
          {!isFinished ? (
            <>
              <button
                type="button"
                disabled={currentIndex === 0}
                onClick={goPrev}
                className={`px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                  currentIndex === 0
                    ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                }`}
              >
                <ArrowLeft className="w-3.5 h-3.5" /> <span className="hidden sm:inline">পূর্ববর্তী</span>
              </button>

              {mode === "exam" ? (
                <>
                  <span className="text-[11px] text-slate-400 hidden sm:block">
                    উত্তর দেওয়া হয়েছে {toBengaliDigits(answeredCount)}/{toBengaliDigits(total)}
                  </span>
                  {currentIndex === total - 1 ? (
                    <button
                      type="button"
                      onClick={handleFinishExam}
                      className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-bold px-5 py-2.5 rounded-xl text-xs shadow-sm transition flex items-center gap-1.5 cursor-pointer active:scale-[0.98]"
                    >
                      <Check className="w-4 h-4" /> পরীক্ষা জমা দিন
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={goNext}
                      className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-5 py-2.5 rounded-xl text-xs shadow-sm transition flex items-center gap-1.5 cursor-pointer active:scale-[0.98]"
                    >
                      পরবর্তী <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="hidden sm:block" />
                  <button
                    type="button"
                    onClick={goNext}
                    className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-bold px-5 py-2.5 rounded-xl text-xs shadow-sm transition flex items-center gap-1.5 cursor-pointer active:scale-[0.98]"
                  >
                    <span>{currentIndex === total - 1 ? "ফলাফল দেখুন" : "পরবর্তী"}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between w-full gap-2">
              <button
                type="button"
                onClick={handleRestart}
                className="bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" /> <span>আবার দিন</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-2.5 rounded-xl text-xs shadow-sm transition cursor-pointer"
              >
                সম্পন্ন
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
