"use client";

import React, { useState, useEffect } from "react";
import { Submission } from "@/types/submission";
import { clearAllSubmissions, getAllSubmissions } from "@/actions/admin-actions";
import { Trash2, RotateCw, ChevronDown, ChevronUp, Eye } from "lucide-react";
import { toBengaliDigits } from "@/lib/utils";

export const SubmissionsTable: React.FC = () => {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const loadSubmissions = async () => {
    setIsLoading(true);
    try {
      const list = await getAllSubmissions();
      setSubmissions(list);
    } catch (err) {
      console.error("Load submissions error:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSubmissions();
  }, []);

  const handleClearAll = async () => {
    if (confirm("আপনি কি নিশ্চিতভাবে সকল পরীক্ষার্থীর ফলাফল মুছে ফেলতে চান?")) {
      await clearAllSubmissions();
      loadSubmissions();
      alert("সকল ফলাফল মুছে ফেলা হয়েছে।");
    }
  };

  const formatSubmitTime = (isoString?: string) => {
    if (!isoString) return "—";
    const d = new Date(isoString);
    let str = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return toBengaliDigits(str);
  };

  const calculateStartTime = (isoString?: string, timeSpentStr?: string) => {
    if (!isoString) return "—";
    const d = new Date(isoString);
    if (timeSpentStr) {
      const match = timeSpentStr.match(/(\d+)\s*মি\.\s*(\d+)\s*সে\./);
      if (match) {
        const mins = parseInt(match[1]);
        const secs = parseInt(match[2]);
        d.setSeconds(d.getSeconds() - (mins * 60 + secs));
      }
    }
    let str = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return toBengaliDigits(str);
  };

  const toggleExpand = (idx: number) => {
    setExpandedIdx(prev => prev === idx ? null : idx);
  };

  const formatAnswers = (answers: Submission["answers"]) => {
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

  return (
    <div className="space-y-4 font-bengali">
      <div className="flex justify-between items-center">
        <h3 className="font-bold text-slate-800 text-xs sm:text-sm">
          পরীক্ষার্থীদের জমা দেওয়া ফলাফল তালিকা ({toBengaliDigits(submissions.length)} জন)
        </h3>
        <div className="flex gap-2">
          <button
            onClick={loadSubmissions}
            className="text-xs text-indigo-600 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
          >
            <RotateCw className="w-3 h-3" /> রিফ্রেশ
          </button>
          <button
            onClick={handleClearAll}
            className="text-sm sm:text-xs text-rose-600 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" /> সকল মুছুন
          </button>
        </div>
      </div>

      <div className="overflow-x-auto bg-white rounded-2xl border border-slate-200 shadow-sm">
        <table className="w-full text-left border-collapse text-xs sm:text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-600 border-b border-slate-200">
              <th className="p-3 font-semibold w-8"></th>
              <th className="p-3 font-semibold">শিক্ষার্থী</th>
              <th className="p-3 font-semibold">পরীক্ষা</th>
              <th className="p-3 font-semibold text-center">সময়সূচি</th>
              <th className="p-3 font-semibold text-center">মোট সময়</th>
              <th className="p-3 font-semibold text-right">স্কোর</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-400">
                  <div className="flex flex-col items-center gap-2">
                    <RotateCw className="w-5 h-5 animate-spin text-indigo-400" />
                    <span>ফলাফল লোড হচ্ছে...</span>
                  </div>
                </td>
              </tr>
            ) : submissions.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-400">
                  কোনো ফলাফল জমা পড়েনি।
                </td>
              </tr>
            ) : (
              submissions.map((sub, idx) => {
                const isExpanded = expandedIdx === idx;
                const skipped = (sub.totalQuestions || 0) - ((sub.correct || 0) + (sub.incorrect || 0));
                
                return (
                  <React.Fragment key={idx}>
                    <tr 
                      className={`border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors ${isExpanded ? 'bg-indigo-50/30' : ''}`}
                      onClick={() => toggleExpand(idx)}
                    >
                      <td className="p-3 text-slate-400">
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-indigo-600" /> : <ChevronDown className="w-4 h-4" />}
                      </td>
                      <td className="p-3 font-semibold text-slate-800">
                        {sub.studentName}{" "}
                        <span className="text-slate-400 font-normal text-xs block sm:inline">({sub.studentId || "আইডি নেই"})</span>
                      </td>
                      <td className="p-3 text-slate-600">{sub.examTitle}</td>
                      <td className="p-3 text-center text-slate-500 text-[11px] whitespace-nowrap">
                        <span className="text-emerald-600 font-medium">শুরু: {calculateStartTime(sub.submittedAtISO, sub.timeSpent)}</span><br />
                        <span className="text-indigo-600 font-medium">জমা: {formatSubmitTime(sub.submittedAtISO)}</span>
                      </td>
                      <td className="p-3 text-center text-slate-500 font-mono text-[11px] font-bold">
                        {sub.timeSpent || "—"}
                      </td>
                      <td className="p-3 text-right font-black text-indigo-700 text-base">
                        {toBengaliDigits(sub.score ?? 0)}
                      </td>
                    </tr>
                    
                    {isExpanded && (
                      <tr className="bg-slate-50/80 border-b border-slate-200">
                        <td colSpan={6} className="p-4">
                          <div className="flex flex-col gap-3">
                            <div className="flex gap-4 p-3 bg-white rounded-xl border border-slate-200 text-xs shadow-sm w-fit">
                              <div className="flex flex-col items-center px-3 border-r border-slate-100">
                                <span className="text-slate-400 font-semibold mb-1">মোট প্রশ্ন</span>
                                <span className="font-bold text-slate-700">{toBengaliDigits(sub.totalQuestions || 0)}</span>
                              </div>
                              <div className="flex flex-col items-center px-3 border-r border-slate-100">
                                <span className="text-emerald-500 font-semibold mb-1">সঠিক</span>
                                <span className="font-bold text-emerald-700">{toBengaliDigits(sub.correct || 0)}</span>
                              </div>
                              <div className="flex flex-col items-center px-3 border-r border-slate-100">
                                <span className="text-rose-500 font-semibold mb-1">ভুল</span>
                                <span className="font-bold text-rose-700">{toBengaliDigits(sub.incorrect || 0)}</span>
                              </div>
                              <div className="flex flex-col items-center px-3">
                                <span className="text-slate-400 font-semibold mb-1">উত্তর দেয়নি</span>
                                <span className="font-bold text-slate-600">{toBengaliDigits(Math.max(0, skipped))}</span>
                              </div>
                            </div>
                            
                            <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                              <h4 className="text-[11px] font-bold text-slate-500 mb-2 flex items-center gap-1.5">
                                <Eye className="w-3.5 h-3.5" /> শিক্ষার্থীর দেওয়া উত্তরসমূহ:
                              </h4>
                              <div className="flex flex-wrap gap-1">
                                {formatAnswers(sub.answers)}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
