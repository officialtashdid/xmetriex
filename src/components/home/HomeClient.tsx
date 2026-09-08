"use client";

import React, { useState, useEffect, useLayoutEffect } from "react";
import { GraduationCap } from "lucide-react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import { FreeModelTestsBox } from "@/components/dashboard/FreeModelTestsBox";

import { CourseCardGrid } from "@/components/dashboard/CourseCardGrid";
import { LiveExamsBox } from "@/components/dashboard/LiveExamsBox";
import { UpcomingExamsBox } from "@/components/dashboard/UpcomingExamsBox";
import { DailyNewsSection } from "@/components/dashboard/DailyNewsSection";
import { NewNewsPopup } from "@/components/dashboard/NewNewsPopup";
import { WhatsAppJoinPopup } from "@/components/dashboard/WhatsAppJoinPopup";
import { LandingPage } from "@/components/home/LandingPage";
import { AppConfigData, Exam } from "@/types/exam";
import { Submission } from "@/types/submission";
import { syncBangladeshNetworkTime } from "@/lib/bangladesh-time";
import { getLocalStudentUser } from "@/lib/student-auth";
import { getVerifiedStudent } from "@/lib/student-identity";
import type { DailyNewsItem } from "@/actions/news-actions";

// Lazy-load modals: their JS (~150KB total) only downloads when actually opened
const EnrollModal = dynamic(() => import("@/components/modals/EnrollModal").then((m) => m.EnrollModal), { ssr: false });
const StudentAuthModal = dynamic(() => import("@/components/modals/StudentAuthModal").then((m) => m.StudentAuthModal), { ssr: false });
const StudentPortalLoginModal = dynamic(() => import("@/components/modals/StudentPortalLoginModal").then((m) => m.StudentPortalLoginModal), { ssr: false });
const StudentDashboardModal = dynamic(() => import("@/components/modals/StudentDashboardModal").then((m) => m.StudentDashboardModal), { ssr: false });
const ExamDetailPopup = dynamic(() => import("@/components/modals/ExamDetailPopup").then((m) => m.ExamDetailPopup), { ssr: false });

// Detect a Google OAuth callback return: implicit-flow tokens in the URL hash
// (access_token/error) or a PKCE code in the query string.
const hasAuthTokensInUrl = () => {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  const search = window.location.search || "";
  return hash.includes("access_token") || hash.includes("error") || search.includes("code=");
};

