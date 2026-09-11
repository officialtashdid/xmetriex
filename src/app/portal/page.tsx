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
  LogOut,
  User,
  Pencil
} from "lucide-react";
import { useRouter } from "next/navigation";
import { getLocalStudentUser, loginWithGoogle, logoutStudentUser, updateLocalStudentName } from "@/lib/student-auth";
import { updateStudentName } from "@/actions/student-actions";
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
  // নাম-পরিবর্তন — এখন পোর্টালে ঢুকতেই (overview পেজে) দেখা যায়
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    const isTeacherLoggedIn = sessionStorage.getItem("teacher_user");
    if (isTeacherLoggedIn) {
      alert("⚠️ আপনি শিক্ষক প্যানেলে লগইন করে আছেন। স্টুডেন্ট প্যানেলে প্রবেশ করতে চাইলে প্রথমে শিক্ষক প্যানেল থেকে লগআউট করুন।");
      router.replace("/admin");
      return;
    }
    const u = getLocalStudentUser();
    setGoogleUser(u);
    if (u) setNewName(u.name);
  }, [router]);

  const handleSaveName = async () => {
    if (!newName.trim() || !googleUser) return;
    setSavingName(true);
    try {
      const ok = await updateStudentName(googleUser.uid, newName.trim());
      if (ok) {
        const updated = updateLocalStudentName(newName.trim());
        setGoogleUser(updated || { ...googleUser, name: newName.trim() });
        setEditingName(false);
        alert("আপনার নাম সফলভাবে পরিবর্তন করা হয়েছে!");
      } else {
        alert("নাম পরিবর্তন করা যায়নি।");
      }
    } catch {
      alert("নাম পরিবর্তন করা যায়নি।");
    }
    setSavingName(false);
  };

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
        {/* Top banner — কম্প্যাক্ট (মোবাইলে ছোট, বড় লেখা নয়) */}
        <div className="relative bg-gradient-to-tr from-slate-900 via-slate-900 to-indigo-950 text-white rounded-2xl p-3.5 sm:p-5 overflow-hidden shadow-sm border border-slate-800">
          <div className="absolute -top-10 -right-10 w-36 h-36 bg-indigo-400/10 rounded-full blur-xl pointer-events-none" />
          <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-indigo-400/10 rounded-full blur-lg pointer-events-none" />

          <div className="relative flex items-center gap-3 min-w-0">
            <div className="relative inline-flex shrink-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-amber-400 to-indigo-400 p-0.5 shadow-md">
                <div className="w-full h-full bg-slate-900/90 rounded-[10px] flex items-center justify-center">
                  <Contact className="w-4 h-4 sm:w-5 sm:h-5 text-amber-300" />
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-black tracking-tight text-white leading-tight">
                স্টুডেন্ট পোর্টাল
              </h2>
              <p className="text-[11px] text-indigo-200 mt-0.5 leading-snug truncate">
                {googleUser
                  ? `${googleUser.name} — সেকশন বেছে নিন`
                  : "আপনার পারফরম্যান্স ও পরীক্ষার ইতিহাস"}
              </p>
            </div>
          </div>
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
            {/* নাম + নাম-পরিবর্তন — পোর্টালে ঢুকতেই দৃশ্যমান */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0 overflow-hidden">
                    {googleUser.photoURL ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={googleUser.photoURL} alt="Avatar" className="w-11 h-11 rounded-2xl object-cover" />
                    ) : (
                      <User className="w-5 h-5" />
                    )}
                  </div>
                  <div className="min-w-0">
                    {editingName ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={newName}
                          onChange={(e) => setNewName(e.target.value)}
                          placeholder="আপনার নাম লিখুন"
                          className="px-2.5 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-slate-900 font-bold"
                        />
                        <button
                          type="button"
                          onClick={handleSaveName}
                          disabled={savingName}
                          className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                        >
                          {savingName ? "সংরক্ষণ..." : "সংরক্ষণ"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingName(false);
                            setNewName(googleUser.name);
                          }}
                          className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold cursor-pointer"
                        >
                          বাতিল
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="font-black text-slate-900 text-sm sm:text-base truncate">
                          {googleUser.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setNewName(googleUser.name);
                            setEditingName(true);
                          }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1 rounded-lg transition cursor-pointer shrink-0"
                        >
                          <Pencil className="w-3 h-3" /> নাম পরিবর্তন
                        </button>
                      </div>
                    )}
                    <p className="text-[11px] text-slate-500 font-medium mt-0.5">
                      Google অ্যাকাউন্টে লগইন করা আছেন
                    </p>
                  </div>
                </div>
              </div>
            </div>

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
