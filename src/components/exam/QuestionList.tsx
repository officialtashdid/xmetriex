"use client";

import React from "react";
import { QuestionItem } from "@/types/exam";
import { toBengaliDigits } from "@/lib/utils";
import { Check } from "lucide-react";

interface QuestionListProps {
  questions: QuestionItem[];
  studentAnswers: (number | null)[];
  onSelectOption: (questionIndex: number, optionIndex: number) => void;
}

const bengaliOptionLetters = ["ক", "খ", "গ", "ঘ"];

/**
 * প্রশ্ন তালিকা — প্রতিটি প্রশ্ন একটা আলাদা কার্ড (স্ক্রল-অ্যাংকর id-সহ যেন
 * প্রশ্ন-প্যালেট থেকে ট্যাপ করে সেখানে যাওয়া যায়)। নকশা: indigo থিম।
 */
export const QuestionList: React.FC<QuestionListProps> = ({
  questions,
  studentAnswers,
  onSelectOption,
}) => {
  return (
    <div className="space-y-4 font-bengali">
      {questions.map((q, qIdx) => {
        const hasAnswered = studentAnswers[qIdx] !== null;
        const answeredOpt = studentAnswers[qIdx];

        return (
          <article
            key={qIdx}
            id={`exam-q-${qIdx}`}
            className="scroll-mt-32 sm:scroll-mt-36 bg-white rounded-3xl border border-slate-200 shadow-sm p-4 sm:p-6 transition"
          >
            {/* প্রশ্ন শিরোনাম */}
            <div className="flex items-start gap-3">
              <span className="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center text-sm sm:text-base font-black shadow-md shadow-indigo-600/20">
                {toBengaliDigits(qIdx + 1)}
              </span>
              <h3 className="font-bold text-slate-900 text-base sm:text-lg leading-relaxed flex-1 min-w-0">
                {q.q}
              </h3>
              {hasAnswered && (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-black text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  <Check className="w-3 h-3" /> উত্তর দেওয়া
                </span>
              )}
            </div>

            {/* অপশন */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-4">
              {q.opts.map((opt, optIndex) => {
                const isSelected = studentAnswers[qIdx] === optIndex;
                const isOtherLocked = hasAnswered && !isSelected;

                return (
                  <button
                    key={optIndex}
                    onClick={() => onSelectOption(qIdx, optIndex)}
                    disabled={isOtherLocked}
                    className={`group relative p-3 sm:p-3.5 rounded-2xl text-left border transition flex items-center gap-3 cursor-pointer ${
                      isSelected
                        ? "bg-gradient-to-r from-indigo-600 to-violet-600 border-transparent text-white shadow-md shadow-indigo-600/25 ring-2 ring-indigo-300"
                        : "bg-white text-slate-800 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40"
                    } ${isOtherLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <span
                      className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-black transition ${
                        isSelected
                          ? "bg-white text-indigo-700"
                          : "bg-slate-100 text-slate-500 border border-slate-200 group-hover:bg-indigo-100 group-hover:text-indigo-700"
                      }`}
                    >
                      {bengaliOptionLetters[optIndex] || optIndex + 1}
                    </span>
                    <span className="text-sm sm:text-base font-medium leading-snug flex-1">{opt}</span>
                    {isSelected && (
                      <span className="shrink-0 w-5 h-5 rounded-full bg-white flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-indigo-700" strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
};
