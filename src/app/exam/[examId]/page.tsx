"use client";

import React, { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import { ExamTimer } from "@/components/exam/ExamTimer";
import { QuestionList } from "@/components/exam/QuestionList";
import { fetchExamWithQuestions, fetchExamForDemo } from "@/actions/admin-actions";
import { submitExamAnswers } from "@/actions/exam-actions";
import { getLocalStudentUser } from "@/lib/student-auth";
import { parseBangladeshDateTime, getTrueNowMs, isExamCurrentlyLive, syncBangladeshNetworkTime } from "@/lib/bangladesh-time";
import { Exam } from "@/types/exam";
import { CheckCheck, Loader2, X, AlertCircle, CheckCircle2, Send, RotateCcw, LogIn, Layers, ChevronDown } from "lucide-react";
import { toBengaliDigits } from "@/lib/utils";

// ---- রিফ্রেশ-রিজিউম (নিরাপদ ড্রাফট) ----
// শিক্ষার্থী ভুলে রিফ্রেশ/ট্যাব-ক্লোজ করলে উত্তর ও বাকি সময় হারায় না: পরীক্ষা
// শুরুর মুহূর্তে শেষ-সময় (absolute, true-time) আর উত্তর localStorage-এ সেভ হয়;
// আবার খুললে deadline না পেরোয় পর্যন্ত সেখান থেকে resume হয়। জমা সফল হলে মুছে যায়।
interface ExamDraft {
  answers: (number | null)[];
  deadlineMs: number; // getTrueNowMs()-ভিত্তিক পরম শেষ-মুহূর্ত
}
function draftKey(studentId: string, examId: string): string {
  return `bcs_exam_draft_${studentId}_${examId}`;
}
function loadDraft(studentId: string, examId: string): ExamDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(studentId, examId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.answers)) return null;
    return { answers: d.answers, deadlineMs: Number(d.deadlineMs) || 0 };
  } catch {
    return null;
  }
}
function saveDraft(studentId: string, examId: string, draft: ExamDraft): void {
  try {
    localStorage.setItem(draftKey(studentId, examId), JSON.stringify(draft));
  } catch {
    /* ignore (private mode) */
  }
}
function clearDraft(studentId: string, examId: string): void {
  try {
    localStorage.removeItem(draftKey(studentId, examId));
  } catch {
    /* ignore */
  }
}

