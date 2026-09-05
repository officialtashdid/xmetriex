"use client";

import React, { useState, useEffect } from "react";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import {
  Contact,
  Sparkles,
  ChevronRight,
  History,
  BarChart3,
  AlertOctagon,
  Bookmark,
  LogIn,
  LogOut
} from "lucide-react";
import { useRouter } from "next/navigation";
import { getLocalStudentUser, loginWithGoogle, logoutStudentUser } from "@/lib/student-auth";
import { WhatsAppJoinPopup } from "@/components/dashboard/WhatsAppJoinPopup";

/**
 * স্টুডেন্ট পোর্টাল — ওভারভিউ পেজ। প্রতিটা সেকশন (পরীক্ষার ফলাফল, বিশ্লেষণ,
 * ভুলের খাতা, বুকমার্ক) আলাদা পেজে খোলে (একই ট্যাবে নেভিগেশন) — সেখানে
 * বিস্তারিত দেখানো হয়। হোম পেজের পপআপ ড্যাশবোর্ড আগের মতোই আছে।
 */

const SECTIONS = [
  {
    key: "results",
    icon: History,
    title: "পরীক্ষার ফলাফল",
    desc: "স্কোর, মার্কশিট ও সমাধানসহ পরীক্ষার ইতিহাস — যেকোনো পরীক্ষায় ট্যাপ করে বিস্তারিত",
    tile: "from-violet-500 to-purple-600",
    chip: "bg-violet-100 text-violet-800 border-violet-200"
  },
  {
    key: "analytics",
    icon: BarChart3,
    title: "শক্তি ও দুর্বলতা বিশ্লেষণ",
    desc: "বিষয়ভিত্তিক অ্যাকুরেসি, স্মার্ট প্রস্তুতি পরামর্শ ও দুর্বল বিষয়ে অনুশীলন",
    tile: "from-indigo-500 to-blue-600",
    chip: "bg-indigo-100 text-indigo-800 border-indigo-200"
  },
  {
    key: "mistakes",
    icon: AlertOctagon,
    title: "ভুল উত্তরের খাতা",
    desc: "ভুল করা প্রশ্নগুলো স্বয়ংক্রিয়ভাবে জমা থাকে — রিভিশন, মুছুন বা আবার পরীক্ষা দিন",
    tile: "from-rose-500 to-pink-600",
    chip: "bg-rose-100 text-rose-800 border-rose-200"
  },
  {
    key: "bookmarks",
    icon: Bookmark,
    title: "বুকমার্কসমূহ",
    desc: "পছন্দের প্রশ্ন বুকমার্ক করে রাখুন — পরে রিভিশন ও অনুশীলনের জন্য",
    tile: "from-amber-500 to-orange-600",
    chip: "bg-amber-100 text-amber-800 border-amber-200"
  }
];