export default function HomeClient({
  config,
  initialDailyNews
}: {
  config: AppConfigData;
  /** সার্ভার-সাইড রেন্ডার করা দৈনিক সংবাদ — ক্লায়েন্ট ফেচ ছাড়াই সাথে সাথে দেখাতে */
  initialDailyNews?: DailyNewsItem[];
}) {
  const router = useRouter();
  const [selectedExamKey, setSelectedExamKey] = useState(() => {
    const keys = Object.keys(config.exams || {});
    return keys[0] || "";
  });

  // Modals state
  const [isEnrollOpen, setIsEnrollOpen] = useState(false);
  const [selectedEnrollCourse, setSelectedEnrollCourse] = useState<string | undefined>(undefined);
  const [isStudentAuthOpen, setIsStudentAuthOpen] = useState(false);
  const [isStudentPortalLoginOpen, setIsStudentPortalLoginOpen] = useState(false);
  const [isStudentDashOpen, setIsStudentDashOpen] = useState(false);
  const [activePortalStudentId, setActivePortalStudentId] = useState("");
  const [selectedSubmissionForPopup, setSelectedSubmissionForPopup] = useState<Submission | null>(null);
  // True while this page is processing a Google OAuth callback (tokens in the URL)
  const [isAuthProcessing, setIsAuthProcessing] = useState(false);

  // ল্যান্ডিং-গেট: "loading" → "guest" (শুধু ল্যান্ডিং পেজ) / "user" (পুরো ড্যাশবোর্ড)
  const [gate, setGate] = useState<"loading" | "guest" | "user">("loading");

  useEffect(() => {
    // Redirect teacher to admin panel if logged in
    const isTeacherLoggedIn = sessionStorage.getItem("teacher_user");
    if (isTeacherLoggedIn) {
      router.replace("/admin");
      return;
    }

    // Start time sync without blocking UI
    syncBangladeshNetworkTime();
    const interval = setInterval(syncBangladeshNetworkTime, 60000);

    const localUser = getLocalStudentUser();
    if (localUser) {
      setActivePortalStudentId(localUser.uid);
    }

    return () => clearInterval(interval);
  }, [router]);

  // সাইড প্যানেল / প্র্যাকটিস / প্রশ্নব্যাংক থেকে "এনরোল" চাইলে হোমে এসে মোডাল খোলে
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("open_enroll")) {
      sessionStorage.removeItem("open_enroll");
      setIsEnrollOpen(true);
    }
  }, []);

  // Show the "লগইন হচ্ছে…" overlay immediately on an OAuth callback return, so the
  // user never sees a confusing flash of the home page while the session restores.
  useLayoutEffect(() => {
    if (hasAuthTokensInUrl()) setIsAuthProcessing(true);
  }, []);

  // Restore the Supabase session (OAuth callback tokens in the URL, or a previously
  // stored student/teacher session), then continue the post-login flow: an exam intent
  // (start the exam the student picked before login) or a generic return path (e.g. /portal).
  // The Supabase SDK is lazy-loaded ONLY when auth context exists, so anonymous visitors
  // never pay the ~180KB SDK cost.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const needsAuth =
        typeof window !== "undefined" &&
        (hasAuthTokensInUrl() ||
          !!localStorage.getItem("bcs_student_user") ||
          !!sessionStorage.getItem("teacher_user"));

      if (needsAuth) {
        try {
          await import("@/lib/supabase");

          // Resolve as soon as the session-restore callback persists the student user
          // (lib/supabase dispatches a manual "storage" event), with bounded polling fallback.
          await new Promise<void>((resolve) => {
            const deadline = Date.now() + 3000;
            let done = false;
            let timer: ReturnType<typeof setInterval>;
            let onStorage: () => void;
            const check = () => {
              if (done) return;
              if (getLocalStudentUser() || Date.now() > deadline) {
                done = true;
                clearInterval(timer);
                window.removeEventListener("storage", onStorage);
                resolve();
              }
            };
            onStorage = () => check();
            window.addEventListener("storage", onStorage);
            timer = setInterval(check, 120);
          });

          // Never leave OAuth tokens lingering in the URL (security + no stale reprocessing)
          if (typeof window !== "undefined" && (window.location.hash || window.location.search)) {
            const url = new URL(window.location.href);
            url.hash = "";
            url.searchParams.delete("code");
            url.searchParams.delete("error");
            url.searchParams.delete("error_description");
            history.replaceState({}, "", url);
          }
        } catch {
          // Auth restore failed — proceed with whatever user exists below
        }
      }

      if (cancelled || typeof window === "undefined") {
        setIsAuthProcessing(false);
        return;
      }

      // 1) Exam intent — start the exam the student chose before logging in
      const intentExamId = sessionStorage.getItem("target_exam_intent");
      if (config && intentExamId && config.exams?.[intentExamId]) {
        sessionStorage.removeItem("target_exam_intent");
        setIsAuthProcessing(false);
        // OAuth-ফেরতের পর স্টুডেন্ট-সেশন কয়েক মুহূর্তে localStorage-এ আসে —
        // রেডি হওয়া পর্যন্ত অপেক্ষা করি, তারপরই পরীক্ষা শুরু (হোমে আটকায় না)
        const waitForStudent = async (ms: number) => {
          const t0 = Date.now();
          while (Date.now() - t0 < ms) {
            const u = getLocalStudentUser();
            if (u) return u;
            await new Promise((r) => setTimeout(r, 300));
          }
          return null;
        };
        const readyUser = await waitForStudent(8000);
        if (readyUser) {
          handleStartExamByKey(intentExamId);
        } else {
          // সেশন আসেনি — লগইন মোডাল দেখাই (ইনটেন্ট ধরে রাখা হয়নি, আবার ক্লিক করবেন)
          setSelectedExamKey(intentExamId);
          setIsStudentAuthOpen(true);
        }
        return;
      }

      // 2) Generic return path — e.g. the student logged in from /portal
      const redirectPath = sessionStorage.getItem("auth_redirect");
      if (redirectPath && redirectPath.startsWith("/") && redirectPath !== "/") {
        sessionStorage.removeItem("auth_redirect");
        setIsAuthProcessing(false);
        router.replace(redirectPath);
        return;
      }

      setIsAuthProcessing(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const examsObj = config.exams || {};
  const coursesList = config.courses || ["সাধারণ কোর্স"];
  const subjectsList = config.subjects || [];
  const currentExam: Exam | undefined = examsObj[selectedExamKey];

  // দ্রুত শুরু: /exam রাউটগুলো আগে থেকেই প্রি-লোড — বাটনে চাপলেই পেজ খোলে
  useEffect(() => {
    const keys = Object.keys(examsObj);
    if (keys.length === 0) return;
    const t = setTimeout(() => {
      keys.slice(0, 25).forEach((k) => router.prefetch(`/exam/${encodeURIComponent(k)}`));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const handleStartExamByKey = async (examKey: string) => {
    const ex = examsObj[examKey];
    if (!ex) return;
    setSelectedExamKey(examKey);

    const localUser = getLocalStudentUser();

    // ফ্রি এক্সাম + লগইন থাকলে — কোনো অপেক্ষা নেই, সাথে সাথে পরীক্ষার পেজে
    if (ex.isFree && localUser) {
      sessionStorage.setItem(
        "current_student",
        JSON.stringify({ id: localUser.uid, name: localUser.name })
      );
      router.push(`/exam/${examKey}`);
      return;
    }

    if (localUser) {
      const { isExamCurrentlyLive } = await import("@/lib/bangladesh-time");
      const { checkAttemptBlocked } = await import("@/lib/exam-attempt-cache");

      if (isExamCurrentlyLive(ex)) {
        const already = await checkAttemptBlocked(examKey, localUser.uid);
        if (already) {
          alert("আপনি ইতিমধ্যে এই লাইভ পরীক্ষায় অংশগ্রহণ করেছেন! লাইভ চলাকালীন এক অ্যাকাউন্ট দিয়ে কেবল একবারই পরীক্ষা দেওয়া যাবে।");
          return;
        }
      }

      if (ex.isFree) {
        // Free exam: Start instantly without popup
        sessionStorage.setItem(
          "current_student",
          JSON.stringify({ id: localUser.uid, name: localUser.name })
        );
        router.push(`/exam/${examKey}`);
        return;
      } else {
        // Paid exam: Check authorization instantly
        const { verifyStudentAccess } = await import("@/actions/student-actions");
        const res = await verifyStudentAccess(localUser.uid, ex.course, localUser.email);
        if (res.allowed) {
          sessionStorage.setItem(
            "current_student",
            JSON.stringify({
              id: res.normalizedId || localUser.uid,
              name: res.studentName || localUser.name,
            })
          );
          router.push(`/exam/${examKey}`);
          return;
        }
      }
    }

    // If not logged in or paid verification required, show modal
    setIsStudentAuthOpen(true);
  };

  const handleStudentVerified = (student: { id: string; name: string }) => {
    setIsStudentAuthOpen(false);
    sessionStorage.setItem("current_student", JSON.stringify(student));
    router.push(`/exam/${selectedExamKey}`);
  };

  const handleOpenEnrollModal = (courseName?: string) => {
    setSelectedEnrollCourse(courseName);
    setIsEnrollOpen(true);
  };

  // OAuth restore শেষ হলেই সিদ্ধান্ত: শিক্ষক/লগইন করা শিক্ষার্থী → ড্যাশবোর্ড,
  // নাহলে (অতিথি) → শুধু ল্যান্ডিং পেজ (লগইন-গেট)
  useEffect(() => {
    if (isAuthProcessing) return; // OAuth restore চলাকালীন অপেক্ষা
    const id = window.setTimeout(() => {
      const isTeacherNow = !!sessionStorage.getItem("teacher_user");
      const isStudent = !!getLocalStudentUser();
      setGate(isTeacherNow || isStudent ? "user" : "guest");
    }, 0);
    return () => window.clearTimeout(id);
  }, [isAuthProcessing, config]);

  // ল্যান্ডিং পেজের "লগইন" বাটন — Google OAuth; ফিরে আসলে আবার হোম
  const handleLandingLogin = async () => {
    const { loginWithGoogle } = await import("@/lib/student-auth");
    await loginWithGoogle(undefined, "/");
  };

  const handleOpenStudentPortal = () => {
    // Student Portal একটি আলাদা পেজ (/portal) — popup-মডাল নয়। সেখানে
    // লগইন/ড্যাশবোর্ড পেজের ভেতরেই দেখায়।
    router.push("/portal");
  };

  const handleStudentPortalLoginSuccess = (id: string) => {
    setActivePortalStudentId(id);
    setIsStudentDashOpen(true);
  };

  // লগইন-গেট: অতিথি → শুধু ল্যান্ডিং পেজ (লগইন ছাড়া কনটেন্ট নয়)
  if (gate === "guest") {
    return (
      <LandingPage
        courses={coursesList}
        subjects={subjectsList}
        pinnedCourses={config.pinnedCourses || []}
        onLogin={handleLandingLogin}
      />
    );
  }

  // সিদ্ধান্ত নেওয়ার আগে / OAuth restore চলাকালীন — হালকা লোডিং স্প্ল্যাশ
  if (gate === "loading") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-950 text-white font-bengali flex flex-col items-center justify-center gap-4">
        <span className="bg-gradient-to-tr from-amber-400 to-indigo-500 p-2 rounded-2xl shadow-lg shadow-black/30">
          <GraduationCap className="w-6 h-6 text-slate-900" />
        </span>
        <p className="text-sm font-bold text-indigo-100">আরোহণ লোড হচ্ছে...</p>
        <span className="w-8 h-8 rounded-full border-4 border-indigo-300/30 border-t-amber-400 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <Header
        onOpenStudentPortal={handleOpenStudentPortal}
        onOpenLeaderboard={() => router.push(`/leaderboard/${selectedExamKey || "exam_01"}`)}
      />

      <main className="flex-grow max-w-6xl w-full mx-auto p-3 sm:p-5 md:p-6 space-y-6">

        {/* দৈনিক সংবাদ — সবার উপরে (পুরো প্রস্থ; ৩টা দেখা যায়, বাকিটা ভেতরে স্ক্রল) */}
        <DailyNewsSection initialNews={initialDailyNews} />

        {/* লাইভ এক্সাম — পূর্ণ-প্রস্থ বক্স; ভেতরে সব live সিরিয়ালি */}
        <LiveExamsBox
          exams={examsObj}
          onSelectLiveExam={handleStartExamByKey}
          onOpenEnrollModal={handleOpenEnrollModal}
        />

        {/* ফ্রি মডেল টেস্ট — আলাদা বক্স */}
        <FreeModelTestsBox
          exams={examsObj}
          onStartExam={handleStartExamByKey}
          onOpenEnrollModal={handleOpenEnrollModal}
        />

        {/* আসন্ন লাইভ এক্সাম — ১ বক্স; ট্যাপে উইন্ডোয় লাল কাউন্টডাউন */}
        <UpcomingExamsBox exams={examsObj} />

        {/* কোর্স ডিরেক্টরি — পুরো প্রস্থে (নাম যেন কাটা না যায়) */}
        <CourseCardGrid
          courses={coursesList}
          subjects={subjectsList}
          exams={examsObj}
          pinnedCourses={config.pinnedCourses || []}
          onOpenCourse={(course) => router.push(`/course/${encodeURIComponent(course)}`)}
          onOpenEnrollModal={handleOpenEnrollModal}
        />
      </main>

      <Footer />

      {/* নতুন সংবাদ এলে একবার পপআপ (হোম পেজে বা হোমে ফিরে এলে) */}
      <NewNewsPopup initialNews={initialDailyNews} />

      {/* লগইন-পর এনরোল্ড কোর্সের WhatsApp গ্রুপে জয়েন প্রম্পট (একবার) */}
      <WhatsAppJoinPopup />

      {/* Modals */}
      <EnrollModal
        isOpen={isEnrollOpen}
        courses={coursesList}
        initialCourse={selectedEnrollCourse}
        onClose={() => {
          setIsEnrollOpen(false);
          setSelectedEnrollCourse(undefined);
        }}
      />

      {currentExam && (
        <StudentAuthModal
          isOpen={isStudentAuthOpen}
          exam={currentExam}
          onClose={() => setIsStudentAuthOpen(false)}
          onVerified={handleStudentVerified}
        />
      )}

      <StudentPortalLoginModal
        isOpen={isStudentPortalLoginOpen}
        onClose={() => setIsStudentPortalLoginOpen(false)}
        onLoginSuccess={handleStudentPortalLoginSuccess}
        onOpenEnrollModal={() => handleOpenEnrollModal()}
      />

      <StudentDashboardModal
        isOpen={isStudentDashOpen}
        studentId={activePortalStudentId}
        exams={examsObj}
        config={config}
        routineUrl={config.driveRoutineUrl}
        syllabusUrl={config.driveSyllabusUrl}
        onClose={() => setIsStudentDashOpen(false)}
        onSelectSubmissionDetail={(sub) => setSelectedSubmissionForPopup(sub)}
      />

      <ExamDetailPopup
        isOpen={!!selectedSubmissionForPopup}
        submission={selectedSubmissionForPopup}
        exam={selectedSubmissionForPopup ? examsObj[selectedSubmissionForPopup.examKey] || null : null}
        onClose={() => setSelectedSubmissionForPopup(null)}
      />

      {/* Google OAuth callback in progress — keep the UI stable while the session restores */}
      {isAuthProcessing && (
        <div className="fixed inset-0 z-[70] bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center gap-4 font-bengali">
          <div className="w-11 h-11 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
          <p className="text-sm font-bold text-slate-800">লগইন হচ্ছে...</p>
          <p className="text-xs text-slate-500">এক মুহূর্ত অপেক্ষা করুন — পরীক্ষা স্বয়ংক্রিয়ভাবে শুরু হবে</p>
        </div>
      )}
    </>
  );
}