export default function ExamPage() {
  const params = useParams();
  const router = useRouter();
  const examId = params.examId as string;

  const [exam, setExam] = useState<Exam | null>(null);
  const [student, setStudent] = useState<{ id: string; name: string } | null>(null);
  const [studentAnswers, setStudentAnswers] = useState<(number | null)[]>([]);
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  // ডেমো মোড (শিক্ষক টেস্ট) — কোনো ফলাফল সেভ হয় না
  const [demoMode, setDemoMode] = useState(false);
  const [demoResult, setDemoResult] = useState<{ correct: number; incorrect: number; skipped: number; total: number } | null>(null);
  // প্রশ্ন লোড হলেও টাইমার চালু হয় না — "পরীক্ষা শুরু করুন" ট্যাপে চালু হয়
  const [started, setStarted] = useState(false);
  // প্রশ্ন-প্যালেট (সব প্রশ্নের নম্বর) — মোবাইলে ভাঁজ করা থাকে
  const [paletteOpen, setPaletteOpen] = useState(true);
  // লগইন-ছাড়া লিংকে এলে — এই পেজেই লগইন প্রম্পট (হোমে পাঠানো হয় না)
  const [loginPrompt, setLoginPrompt] = useState(false);
  // রিফ্রেশ-রিজিউম: পরীক্ষার পরম শেষ-মুহূর্ত (true-time) — ড্রাফট-সেভে ব্যবহৃত
  const deadlineRef = useRef(0);

  useEffect(() => {
    const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";

    // ---- OAuth-কলব্যাক: লগইনের পর সরাসরি এই এক্সাম পেজেই ফেরত — সেশন কনজিউম ----
    if (!isDemo && typeof window !== "undefined") {
      const hash = window.location.hash || "";
      const search = window.location.search || "";
      const hasAuth = hash.includes("access_token") || hash.includes("error") || search.includes("code=");
      if (hasAuth && !sessionStorage.getItem("current_student")) {
        (async () => {
          try {
            // supabase লোড হলেই onAuthStateChange localStorage/cookie সেট করে
            await import("@/lib/supabase");
          } catch { /* ignore */ }
          const t0 = Date.now();
          while (Date.now() - t0 < 10000) {
            const u = getLocalStudentUser();
            if (u && u.uid) {
              sessionStorage.setItem("current_student", JSON.stringify({ id: u.uid, name: u.name }));
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          // URL থেকে OAuth টোকেন/কোড পরিষ্কার
          try {
            const url = new URL(window.location.href);
            url.hash = "";
            ["code", "state", "error", "error_description"].forEach((k) => url.searchParams.delete(k));
            window.history.replaceState({}, "", url.toString());
          } catch { /* ignore */ }
          window.location.reload();
        })();
        return;
      }
    }

    // ---- ডেমো মোড: শিক্ষক নিজে পরীক্ষাটি টেস্ট করেন (ফলাফল সেভ হয় না) ----
    if (isDemo) {
      if (!sessionStorage.getItem("teacher_user")) {
        alert("ডেমো পরীক্ষা শুধু শিক্ষক অ্যাকাউন্ট থেকে দেওয়া যায়। আগে শিক্ষক হিসেবে লগইন করুন।");
        router.push("/");
        return;
      }
      (async () => {
        try {
          import("@/lib/bangladesh-time").then(({ syncBangladeshNetworkTime }) => syncBangladeshNetworkTime());
          const ex = await fetchExamForDemo(examId);
          if (!ex) {
            alert("পরীক্ষাটি পাওয়া যায়নি (শিক্ষক-যাচাই ব্যর্থ বা প্রশ্ন নেই)।");
            router.push("/");
            return;
          }
          setDemoMode(true);
          setStudent({ id: "demo-teacher", name: "ডেমো (শিক্ষক)" });
          // ডেমোও এই পেজের ফ্লো — পুরোনো লিংক-ইনটেন্ট থাকলে মুছে দিই (হোমে ফিরে অটো-স্টার্ট যেন না হয়)
          try {
            sessionStorage.removeItem("target_exam_intent");
            sessionStorage.removeItem("auth_redirect");
          } catch { /* ignore */ }
          setExam(ex);
          setStudentAnswers(new Array(ex.questions?.length || 0).fill(null));
          // টাইমার "পরীক্ষা শুরু করুন" ট্যাপে beginExam()-এ চালু হবে
        } catch {
          alert("ডেমো পরীক্ষা শুরু করা যায়নি।");
          router.push("/");
        }
      })();
      return;
    }

    let rawStudent = sessionStorage.getItem("current_student");
    if (!rawStudent) {
      // লগইন করা শিক্ষার্থী থাকলে (localStorage) — হোমে না পাঠিয়ে সরাসরি পরীক্ষা
      const localUser = getLocalStudentUser();
      if (localUser && localUser.uid) {
        rawStudent = JSON.stringify({ id: localUser.uid, name: localUser.name });
        sessionStorage.setItem("current_student", rawStudent);
      } else {
        // শেয়ার করা লিংক — লগইন-ছাড়া: এই পেজেই লগইন প্রম্পট (হোমে নয়)
        try {
          sessionStorage.setItem("target_exam_intent", examId);
          sessionStorage.setItem("auth_redirect", `/exam/${examId}`);
        } catch { /* ignore */ }
        setLoginPrompt(true);
        return;
      }
    }
    let parsedStudent: { id: string; name: string } | null = null;
    try {
      parsedStudent = JSON.parse(rawStudent);
    } catch {
      // corrupted session data — restart the flow
    }
    if (!parsedStudent || typeof parsedStudent.id !== "string" || !parsedStudent.id) {
      const localUser = getLocalStudentUser();
      if (localUser && localUser.uid) {
        parsedStudent = { id: localUser.uid, name: localUser.name };
        sessionStorage.setItem("current_student", JSON.stringify(parsedStudent));
      } else {
        try {
          sessionStorage.setItem("target_exam_intent", examId);
          sessionStorage.setItem("auth_redirect", `/exam/${examId}`);
        } catch { /* ignore */ }
        setLoginPrompt(true);
        return;
      }
    }
    setStudent(parsedStudent);

    // লিংক/লগইন-ফ্লোর ইনটেন্ট-কী এখন পূরণ হয়েছে — সেশন নিশ্চিত হওয়া মাত্র মুছে দিই।
    // না মুছলে সাবমিটের পর হোমে ফিরলে HomeClient আবার পরীক্ষা অটো-স্টার্ট করত।
    try {
      sessionStorage.removeItem("target_exam_intent");
      sessionStorage.removeItem("auth_redirect");
    } catch { /* ignore */ }

    // Deep links skip the home page where time sync normally runs — sync here
    // too so the countdown never silently falls back to the tamperable device
    // clock.
    import("@/lib/bangladesh-time").then(({ syncBangladeshNetworkTime }) => {
      syncBangladeshNetworkTime();
    });

    fetchExamWithQuestions(examId).then(async (ex) => {
      if (!ex) {
        // fetchExamWithQuestions returns null when there is no verified session
        // (or, for paid exams, no enrollment). Tell the student which case it is
        // instead of a generic "not found".
        try {
          const { ensureExamSession } = await import("@/actions/exam-actions");
          const sess = await ensureExamSession();
          if (!sess.session) {
            alert("পরীক্ষা দেওয়ার জন্য Google লগইন প্রয়োজন। অনুগ্রহ করে হোম পেজ থেকে লগইন করুন।");
          } else {
            alert("এই পরীক্ষাটিতে অংশগ্রহণের অনুমতি নেই (এনরোলমেন্ট যাচাই করা যায়নি)।");
          }
        } catch {
          alert("পরীক্ষা পাওয়া যায়নি।");
        }
        router.push("/");
        return;
      }

      // Pre-check if already submitted during live period
      // (ফাস্ট-পাথ: ব্রাউজার ক্যাশে থাকলে সাথে সাথে ব্লক; নাহলে সার্ভার চেক — লজিক অপরিবর্তিত)
      if (isExamCurrentlyLive(ex)) {
        const { checkAttemptBlocked } = await import("@/lib/exam-attempt-cache");
        const already = await checkAttemptBlocked(examId, parsedStudent.id);
        if (already) {
          alert("আপনি ইতিমধ্যে এই লাইভ পরীক্ষায় অংশগ্রহণ করেছেন! লাইভ চলাকালীন এক অ্যাকাউন্ট দিয়ে কেবল একবারই পরীক্ষা দেওয়া যাবে।");
          router.push("/");
          return;
        }
      }

      // Block starting a SCHEDULED exam before its start time — the exam hall
      // opens only during the live window (post-window "practice" attempts are
      // still allowed by design).
      if (ex.startTime) {
        const startTime = parseBangladeshDateTime(ex.startTime);
        if (startTime && getTrueNowMs() < startTime.getTime()) {
          alert("এই পরীক্ষাটি এখনো শুরু হয়নি। নির্ধারিত সময়ে আবার চেষ্টা করুন।");
          router.push("/");
          return;
        }
      }

      // রিফ্রেশ-রিজিউম: শিক্ষার্থী আগে শুরু করে রিফ্রেশ করলে উত্তর ও বাকি সময় ফিরিয়ে দিই
      // (জমা-সফল হলে ড্রাফট মুছে যায়, তাই জমা-পর আর resume হয় না — নিরাপদ)।
      const qCount = ex.questions?.length || 0;
      const draft = !demoMode ? loadDraft(parsedStudent.id, examId) : null;
      const draftValid =
        draft &&
        draft.deadlineMs > getTrueNowMs() &&
        draft.answers &&
        draft.answers.length === qCount;

      if (draftValid && qCount > 0) {
        const remainingSecs = Math.max(1, Math.ceil((draft!.deadlineMs - getTrueNowMs()) / 1000));
        deadlineRef.current = draft!.deadlineMs;
        setExam(ex);
        setStudentAnswers(draft!.answers as (number | null)[]);
        setSecondsRemaining(remainingSecs);
        setStarted(true);
        return;
      }

      setExam(ex);
      setStudentAnswers(new Array(qCount).fill(null));
      // টাইমার এখনো চালু নয় — "পরীক্ষা শুরু করুন" ট্যাপ করলে beginExam()-এ চালু হবে
    });
  }, [examId, router]);

  const handleSelectOption = (qIdx: number, optIdx: number) => {
    if (studentAnswers[qIdx] !== null) return;
    const next = [...studentAnswers];
    next[qIdx] = optIdx;
    setStudentAnswers(next);
    // রিফ্রেশ-রিজিউম: প্রতিটি উত্তরে ড্রাফট হালনাগাদ (deadline অপরিবর্তিত)
    if (started && !demoMode && student && deadlineRef.current > 0) {
      saveDraft(student.id, examId, { answers: next, deadlineMs: deadlineRef.current });
    }
  };

  // ---- "পরীক্ষা শুরু করুন" ট্যাপ: টাইমার এখানেই চালু হয় (প্রশ্ন আগেই লোড) ----
  const beginExam = async () => {
    if (!exam || started || secondsRemaining !== null) return;
    // ডিভাইস ঘড়ি নয় — বাংলাদেশ (নেটওয়ার্ক-সিঙ্কড) সময়ে হিসাব নিশ্চিত করি
    try { await syncBangladeshNetworkTime(); } catch { /* fallback */ }
    let duration = (exam.timerMinutes || 10) * 60;
    if (!demoMode && isExamCurrentlyLive(exam) && exam.endTime) {
      const endTime = parseBangladeshDateTime(exam.endTime);
      if (endTime) {
        const remainingLiveSecs = Math.floor((endTime.getTime() - getTrueNowMs()) / 1000);
        if (remainingLiveSecs > 0) duration = Math.min(duration, remainingLiveSecs);
      }
    }
    setSecondsRemaining(Math.max(1, duration));
    setStarted(true);
    // রিফ্রেশ-রিজিউম: পরম শেষ-মুহূর্ত ও (শুরুতে) উত্তর সংরক্ষণ
    deadlineRef.current = getTrueNowMs() + duration * 1000;
    if (!demoMode && student) {
      saveDraft(student.id, examId, {
        answers: studentAnswers,
        deadlineMs: deadlineRef.current
      });
    }
  };

  const doSubmit = async (timeRemaining: number) => {
    if (isSubmitting || !exam || !student) return;
    setIsSubmitting(true);

    // ---- ডেমো: লোকালি স্কোর করি — কোথাও সেভ হয় না ----
    if (demoMode) {
      const qs = exam.questions || [];
      let correct = 0;
      let incorrect = 0;
      let skipped = 0;
      studentAnswers.forEach((a, i) => {
        const q = qs[i];
        if (a === null || a === undefined) skipped++;
        else if (q && a === Number((q as { correct?: number }).correct ?? 0)) correct++;
        else incorrect++;
      });
      setDemoResult({ correct, incorrect, skipped, total: qs.length });
      setIsSubmitting(false);
      return;
    }

    const res = await submitExamAnswers({
      studentName: student.name,
      studentId: student.id,
      examKey: examId,
      examTitle: exam.title,
      examTimerMinutes: exam.timerMinutes,
      timeRemaining: timeRemaining,
      answers: studentAnswers,
      totalQuestions: exam.questions?.length || 0,
    });

    setIsSubmitting(false);

    const timeSpentSecs = (exam.timerMinutes || 10) * 60 - timeRemaining;
    const mins = Math.floor(timeSpentSecs / 60);
    const secs = timeSpentSecs % 60;
    const timeFormatted = `${mins} মি. ${secs} সে.`;

    if (res.success) {
      // জমা সফল — রিফ্রেশ-রিজিউম ড্রাফট মুছে দিই (পরের ভিজিটে resume যেন না হয়)
      try {
        clearDraft(student.id, examId);
        deadlineRef.current = 0;
      } catch {
        /* ignore */
      }
      // একবার সাবমিশন সফল — ক্যাশে চিহ্নিত রাখি যেন পরের চেষ্টায় সাথে সাথে ওয়ার্নিং আসে
      try {
        const { markExamAttempted } = await import("@/lib/exam-attempt-cache");
        markExamAttempted(student.id, examId);
      } catch {
        // cache optional — সার্ভার চেকই চূড়ান্ত
      }
      sessionStorage.setItem(
        "last_result",
        JSON.stringify({
          examKey: examId,
          examTitle: exam.title,
          studentName: student.name,
          studentId: student.id,
          isLive: res.isLive,
          isLiveSubmission: res.isLiveSubmission,
          score: res.score,
          correct: res.correct,
          incorrect: res.incorrect,
          timeSpent: timeFormatted,
          totalQuestions: exam.questions?.length || 0,
          answers: studentAnswers,
        })
      );
      router.push(`/exam/${examId}/result`);
    } else {
      alert(res.message || "উত্তরপত্র জমা দিতে সমস্যা হয়েছে। আবার চেষ্টা করুন।");
    }
  };

  const handleManualSubmit = () => {
    if (isSubmitting) return;
    setIsConfirmModalOpen(true);
  };

  const handleConfirmSubmit = () => {
    setIsConfirmModalOpen(false);
    doSubmit(secondsRemaining ?? 0);
  };

  const handleAutoSubmit = () => {
    if (isSubmitting) return;
    setIsConfirmModalOpen(false);
    alert("পরীক্ষার নির্ধারিত সময় সমাপ্ত হয়েছে! আপনার উত্তরপত্র জমা দেওয়া হচ্ছে।");
    doSubmit(0);
  };

  // ---- লগইন-প্রম্পটের বাটন: OAuth শেষে এই এক্সাম পেজেই ফেরত (হোমে নয়) ----
  const handleExamLogin = async () => {
    try {
      sessionStorage.setItem("target_exam_intent", examId);
      const { supabase } = await import("@/lib/supabase");
      await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/exam/${examId}`
        }
      });
    } catch {
      /* রিডাইরেক্ট না হলে fallback */
      const { loginWithGoogle } = await import("@/lib/student-auth");
      await loginWithGoogle(examId, `/exam/${examId}`);
    }
  };

  // ---- লগইন-ছাড়া লিংকে এলে — এই পেজেই লগইন প্রম্পট ----
  if (loginPrompt) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 p-4 font-bengali">
        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 sm:p-8 space-y-5 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center mx-auto">
            <LogIn className="w-8 h-8" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-black text-slate-900">পরীক্ষা দিতে চাইলে লগইন করুন</h1>
            <p className="text-xs text-slate-500 font-bold leading-relaxed">
              Google দিয়ে লগইন করলেই এই পরীক্ষাটি <b>এই পেজেই শুরু হয়ে যাবে</b> — হোম পেজে যেতে হবে না।
            </p>
          </div>
          <button
            type="button"
            onClick={handleExamLogin}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 rounded-xl text-sm transition shadow-lg shadow-indigo-600/25 cursor-pointer flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" /> Google দিয়ে লগইন করুন
          </button>
          <p className="text-[10px] text-slate-400 font-bold">
            🔒 শুধু লগইন করা শিক্ষার্থীরাই প্রশ্ন দেখতে পাবে — নিরাপদ
          </p>
        </div>
      </main>
    );
  }

  if (!exam || !student) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 p-4 font-bengali">
        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 sm:p-8 space-y-5 text-center">
          <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center mx-auto animate-pulse">
            <Loader2 className="w-9 h-9 animate-spin" />
          </div>
          <div>
            <h1 className="text-xl font-black text-slate-900">প্রশ্ন লোড হচ্ছে…</h1>
            <p className="text-xs text-slate-500 font-bold mt-1.5 leading-relaxed">
              আপনার পরীক্ষার প্রশ্নগুলো নিরাপদে সার্ভার থেকে আনা হচ্ছে — এক মুহূর্ত ধৈর্য ধরুন।
            </p>
          </div>
          <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-3.5 space-y-2 text-left">
            {[
              "শিরোনাম, সময় ও প্রশ্ন যাচাই হচ্ছে",
              "আপনার অ্যাকাউন্টের অনুমতি নিশ্চিত হচ্ছে",
              "প্রশ্ন প্রস্তুত হলে টাইমার শুরু হবে"
            ].map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] text-slate-600 font-bold">
                <span className="w-4 h-4 rounded-full bg-indigo-600 text-white text-[9px] flex items-center justify-center shrink-0">
                  {toBengaliDigits(i + 1)}
                </span>
                {step}
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 font-bold">
            🔒 প্রশ্ন সুরক্ষিত — যাচাইকৃত সেশনে প্রশ্ন আসে, অন্যদের কাছে দেখা যায় না
          </p>
        </div>
      </div>
    );
  }

  // ---- প্রশ্ন প্রস্তুত — "পরীক্ষা শুরু করুন" গেট (টাইমার তখনই চালু হয়) ----
  if (!started || secondsRemaining === null) {
    const totalQ = exam.questions?.length || 0;
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 p-4 font-bengali relative overflow-hidden">
        {/* অলংকার */}
        <div className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 bg-amber-400/20 rounded-full blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-24 w-72 h-72 bg-indigo-400/20 rounded-full blur-3xl" />

        <div className="relative w-full max-w-md">
          {/* কার্ড */}
          <div className="bg-white/95 backdrop-blur rounded-3xl shadow-2xl shadow-black/30 overflow-hidden">
            <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-5 text-center relative">
              <div className="pointer-events-none absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,#fff,transparent_60%)]" />
              <div className="relative inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/15 border border-white/30 shadow-inner">
                <CheckCircle2 className="w-9 h-9 text-amber-300" />
              </div>
              <h1 className="mt-3 text-xl sm:text-2xl font-black text-white leading-tight">{exam.title}</h1>
              <p className="text-[11px] sm:text-xs text-indigo-100 font-bold mt-1">
                {exam.course} · {exam.subject}
              </p>
            </div>

            <div className="p-5 sm:p-6 space-y-4">
              {/* মেট্রিক্স */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { l: "প্রশ্ন", v: toBengaliDigits(totalQ), c: "text-indigo-700" },
                  { l: "সময়", v: `${toBengaliDigits(exam.timerMinutes)} মি`, c: "text-amber-600" },
                  { l: "ধরন", v: exam.isFree ? "ফ্রি" : "প্রিমিয়াম", c: "text-emerald-600" }
                ].map((s) => (
                  <div key={s.l} className="bg-slate-50 border border-slate-200 rounded-2xl p-2.5 text-center">
                    <div className={`text-base font-black ${s.c}`}>{s.v}</div>
                    <div className="text-[10px] text-slate-400 font-bold mt-0.5">{s.l}</div>
                  </div>
                ))}
              </div>

              {demoMode && (
                <div className="bg-violet-50 border border-violet-200 text-violet-900 text-[11px] font-bold rounded-xl px-3 py-2.5 text-center">
                  🧪 ডেমো মোড — শিক্ষক টেস্ট: ফলাফল সেভ হবে না
                </div>
              )}

              <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3.5 space-y-2">
                {[
                  "প্রশ্ন লোড সম্পন্ন হয়েছে",
                  "শুরুর বাটনে ট্যাপ করলেই টাইমার চালু হবে",
                  "সময় শেষ হলে উত্তরপত্র স্বয়ংক্রিয় জমা হবে"
                ].map((line, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] text-slate-700 font-bold">
                    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white text-[9px] flex items-center justify-center shrink-0">
                      {toBengaliDigits(i + 1)}
                    </span>
                    {line}
                  </div>
                ))}
              </div>

              {totalQ === 0 ? (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs font-bold rounded-xl px-3 py-2.5 text-center">
                  ⚠️ এই পরীক্ষায় এখনো কোনো প্রশ্ন যোগ করা হয়নি।
                </div>
              ) : (
                <button
                  type="button"
                  onClick={beginExam}
                  disabled={isSubmitting}
                  className="w-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-black py-4 rounded-2xl text-sm transition-all shadow-lg shadow-indigo-600/30 cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2 active:scale-[0.99]"
                >
                  <Send className="w-4 h-4" /> পরীক্ষা শুরু করুন
                </button>
              )}

              <p className="text-[10px] text-slate-400 font-bold leading-relaxed text-center">
                🔒 প্রশ্ন নিরাপদে লোড হয়েছে — ট্যাপের পরই টাইমার চলবে
                {!demoMode && isExamCurrentlyLive(exam) && exam.endTime ? " (লাইভ শেষ হওয়া পর্যন্ত সময় সীমিত)" : ""}
              </p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ---- ডেমো ফলাফল স্ক্রিন (শিক্ষক টেস্ট — সেভ হয় না) ----
  if (demoResult) {
    const pct = demoResult.total > 0 ? Math.round((demoResult.correct / demoResult.total) * 100) : 0;
    const passed = exam.passMark ? demoResult.correct >= exam.passMark : pct >= 40;
    return (
      <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 p-4 font-bengali">
        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 sm:p-8 space-y-5">
          <div className="text-center space-y-2">
            <div className={`w-16 h-16 rounded-2xl mx-auto flex items-center justify-center ${passed ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"}`}>
              {passed ? <CheckCircle2 className="w-9 h-9" /> : <X className="w-9 h-9" />}
            </div>
            <h1 className="text-xl font-black text-slate-900">🧪 ডেমো ফলাফল</h1>
            <p className="text-xs text-slate-500 font-bold leading-relaxed">{exam.title}</p>
          </div>

          <div className="bg-violet-50 border border-violet-200 text-violet-900 text-[11px] font-bold rounded-xl px-3 py-2.5 leading-relaxed">
            ⚠️ এটি <b>ডেমো (শিক্ষক টেস্ট)</b> — কোনো ফলাফল সেভ হয়নি, লিডারবোর্ডে প্রভাব নেই।
          </div>

          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              { l: "সঠিক", v: demoResult.correct, c: "text-emerald-700" },
              { l: "ভুল", v: demoResult.incorrect, c: "text-rose-700" },
              { l: "বাদ", v: demoResult.skipped, c: "text-amber-700" },
              { l: "মোট", v: demoResult.total, c: "text-slate-900" }
            ].map((s) => (
              <div key={s.l} className="bg-slate-50 border border-slate-200 rounded-2xl p-2.5">
                <div className={`text-xl font-black ${s.c}`}>{toBengaliDigits(s.v)}</div>
                <div className="text-[10px] text-slate-500 font-bold mt-0.5">{s.l}</div>
              </div>
            ))}
          </div>

          <div className="text-center">
            <div className="text-2xl font-black text-indigo-700">{toBengaliDigits(pct)}%</div>
            <p className="text-[11px] text-slate-500 font-bold">
              {passed ? "✅ উত্তীর্ণ হবে (পাস-মার্কের উপরে)" : "পাস-মার্কের নিচে"}
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setDemoResult(null);
                setStudentAnswers(new Array(exam.questions?.length || 0).fill(null));
                setSecondsRemaining(Math.max(1, (exam.timerMinutes || 10) * 60));
              }}
              className="w-full bg-violet-600 hover:bg-violet-700 text-white font-bold py-3 rounded-xl text-sm transition shadow-md cursor-pointer flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" /> আবার ডেমো দিন
            </button>
            <button
              type="button"
              onClick={() => router.push("/admin")}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 rounded-xl text-sm transition cursor-pointer"
            >
              শিক্ষক প্যানেলে ফিরুন
            </button>
          </div>
        </div>
      </main>
    );
  }

  const totalQuestions = exam.questions?.length || 0;
  const answeredCount = studentAnswers.filter((a) => a !== null).length;
  const unansweredCount = totalQuestions - answeredCount;

  return (
    <>
      {/* অ্যাম্বিয়েন্ট গ্রেডিয়েন্ট ব্যাকড্রপ */}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-b from-indigo-50 via-white to-violet-50" />

      {/* ===== স্টিকি হেডার: প্রগ্রেস + টাইমার + সাবমিট ===== */}
      <header className="sticky top-0 z-40 bg-gradient-to-r from-slate-900 via-indigo-950 to-violet-950 text-white shadow-lg shadow-indigo-950/20 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-3 sm:px-5 py-2.5 sm:py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <h1 className="truncate font-black text-sm sm:text-base text-white/95 leading-tight">{exam.title}</h1>
            </div>
            {/* প্রগ্রেস বার */}
            <div className="mt-1.5 flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-emerald-300 transition-all duration-300"
                  style={{ width: `${totalQuestions ? (answeredCount / totalQuestions) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] sm:text-[11px] font-black text-white/80 whitespace-nowrap">
                {toBengaliDigits(answeredCount)}/{toBengaliDigits(totalQuestions)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <ExamTimer
              initialSeconds={secondsRemaining}
              onTimeExpire={handleAutoSubmit}
              onTimeUpdate={(s) => setSecondsRemaining(s)}
            />
            <button
              onClick={handleManualSubmit}
              disabled={isSubmitting}
              className="hidden sm:inline-flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-black px-4 py-2.5 rounded-2xl transition-all shadow-md hover:shadow-lg cursor-pointer disabled:opacity-50 active:scale-95 whitespace-nowrap"
            >
              <Send className="w-4 h-4" /> জমা দিন
            </button>
          </div>
        </div>

        {/* মোবাইল জমা-বাটন */}
        <div className="sm:hidden px-3 pb-2 flex gap-2">
          <button
            onClick={handleManualSubmit}
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-black py-2.5 rounded-xl transition cursor-pointer disabled:opacity-50"
          >
            <Send className="w-4 h-4" /> {isSubmitting ? "জমা হচ্ছে..." : "পরীক্ষা জমা দিন"}
          </button>
        </div>
      </header>

      {/* ===== মূল প্রশ্ন-এলাকা: ডেস্কটপে ২ কলাম ===== */}
      <main className="flex-grow max-w-6xl w-full mx-auto p-3 sm:p-5 md:p-6 font-bengali">
        {demoMode && (
          <div className="mb-4 rounded-2xl bg-violet-100 border border-violet-300 text-violet-900 text-xs sm:text-sm font-black px-4 py-2.5 flex items-center gap-2">
            🧪 ডেমো মোড — শিক্ষক টেস্ট: ফলাফল সেভ হবে না, লিডারবোর্ডে প্রভাব নেই
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] gap-5 items-start">
          {/* বাম: প্রশ্ন তালিকা */}
          <div className="min-w-0 space-y-4">
            <QuestionList
              questions={exam.questions || []}
              studentAnswers={studentAnswers}
              onSelectOption={handleSelectOption}
            />

            <div className="flex justify-end pt-1">
              <button
                onClick={handleManualSubmit}
                disabled={isSubmitting}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-black px-8 py-3.5 rounded-2xl text-sm transition shadow-lg shadow-indigo-600/25 cursor-pointer disabled:opacity-50"
              >
                <CheckCheck className="w-5 h-5" />
                {isSubmitting ? "জমা হচ্ছে..." : "পরীক্ষা জমা দিন (Submit)"}
              </button>
            </div>
          </div>

          {/* ডান: প্রশ্ন-প্যালেট (স্টিকি) */}
          <aside className="lg:sticky lg:top-24 rounded-3xl bg-white border border-slate-200 shadow-sm overflow-hidden font-bengali">
            <button
              type="button"
              onClick={() => setPaletteOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-4 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 text-white cursor-pointer"
            >
              <span className="flex items-center gap-2 text-sm font-black">
                <Layers className="w-4 h-4" /> প্রশ্নপত্র
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${paletteOpen ? "" : "rotate-180"}`} />
            </button>

            {paletteOpen && (
              <div className="p-3.5 space-y-3">
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-600">
                    <span className="w-3 h-3 rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 inline-block" /> উত্তর
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-black text-slate-400">
                    <span className="w-3 h-3 rounded-md border-2 border-slate-300 bg-white inline-block" /> বাকি
                  </div>
                </div>

                <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-5 gap-1.5">
                  {Array.from({ length: totalQuestions }).map((_, i) => {
                    const done = studentAnswers[i] !== null;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          document.getElementById(`exam-q-${i}`)?.scrollIntoView({
                            behavior: "smooth",
                            block: "start"
                          });
                        }}
                        className={`aspect-square rounded-xl text-xs font-black transition flex items-center justify-center cursor-pointer ${
                          done
                            ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm hover:brightness-110"
                            : "bg-slate-50 text-slate-500 border border-slate-200 hover:border-indigo-300 hover:text-indigo-700"
                        }`}
                        title={`${toBengaliDigits(i + 1)} নং প্রশ্ন`}
                      >
                        {toBengaliDigits(i + 1)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>

      {/* Beautiful & Simple Submit Confirmation Popup */}
      {isConfirmModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 font-bengali animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-md w-full overflow-hidden shadow-2xl border border-slate-100 relative">
            {/* gradient হেডার */}
            <div className="relative bg-gradient-to-r from-indigo-600 to-violet-600 px-6 py-5">
              <div className="pointer-events-none absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top_right,#fff,transparent_60%)]" />
              <button
                onClick={() => setIsConfirmModalOpen(false)}
                className="absolute top-3.5 right-3.5 z-20 w-8 h-8 rounded-full bg-white/20 hover:bg-white/35 text-white flex items-center justify-center transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="relative flex items-center gap-3">
                <div
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
                    unansweredCount > 0
                      ? "bg-amber-400/90 text-amber-950"
                      : "bg-emerald-400 text-emerald-950"
                  }`}
                >
                  {unansweredCount > 0 ? (
                    <AlertCircle className="w-6 h-6" />
                  ) : (
                    <CheckCircle2 className="w-6 h-6" />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-black text-white leading-tight">পরীক্ষা জমা দিতে চান?</h3>
                  <p className="text-xs text-indigo-100 font-bold mt-0.5">
                    {unansweredCount > 0
                      ? `আপনার এখনও ${toBengaliDigits(unansweredCount)} টি প্রশ্নের উত্তর দেওয়া বাকি আছে`
                      : "আপনি সকল প্রশ্নের উত্তর দিয়েছেন"}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6 space-y-4">
              {/* Status Summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-3 text-center">
                  <span className="text-xs text-slate-500 block">মোট প্রশ্ন</span>
                  <span className="text-lg font-black text-slate-800">{toBengaliDigits(totalQuestions)}</span>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-3 text-center">
                  <span className="text-xs text-emerald-700 block">উত্তর দেওয়া</span>
                  <span className="text-lg font-black text-emerald-700">{toBengaliDigits(answeredCount)}</span>
                </div>
                <div
                  className={`rounded-2xl p-3 text-center border ${
                    unansweredCount > 0
                      ? "bg-amber-50 border-amber-200"
                      : "bg-slate-50 border-slate-100"
                  }`}
                >
                  <span className={`text-xs block ${unansweredCount > 0 ? "text-amber-700" : "text-slate-400"}`}>বাকি আছে</span>
                  <span
                    className={`text-lg font-black ${unansweredCount > 0 ? "text-amber-700" : "text-slate-400"}`}
                  >
                    {toBengaliDigits(unansweredCount)}
                  </span>
                </div>
              </div>

              <p className="text-[11px] text-slate-500 font-medium text-center leading-relaxed">
                জমা দিলে আর উত্তর পরিবর্তন করা যাবে না। নিশ্চিত হলে জমা দিন।
              </p>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleConfirmSubmit}
                  disabled={isSubmitting}
                  className="flex-1 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-black py-3 rounded-2xl transition text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-md shadow-indigo-600/25 cursor-pointer disabled:opacity-50 active:scale-[0.99]"
                >
                  <Send className="w-4 h-4" />
                  {isSubmitting ? "জমা হচ্ছে..." : "হ্যাঁ, জমা দিন"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirmModalOpen(false)}
                  className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 px-4 rounded-2xl transition text-xs sm:text-sm cursor-pointer"
                >
                  পরীক্ষায় ফিরে যান
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Footer />
    </>
  );
}