export default function PortalPage() {
  const router = useRouter();
  const [googleUser, setGoogleUser] = useState<{ uid: string; name: string; photoURL?: string } | null>(null);

  useEffect(() => {
    const isTeacherLoggedIn = sessionStorage.getItem("teacher_user");
    if (isTeacherLoggedIn) {
      alert("⚠️ আপনি শিক্ষক প্যানেলে লগইন করে আছেন। স্টুডেন্ট প্যানেলে প্রবেশ করতে চাইলে প্রথমে শিক্ষক প্যানেল থেকে লগআউট করুন।");
      router.replace("/admin");
      return;
    }
    setGoogleUser(getLocalStudentUser());
  }, [router]);

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle(undefined, "/portal");
    } catch (err) {
      console.error(err);
    }
  };

  // স্টুডেন্ট পোর্টালে ঢুকলেই (overview পেজে) লগআউট দেখা যাবে
  const handlePortalLogout = async () => {
    if (confirm("আপনি কি স্টুডেন্ট পোর্টাল থেকে লগআউট করতে চান?")) {
      try {
        await logoutStudentUser();
      } catch (err) {
        console.error(err);
      }
      // লোকাল পরিচয় মুছে গেলে পেজ রিফ্রেশ → লগইন-গেট আবার দেখায়
      window.location.href = "/portal";
    }
  };

  return (
    <>
      <Header onOpenStudentPortal={() => window.scrollTo({ top: 0, behavior: "smooth" })} />

      <main className="flex-grow max-w-5xl w-full mx-auto p-3 sm:p-5 md:p-6 font-bengali space-y-5">
        {/* Top banner */}
        <div className="relative bg-gradient-to-tr from-slate-900 via-slate-900 to-indigo-950 text-white rounded-3xl p-6 sm:p-8 text-center overflow-hidden shadow-sm border border-slate-800">
          <div className="absolute -top-10 -right-10 w-36 h-36 bg-indigo-400/10 rounded-full blur-xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-indigo-400/10 rounded-full blur-lg pointer-events-none" />

          <div className="relative inline-flex mb-3">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-amber-400 to-indigo-400 p-0.5 shadow-lg">
              <div className="w-full h-full bg-slate-900/90 rounded-[12px] flex items-center justify-center">
                <Contact className="w-7 h-7 text-amber-300" />
              </div>
            </div>
            <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-slate-950 text-[10px] font-black shadow">
              <Sparkles className="w-3 h-3" />
            </span>
          </div>

          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">স্টুডেন্ট পোর্টাল</h2>
          <p className="text-xs sm:text-sm text-indigo-200 mt-1 max-w-md mx-auto leading-relaxed">
            {googleUser
              ? `${googleUser.name} — সেকশন বেছে নিন, বিস্তারিত আলাদা পেজে খুলবে`
              : "আপনার পারফরম্যান্স ও পরীক্ষার ইতিহাস — সেকশন বেছে নিন"}
          </p>
        </div>

        {!googleUser && (
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm text-center space-y-5">
            <div className="space-y-2">
              <h3 className="text-base font-black text-slate-900">Google লগইন আবশ্যক</h3>
              <p className="text-xs sm:text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
                ফলাফল, পারফরম্যান্স বিশ্লেষণ, ভুল উত্তরের খাতা ও বুকমার্ক দেখতে
                <strong className="text-slate-700"> Google অ্যাকাউন্ট দিয়ে লগইন</strong> করুন।
                লগইনের পর আপনার রেকর্ড স্বয়ংক্রিয়ভাবে খুলে যাবে।
              </p>
            </div>

            <button
              type="button"
              onClick={handleGoogleLogin}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold py-3.5 px-8 rounded-2xl shadow-sm transition text-sm cursor-pointer"
            >
              <LogIn className="w-4 h-4" /> Google দিয়ে লগইন করুন
            </button>

            <p className="text-xs text-slate-400">
              💡 যে Google অ্যাকাউন্টে এনরোলমেন্ট নিবন্ধিত সেই অ্যাকাউন্ট দিয়েই লগইন করুন।
            </p>
          </div>
        )}

        {googleUser && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h3 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
                  আপনার পোর্টাল
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  সেকশনে ট্যাপ করলে বিস্তারিত আলাদা পেজে খুলবে
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] sm:text-xs font-bold text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full">
                  ৪টি সেকশন
                </span>
                <button
                  type="button"
                  onClick={handlePortalLogout}
                  className="inline-flex items-center gap-1.5 text-[11px] sm:text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 px-3 py-1.5 rounded-full transition cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" /> লগআউট
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {SECTIONS.map((sec) => {
                const Icon = sec.icon;
                return (
                  <button
                    key={sec.key}
                    type="button"
                    onClick={() => router.push(`/portal/${sec.key}`)}
                    className="w-full text-left bg-white rounded-3xl border border-slate-200 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all duration-200 p-4 sm:p-5 cursor-pointer group h-full active:scale-[0.995]"
                  >
                    <div className="flex items-start gap-3.5">
                      <div
                        className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${sec.tile} text-white flex items-center justify-center shadow-sm shrink-0 group-hover:scale-105 transition`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-black text-slate-900 text-sm sm:text-base leading-tight">
                          {sec.title}
                        </h4>
                        <p className="text-[11px] sm:text-xs text-slate-500 mt-1 leading-relaxed">{sec.desc}</p>
                      </div>
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded-lg bg-slate-100 text-slate-600 px-2 py-1 text-[10px] font-black group-hover:bg-indigo-600 group-hover:text-white transition">
                        খুলুন <ChevronRight className="w-3 h-3" />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3.5 sm:p-4 text-[11px] sm:text-xs font-semibold text-indigo-950 flex items-start gap-2">
              <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <span>
                প্রতিটা সেকশন আলাদা পেজে খোলে — সেখানে ট্যাব বদলে অন্য সেকশনেও যেতে পারবেন।
                ফিরে আসতে উপরের &ldquo;Student Portal&rdquo; বা পেজের &ldquo;← Student Portal&rdquo; বাটন ব্যবহার করুন।
              </span>
            </div>
          </>
        )}
      </main>

      <Footer />

      {/* লগইন-পর এনরোল্ড কোর্সের WhatsApp গ্রুপে জয়েন প্রম্পট (একবার) */}
      <WhatsAppJoinPopup />
    </>
  );
}
