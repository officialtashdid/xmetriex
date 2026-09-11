"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import { StudentDashboardModal } from "@/components/modals/StudentDashboardModal";
import { ExamDetailPopup } from "@/components/modals/ExamDetailPopup";
import { fetchAppConfigLite } from "@/actions/admin-actions";
import { AppConfigData } from "@/types/exam";
import { Submission } from "@/types/submission";
import {
  ChevronLeft,
  History,
  BarChart3,
  AlertOctagon,
  Bookmark,
  CircleAlert,
  LogIn,
  Loader2
} from "lucide-react";
import { getLocalStudentUser, loginWithGoogle } from "@/lib/student-auth";

/**
 * পোর্টালের একেকটি সেকশন — আলাদা পেজ (একই ট্যাবে)। /portal থেকে কার্ডে
 * ক্লিক করলে এখানে আসে: ফলাফল / বিশ্লেষণ / ভুলের খাতা / বুকমার্ক।
 * StudentDashboardModal embedded + wide-এ সেই সেকশনের ট্যাব খোলা থাকে;
 * ভেতরের ট্যাবে বদলে অন্য সেকশনেও যাওয়া যায়।
 */

type TabKey = "history" | "analytics" | "mistakes" | "bookmarks";

const SECTION_META: Record<
  string,
  { label: string; tab: TabKey; icon: React.ComponentType<{ className?: string }>; tile: string; desc: string }
> = {
  results: {
    label: "পরীক্ষার ফলাফল",
    tab: "history",
    icon: History,
    tile: "from-violet-500 to-purple-600",
    desc: "স্কোর, মার্কশিট ও সমাধানসহ আপনার পরীক্ষার ইতিহাস"
  },
  analytics: {
    label: "শক্তি ও দুর্বলতা বিশ্লেষণ",
    tab: "analytics",
    icon: BarChart3,
    tile: "from-indigo-500 to-blue-600",
    desc: "বিষয়ভিত্তিক অ্যাকুরেসি, স্মার্ট প্রস্তুতি পরামর্শ ও দুর্বল বিষয়ে অনুশীলন"
  },
  mistakes: {
    label: "ভুল উত্তরের খাতা",
    tab: "mistakes",
    icon: AlertOctagon,
    tile: "from-rose-500 to-pink-600",
    desc: "ভুল করা প্রশ্নগুলো রিভিশন, মুছুন বা আবার পরীক্ষা দিন"
  },
  bookmarks: {
    label: "বুকমার্কসমূহ",
    tab: "bookmarks",
    icon: Bookmark,
    tile: "from-amber-500 to-orange-600",
    desc: "পছন্দের প্রশ্ন — রিভিশন ও অনুশীলন"
  }
};

