"use client";

import React from "react";
import { QuestionItem, QuestionSolution } from "@/types/exam";
import { toBengaliDigits } from "@/lib/utils";
import { BookmarkButton } from "@/components/shared/BookmarkButton";
import { MathText } from "@/lib/MathText";

interface ReviewCardProps {
  questions: QuestionItem[];
  solutions: QuestionSolution[];
  studentAnswers: any[]; // (number | null)[] OR { qid: string, ans: number | null }[]
}

export const ReviewCard: React.FC<ReviewCardProps> = ({
  questions,
  solutions,
  studentAnswers,
}) => {
  const isNewFormat = studentAnswers.length > 0 && typeof studentAnswers[0] === "object" && studentAnswers[0] !== null;
  const answerMap = new Map<string, number | null>();
  if (isNewFormat) {
    studentAnswers.forEach((a: any) => {
      let val = a.ans;
      if (val === -1) val = null;
      answerMap.set(a.qid, val);
    });
  }

  return (
    <div className="space-y-4 font-bengali">
      {questions.map((q, idx) => {
        let rawAns = isNewFormat ? (q.id && answerMap.has(q.id) ? answerMap.get(q.id) : null) : studentAnswers[idx];
        if (rawAns === -1 || rawAns === undefined) rawAns = null;
        const ans = rawAns as number | null;

        const sol = solutions[idx] || { correct: 0, exp: "" };
        const isCorrect = ans === sol.correct;
        const isSkipped = ans === null;

        const badgeClass = isSkipped
          ? "bg-slate-200 text-slate-700"
          : isCorrect
          ? "bg-emerald-100 text-emerald-800"
          : "bg-rose-100 text-rose-800";

        const badgeText = isSkipped ? "স্কিপড" : isCorrect ? "সঠিক" : "ভুল";

        return (
          <div
            key={idx}
            className="p-5 sm:p-6 rounded-3xl border border-slate-200 bg-white space-y-4 shadow-sm"
          >
            <div className="flex justify-between items-start gap-3 flex-wrap sm:flex-nowrap">
              <div className="space-y-1 flex-grow">
                <h4 className="font-bold text-base sm:text-lg text-slate-900 leading-relaxed">
                  {toBengaliDigits(idx + 1)}. <MathText text={q.q} />
                </h4>
                {q.topic && (
                  <span className="inline-block text-xs bg-indigo-50 text-indigo-700 font-semibold px-2.5 py-0.5 rounded-md border border-indigo-100">
                    টপিক: {q.topic}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <BookmarkButton
                  size="sm"
                  question={{
                    q: q.q,
                    opts: q.opts,
                    correct: sol.correct,
                    exp: sol.exp,
                    userAns: ans,
                    topic: q.topic
                  }}
                />
                <span className={`text-xs px-3 py-1 rounded-full font-bold uppercase shrink-0 ${badgeClass}`}>
                  {badgeText}
                </span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid gap-2">
                {q.opts.map((opt, i) => {
                  const isUserAns = ans === i;
                  const isCorrectAns = sol.correct === i;
                  
                  let optStyle = "border-slate-200 bg-white text-slate-700";
                  let icon = <div className="w-5 h-5 rounded-full border-2 border-slate-300 flex-shrink-0" />;

                  if (isCorrectAns) {
                    optStyle = "border-emerald-500 bg-emerald-50 text-emerald-800 font-medium ring-1 ring-emerald-500";
                    icon = (
                      <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    );
                  } else if (isUserAns && !isCorrectAns) {
                    optStyle = "border-rose-500 bg-rose-50 text-rose-800 font-medium ring-1 ring-rose-500";
                    icon = (
                      <div className="w-5 h-5 rounded-full bg-rose-500 flex items-center justify-center flex-shrink-0">
                        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </div>
                    );
                  } else if (isUserAns) {
                    // This won't actually be hit because if it's the user's answer and it's correct,
                    // it falls into the first `if (isCorrectAns)` branch. But just in case we wanted to separate it.
                  }

                  return (
                    <div key={i} className={`flex items-center gap-3 p-3.5 rounded-xl border ${optStyle}`}>
                      {icon}
                      <span className="text-sm sm:text-base font-medium flex-grow"><MathText text={opt} /></span>
                      {isUserAns && !isCorrectAns && (
                        <span className="text-[10px] sm:text-xs font-bold text-rose-600 bg-rose-100 px-2 py-0.5 rounded-md whitespace-nowrap">আপনার উত্তর</span>
                      )}
                      {isUserAns && isCorrectAns && (
                        <span className="text-[10px] sm:text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-md whitespace-nowrap">আপনার উত্তর</span>
                      )}
                    </div>
                  );
                })}
              </div>
              
              {isSkipped && (
                <div className="p-3 bg-slate-100 text-slate-600 font-medium rounded-xl text-center text-xs sm:text-sm border border-slate-200">
                  আপনি এই প্রশ্নের কোনো উত্তর দেননি
                </div>
              )}
            </div>

            {sol.exp && (
              <div className="text-sm sm:text-base text-slate-600 bg-indigo-50/50 p-4 sm:p-5 rounded-2xl border border-indigo-100 leading-relaxed whitespace-pre-wrap">
                <strong className="text-indigo-800 block mb-1">ব্যাখ্যা:</strong> <MathText text={sol.exp} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