export default function PortalSectionPage() {
  const params = useParams();
  const router = useRouter();
  const raw = String(params?.section || "");
  const meta = SECTION_META[raw];

  const [googleUser, setGoogleUser] = useState<{ uid: string; name: string; photoURL?: string } | null>(null);
  const [config, setConfig] = useState<AppConfigData | null>(null);
  const [configError, setConfigError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  const [activeStudentId, setActiveStudentId] = useState("");
  const [selectedSub, setSelectedSub] = useState<Submission | null>(null);

  useEffect(() => {
    if (!meta) {
      router.replace("/portal");
      return;
    }
    const isTeacherLoggedIn = sessionStorage.getItem("teacher_user");
    if (isTeacherLoggedIn) {
      alert("⚠️ আপনি শিক্ষক প্যানেলে লগইন করে আছেন। স্টুডেন্ট প্যানেলে প্রবেশ করতে চাইলে প্রথমে শিক্ষক প্যানেল থেকে লগআউট করুন।");
      router.replace("/admin");
      return;
    }

    fetchAppConfigLite()
      .then(setConfig)
      .catch(() => {
        console.error("Portal section config fetch failed.");
        setConfigError("সার্ভার থেকে তথ্য লোড করা যায়নি। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।");
      });

    const gUser = getLocalStudentUser();
    if (gUser) {
      setGoogleUser(gUser);
      // আসল এনরোলমেন্ট-রেকর্ডের আইডি ব্যবহার করি (allowed_students-এ ফোন/uid যেটাই হোক):
      // পরীক্ষার সাবমিশন ও বিশ্লেষণ সেই আইডিতে সেভ হয়, তাই uid-এ খুঁজলে খালি দেখাত।
      (async () => {
        let effId = gUser.uid;
        try {
          const { verifyStudentAccess } = await import("@/actions/student-actions");
          let res = await verifyStudentAccess(gUser.uid, "ALL", gUser.email);
          // Google uid/email-এ এনরোলমেন্ট না মিললে আগে যাচাই-কৃত
          // (ফোন/ম্যানুয়াল) পরিচয় দিয়ে চেষ্টা
          if (!res.allowed) {
            const { getVerifiedStudent } = await import("@/lib/student-identity");
            const verified = getVerifiedStudent();
            if (verified && verified.id && verified.id !== gUser.uid) {
              const alt = await verifyStudentAccess(verified.id, "ALL", verified.email);
              if (alt.allowed) res = alt;
            }
          }
          if (res.allowed && res.normalizedId) effId = res.normalizedId;
        } catch {
          // verify ব্যর্থ হলে uid-ই থাকবে
        }
        setActiveStudentId(effId);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, configAttempt, meta]);

  if (!meta) return null;

  const Icon = meta.icon;

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle(undefined, `/portal/${raw}`);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <>
      <Header onOpenStudentPortal={() => router.push("/portal")} />

      <main className="flex-grow max-w-5xl w-full mx-auto p-3 sm:p-5 md:p-6 font-bengali space-y-5">
        {/* ব্যাক বার */}
        <button
          type="button"
          onClick={() => router.push("/portal")}
          className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" /> Student Portal-এ ফিরুন
        </button>

        {/* সেকশন ব্যানার */}
        <div className="relative bg-gradient-to-tr from-slate-900 via-slate-900 to-indigo-950 text-white rounded-3xl p-5 sm:p-7 overflow-hidden shadow-sm border border-slate-800">
          <div className="absolute -top-10 -right-10 w-36 h-36 bg-indigo-400/10 rounded-full blur-xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-indigo-400/10 rounded-full blur-lg pointer-events-none" />
          <div className="relative flex items-center gap-3.5">
            <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${meta.tile} text-white flex items-center justify-center shadow-lg shrink-0`}>
              <Icon className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-black leading-tight truncate">{meta.label}</h1>
              <p className="text-[11px] sm:text-xs text-indigo-200 mt-0.5 leading-relaxed">{meta.desc}</p>
            </div>
          </div>
        </div>

        {configError && (
          <div className="bg-white rounded-3xl p-5 border border-slate-200 shadow-sm space-y-3">
            <div className="bg-rose-50 border border-rose-200/80 text-rose-700 text-xs p-3.5 rounded-2xl flex items-start gap-2.5">
              <CircleAlert className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <p className="leading-snug">{configError}</p>
            </div>
            <button
              type="button"
              onClick={() => setConfigAttempt((n) => n + 1)}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-2xl text-sm cursor-pointer transition"
            >
              আবার চেষ্টা করুন
            </button>
          </div>
        )}

        {!configError && !googleUser && (
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm text-center space-y-5">
            <div className="space-y-2">
              <h3 className="text-base font-black text-slate-900">Google লগইন আবশ্যক</h3>
              <p className="text-xs sm:text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
                এই সেকশন দেখতে <strong className="text-slate-700">Google অ্যাকাউন্ট দিয়ে লগইন</strong> করুন।
                লগইনের পর আবার এই পেজেই ফিরে আসবেন।
              </p>
            </div>
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3.5 px-8 rounded-2xl text-sm cursor-pointer transition"
            >
              <LogIn className="w-4 h-4" /> Google দিয়ে লগইন করুন
            </button>
          </div>
        )}

        {!configError && googleUser && !activeStudentId && (
          <div className="flex items-center justify-center gap-2 py-10 text-slate-400 text-sm font-bold">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-600" /> ডেটা লোড হচ্ছে...
          </div>
        )}

        {!configError && googleUser && activeStudentId && (
          <StudentDashboardModal
            embedded
            wide
            isOpen
            initialTab={meta.tab}
            // সেকশন-পেজে ৪টি সেকশন-ট্যাব আর দেখাই না — শিক্ষার্থী একবার ট্যাপ করে
            // এই সেকশনে এসেছে, তাই এখানে আবার একই অপশনগুলো পুনরাবৃত্তি করা হয় না।
            // অন্য সেকশনে যেতে উপরের "← Student Portal-এ ফিরুন" দিয়েই ফিরবে।
            hideTabs
            studentId={activeStudentId}
            exams={config?.exams || {}}
            routineUrl={config?.driveRoutineUrl}
            syllabusUrl={config?.driveSyllabusUrl}
            onClose={() => {}}
            onSelectSubmissionDetail={(sub) => setSelectedSub(sub)}
          />
        )}

        {config && (
          <ExamDetailPopup
            isOpen={!!selectedSub}
            submission={selectedSub}
            exam={selectedSub ? config.exams?.[selectedSub.examKey] || null : null}
            onClose={() => setSelectedSub(null)}
          />
        )}
      </main>

      <Footer />
    </>
  );
}
