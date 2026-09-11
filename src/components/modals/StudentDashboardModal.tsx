"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";
import {
  X,
  GraduationCap,
  History,
  ChevronRight,
  Calendar,
  FileText,
  Lock,
  Loader2,
  Bookmark,
  AlertOctagon,
  Trash2,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Play,
  Edit3,
  Save,
  LogOut
} from "lucide-react";
import { getStudentSubmissions, updateStudentName } from "@/actions/student-actions";
import { Submission } from "@/types/submission";
import { toBengaliDigits, shuffleArray } from "@/lib/utils";
import { isAnswerTimeReached } from "@/lib/bangladesh-time";
import { Exam } from "@/types/exam";
import {
  getStudentMistakes,
  getStudentBookmarks,
  removeStudentMistake,
  clearAllStudentMistakes,
  toggleQuestionBookmark,
  syncStudentMistakeData,
  MistakeQuestionItem
} from "@/lib/mistake-bookmark-store";
import {
  calculateStudentAnalytics,
  StudentAnalyticsResult
} from "@/lib/student-analytics";
import { SelfPracticeModal } from "@/components/modals/SelfPracticeModal";
import { LoadingState } from "@/components/shared/LoadingState";
import { PracticeQuestion } from "@/lib/practice-helper";
import { getPracticeQuestions } from "@/actions/practice-actions";
import { getLocalStudentUser, updateLocalStudentName, logoutStudentUser, StudentUser } from "@/lib/student-auth";
import { AppConfigData } from "@/types/exam";
import {
  BarChart3,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  Sparkles as SparklesIcon
} from "lucide-react";

type TabKey = "history" | "analytics" | "mistakes" | "bookmarks";

interface StudentDashboardModalProps {
  isOpen: boolean;
  /** Popup না — আলাদা পেজে (embedded) রেন্ডার হলে true দিন: ব্যাকড্রপ/ফিক্সড
      ওভারলে ছাড়া সাধারণ কার্ড হিসেবে দেখায়, পেজ স্ক্রল স্বাভাবিক থাকে। */
  embedded?: boolean;
  /** embedded-মোডে কার্ড আরও চওড়া হবে (পোর্টালের সেকশন-পেজে বিস্তারিত দেখাতে)। */
  wide?: boolean;
  /** কোন ট্যাব সিলেক্ট করে খুলবে (ডিফল্ট: history)। */
  initialTab?: TabKey;
  /** সত্য হলে উপরের ৪টি সেকশন ট্যাব (Navigation Tabs) দেখানো হবে না — শুধু
      initialTab-এর নির্দিষ্ট সেকশনের কনটেন্ট দেখায়। /portal/results-এ ৪টি
      সেকশন আবার না দেখানোর জন্য ব্যবহৃত হয়। */
  hideTabs?: boolean;
  studentId: string;
  exams: Record<string, Exam>;
  config?: AppConfigData;
  routineUrl?: string;
  syllabusUrl?: string;
  onClose: () => void;
  onSelectSubmissionDetail: (submission: Submission) => void;
}

export const StudentDashboardModal: React.FC<StudentDashboardModalProps> = ({
  isOpen,
  embedded = false,
  wide = false,
  initialTab,
  hideTabs = false,
  studentId,
  exams,
  routineUrl = "https://drive.google.com",
  syllabusUrl = "https://drive.google.com",
  onClose,
  onSelectSubmissionDetail,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab ?? "history");
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [mistakes, setMistakes] = useState<MistakeQuestionItem[]>([]);
  const [bookmarks, setBookmarks] = useState<MistakeQuestionItem[]>([]);
  const [analytics, setAnalytics] = useState<StudentAnalyticsResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [studentCourses, setStudentCourses] = useState<string[]>([]);

  // Re-quiz modal state
  const [isQuizModalOpen, setIsQuizModalOpen] = useState(false);
  const [quizQuestions, setQuizQuestions] = useState<PracticeQuestion[]>([]);
  const [quizTitle, setQuizTitle] = useState("");

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [studentUser, setStudentUser] = useState<StudentUser | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  // हज़ारো mistake/bookmark থাকলেও DOM-এ একসাথে সব না এনে পেজ-আকারে দেখাই
  const MISTAKE_PAGE_SIZE = 40;
  const [visibleMistakes, setVisibleMistakes] = useState(MISTAKE_PAGE_SIZE);
  const [visibleBookmarks, setVisibleBookmarks] = useState(MISTAKE_PAGE_SIZE);
  const shownMistakes = mistakes.slice(0, visibleMistakes);
  const shownBookmarks = bookmarks.slice(0, visibleBookmarks);

  const refreshStores = () => {
    if (studentId) {
      setMistakes(getStudentMistakes(studentId));
      setBookmarks(getStudentBookmarks(studentId));
    }
  };

  useEffect(() => {
    if (isOpen && studentId) {
      setIsLoading(true);
      setAccessDenied(false);
      const localUser = getLocalStudentUser();
      setStudentUser(localUser);
      if (localUser) {
        setNewName(localUser.name);
      }

      // Check enrollment (কোনো কোর্স এনরোল্ড কিনা) — একটি rejection-ও যেন
      // ড্যাশবোর্ড স্পিনারে আটকে না রাখে
      // (ফাস্ট-পাথ: প্রথমবার সার্ভার চেক → ক্যাশ; পরের বার localStorage থেকেই)
      import("@/lib/access-cache")
        .then(({ checkEnrollmentCached }) =>
          checkEnrollmentCached(studentId, localUser?.email).then((res) => {
            setStudentCourses(res.courses || []);
          })
        )
        .catch(() => setIsLoading(false));

      // Submission history — a network failure clears the loading state (and any
      // stale analytics) and shows the empty state; it is NOT an access denial.
      getStudentSubmissions(studentId)
        .then(async (data) => {
          if (data === null) {
            // Not authorized to view these records (no matching login session)
            setAccessDenied(true);
            setSubmissions([]);
            setAnalytics(null);
            setIsLoading(false);
            return;
          }
          setSubmissions(data);
          const analyticsRes = await calculateStudentAnalytics(data, exams);
          setAnalytics(analyticsRes);
          setIsLoading(false);
        })
        .catch(() => {
          setSubmissions([]);
          setAnalytics(null);
          setIsLoading(false);
        });
      refreshStores();
      setVisibleMistakes(MISTAKE_PAGE_SIZE);
      setVisibleBookmarks(MISTAKE_PAGE_SIZE);
      // Cross-device sync: সার্ভার থেকে পূর্ণ mistakes/bookmarks নামিয়ে UI-তে
      // দেখাও — localStorage-এ শুধু ফাস্ট-ক্যাশ, বাকি সব ডেটাবেজ থেকে আসে
      // (সেশন নেই/টেবিল নেই/ত্রুটি হলে নীরব — লোকাল ডেটাই থেকে যায়)
      syncStudentMistakeData(studentId)
        .then((res) => {
          if (res) {
            setMistakes(res.mistakes);
            setBookmarks(res.bookmarks);
          } else {
            refreshStores();
          }
        })
        .catch(() => refreshStores());
    }
  }, [isOpen, studentId, exams]);

  const handleSaveName = async () => {
    if (!newName.trim() || !studentUser) return;
    setIsLoading(true);
    const success = await updateStudentName(studentUser.uid, newName.trim());
    setIsLoading(false);
    if (success) {
      const updated = updateLocalStudentName(newName.trim());
      setStudentUser(updated);
      setEditingName(false);
      alert("আপনার নাম সফলভাবে পরিবর্তন করা হয়েছে!");
    } else {
      alert("নাম পরিবর্তন করা যায়নি।");
    }
  };

  const handleLogout = async () => {
    if (confirm("আপনি কি স্টুডেন্ট পোর্টাল থেকে লগআউট করতে চান?")) {
      await logoutStudentUser();
      onClose();
      window.location.reload();
    }
  };

  if (!isOpen) return null;

  const releasedSubs = submissions.filter((s) => {
    const ex = exams[s.examKey];
    return ex ? isAnswerTimeReached(ex) : true;
  });

  let bestScore = 0;
  let totalScore = 0;
  let totalAccSum = 0;

  releasedSubs.forEach((s) => {
    const sc = typeof s.score === "number" ? s.score : parseFloat(s.score as any) || 0;
    if (sc > bestScore) bestScore = sc;
    totalScore += sc;
    const acc = s.totalQuestions ? (s.correct / s.totalQuestions) * 100 : 0;
    totalAccSum += isNaN(acc) ? 0 : acc;
  });

  const avgScore = releasedSubs.length > 0 ? (totalScore / releasedSubs.length).toFixed(1) : "০";
  const avgAcc = releasedSubs.length > 0 ? Math.round(totalAccSum / releasedSubs.length) : 0;
  const optLabels = ["ক", "খ", "গ", "ঘ"];

  // Launch Re-test quiz
  const handleStartMistakesQuiz = () => {
    if (mistakes.length === 0) return;
    const questionsForQuiz: PracticeQuestion[] = mistakes.map((m, idx) => ({
      id: m.id || `m_${idx}`,
      q: m.q,
      opts: m.opts,
      correct: m.correct,
      exp: m.exp,
      subject: m.subject || "ভুল উত্তরের খাতা",
      topic: m.topic
    }));
    setQuizQuestions(questionsForQuiz);
    setQuizTitle("ভুল উত্তরের খাতা অনুশীলন");
    setIsQuizModalOpen(true);
  };

  const handleStartBookmarksQuiz = () => {
    if (bookmarks.length === 0) return;
    const questionsForQuiz: PracticeQuestion[] = bookmarks.map((b, idx) => ({
      id: b.id || `b_${idx}`,
      q: b.q,
      opts: b.opts,
      correct: b.correct,
      exp: b.exp,
      subject: b.subject || "বুকমার্ককৃত প্রশ্ন",
      topic: b.topic
    }));
    setQuizQuestions(questionsForQuiz);
    setQuizTitle("বুকমার্ক প্রশ্ন অনুশীলন");
    setIsQuizModalOpen(true);
  };

  const handleStartSubjectPractice = async (subjectName: string) => {
    setIsLoading(true);
    const localUser = getLocalStudentUser();
    const questions = await getPracticeQuestions(subjectName, 15, localUser?.uid || "", localUser?.email || "");
    setIsLoading(false);

    if (questions.length === 0) {
      alert(`'${subjectName}' বিষয়ে এই মুহূর্তে কোনো প্রশ্ন পাওয়া যায়নি।`);
      return;
    }

    setQuizQuestions(questions);
    setQuizTitle(`${subjectName} - দুর্বলতা নিরাময় প্র্যাকটিস`);
    setIsQuizModalOpen(true);
  };

  const handleRemoveMistake = (id: string) => {
    const updated = removeStudentMistake(studentId, id);
    setMistakes(updated);
  };

  const handleClearAllMistakes = () => {
    if (confirm("আপনি কি ভুল উত্তরের খাতার সকল প্রশ্ন মুছে ফেলতে চান?")) {
      clearAllStudentMistakes(studentId);
      setMistakes([]);
    }
  };

  const handleToggleBookmark = (item: MistakeQuestionItem) => {
    toggleQuestionBookmark(studentId, item);
    refreshStores();
  };

  // Warning count: ended exams in the student's courses that were not taken yet
  const submittedKeys = new Set(submissions.map((s) => s.examKey));
  const endedNotTaken = Object.entries(exams).filter(([id, ex]) => {
    if (
      studentCourses.length > 0 &&
      !studentCourses.some((c) => {
        const sc = String(c || "").trim().toLowerCase();
        return sc === "all" || sc === "সকল কোর্স" || sc === ex.course;
      })
    ) {
      return false;
    }
    if (submittedKeys.has(id)) return false;
    return isAnswerTimeReached(ex);
  });

  return (
    <div className={embedded ? "font-bengali" : "fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4 font-bengali animate-in fade-in duration-200"}>
      <div
        className={
          embedded
            ? `bg-white rounded-3xl ${wide ? "max-w-5xl" : "max-w-3xl"} w-full mx-auto p-4 sm:p-6 border border-slate-200 shadow-sm`
            : "bg-white rounded-3xl max-w-3xl w-full p-4 sm:p-6 shadow-2xl max-h-[92vh] flex flex-col relative border border-slate-100"
        }
      >
        
        {/* Header */}
        <div className="flex justify-between items-center pb-3 border-b border-slate-100 mb-3">
          <div className="flex items-center space-x-3 min-w-0 flex-1">
            <div className="bg-violet-100 text-violet-700 w-10 h-10 rounded-2xl flex items-center justify-center font-bold shadow-sm shrink-0">
              {studentUser?.photoURL ? (
                <Image src={studentUser.photoURL} alt="Avatar" width={32} height={32} className="w-8 h-8 rounded-full" />
              ) : (
                <GraduationCap className="w-6 h-6 text-violet-700" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {editingName ? (
                <div className="flex items-center gap-1.5 max-w-sm mt-0.5">
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="px-2 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-600 bg-white text-slate-900 font-bold"
                  />
                  <button
                    onClick={handleSaveName}
                    className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                    title="সংরক্ষণ করুন"
                  >
                    <Save className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setEditingName(false);
                      if (studentUser) setNewName(studentUser.name);
                    }}
                    className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm sm:text-base font-bold text-slate-900 truncate">
                    {studentUser?.name || "স্টুডেন্ট ড্যাশবোর্ড"}
                  </h3>
                  <button
                    onClick={() => setEditingName(true)}
                    className="text-slate-400 hover:text-violet-600 p-0.5 transition cursor-pointer"
                    title="নাম এডিট করুন"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <p className="text-xs text-slate-500 font-mono truncate">
                {studentUser?.email || `আইডি: ${studentId}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="text-rose-600 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 border border-rose-200/50 p-2 rounded-xl text-xs flex items-center gap-1 font-semibold transition cursor-pointer"
              title="লগআউট করুন"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">লগআউট</span>
            </button>
            {!embedded && (
              <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Navigation Tabs — portal সেকশন-পেজে hideTabs হলে ৪টি ট্যাব দেখাই না
            (শুধু initialTab-এর নির্দিষ্ট সেকশনের কনটেন্ট দেখানো হয়) */}
        {!hideTabs && (
        <div className="flex items-center gap-2 border-b border-slate-100 pb-3 mb-2 flex-wrap">
          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "history"
                ? "bg-violet-600 text-white shadow-sm"
                : "bg-slate-100 hover:bg-slate-200 text-slate-600"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>পরীক্ষার ফলাফল ({toBengaliDigits(submissions.length)})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("analytics")}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "analytics"
                ? "bg-indigo-600 text-white shadow-sm"
                : "bg-slate-100 hover:bg-slate-200 text-slate-600"
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>শক্তি ও দুর্বলতা বিশ্লেষণ</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("mistakes")}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "mistakes"
                ? "bg-rose-600 text-white shadow-sm"
                : "bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200/80"
            }`}
          >
            <AlertOctagon className="w-3.5 h-3.5" />
            <span>ভুল উত্তরের খাতা ({toBengaliDigits(mistakes.length)})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("bookmarks")}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
              activeTab === "bookmarks"
                ? "bg-amber-600 text-white shadow-sm"
                : "bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200/80"
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            <span>বুকমার্কসমূহ ({toBengaliDigits(bookmarks.length)})</span>
          </button>
        </div>
        )}

        {/* Access denied banner (IDOR protection) */}
        {accessDenied && (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-300 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-rose-950">
                  🔒 এই আইডির রেকর্ড দেখতে লগইন প্রয়োজন
                </p>
                <p className="text-sm text-rose-800 mt-0.5">
                  আপনার নিজের রেকর্ড দেখতে গুগল দিয়ে লগইন করুন — লগইনের পর আবার চেষ্টা করুন।
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const { loginWithGoogle } = await import("@/lib/student-auth");
                await loginWithGoogle(undefined, "/portal");
              }}
              className="bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-4 py-2 rounded-xl cursor-pointer shrink-0"
            >
              গুগল দিয়ে লগইন
            </button>
          </div>
        )}

        {/* Tab Body */}
        <div className="overflow-y-auto flex-grow pr-1 space-y-4">

          {/* Warning: ended exams not yet taken in the student's courses */}
          {endedNotTaken.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-300 flex items-start gap-2.5">
              <AlertTriangle className="w-[18px] h-[18px] text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-amber-950">
                  ⚠️ আপনার কোর্সের {toBengaliDigits(endedNotTaken.length)}টি শেষ হওয়া পরীক্ষায় অংশ নেননি
                </p>
                <p className="text-sm text-amber-800 mt-0.5">
                  এগুলো এখনও দেওয়া যাবে — মিস করবেন না!
                </p>
              </div>
            </div>
          )}

          {/* TAB 1: EXAM HISTORY */}
          {activeTab === "history" && (
            <>
              <div className="bg-gradient-to-r from-emerald-50 to-teal-50 p-4 rounded-2xl border border-emerald-200 flex flex-col sm:flex-row justify-between items-center gap-3">
                <div>
                  <h4 className="font-bold text-emerald-950 text-sm">রুটিন ও সিলেবাস ডাউনলোড</h4>
                  <p className="text-sm text-emerald-700">গুগল ড্রাইভ থেকে আপডেটেড সিলেবাস ও পরীক্ষার রুটিন পান</p>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  <a
                    href={routineUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 sm:flex-none text-center bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-semibold transition shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <Calendar className="w-3.5 h-3.5" /> রুটিন
                  </a>
                  <a
                    href={syllabusUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 sm:flex-none text-center bg-teal-600 hover:bg-teal-700 text-white px-3.5 py-2 rounded-xl text-xs font-semibold transition shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <FileText className="w-3.5 h-3.5" /> সিলেবাস
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200 text-center">
                  <span className="text-xs sm:text-xs text-slate-500 block">অংশগ্রহণকৃত এক্সাম</span>
                  <span className="text-base sm:text-lg font-bold text-slate-800">{toBengaliDigits(submissions.length)}</span>
                </div>
                <div className="bg-emerald-50 p-3 rounded-2xl border border-emerald-200 text-center">
                  <span className="text-xs sm:text-xs text-emerald-600 block">গড় পারসেন্টেজ</span>
                  <span className="text-base sm:text-lg font-bold text-emerald-700">{toBengaliDigits(avgAcc)}%</span>
                </div>
                <div className="bg-indigo-50 p-3 rounded-2xl border border-indigo-200 text-center">
                  <span className="text-xs sm:text-xs text-indigo-600 block">সর্বোচ্চ স্কোর</span>
                  <span className="text-base sm:text-lg font-bold text-indigo-700">{toBengaliDigits(bestScore)}</span>
                </div>
                <div className="bg-amber-50 p-3 rounded-2xl border border-amber-200 text-center">
                  <span className="text-xs sm:text-xs text-amber-600 block">গড় স্কোর</span>
                  <span className="text-base sm:text-lg font-bold text-amber-700">{toBengaliDigits(avgScore)}</span>
                </div>
              </div>

              <div>
                <h4 className="font-bold text-slate-800 text-xs sm:text-sm mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <History className="w-4 h-4 text-violet-600" /> সাম্প্রতিক পরীক্ষার পারফরম্যান্স
                  </span>
                  <span className="text-sm text-slate-400 font-normal">(ক্লিক করে সমাধান ও মার্কশিট দেখুন)</span>
                </h4>

                <div className="space-y-2">
                  {isLoading ? (
                    <LoadingState label="পারফরম্যান্স লোড হচ্ছে..." variant="list" rows={4} />
                  ) : submissions.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-6">আপনার কোনো পরীক্ষার রেকর্ড পাওয়া যায়নি।</p>
                  ) : (
                    submissions.map((sub, sIdx) => {
                      const ex = exams[sub.examKey];
                      const canShow = ex ? isAnswerTimeReached(ex) : true;

                      return (
                        <button
                          key={sIdx}
                          onClick={() => onSelectSubmissionDetail(sub)}
                          className="w-full text-left p-3.5 rounded-2xl border border-slate-200 bg-slate-50 hover:bg-violet-50/60 transition shadow-sm cursor-pointer group"
                        >
                          {/* মোবাইল-ফ্রেন্ডলি: উপরে শিরোনাম (wrap হয়), নিচে পুরো-প্রস্থ স্কোর */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="font-bold text-slate-900 text-xs sm:text-sm group-hover:text-violet-700 transition leading-snug">
                                  {toBengaliDigits(sIdx + 1)}. {sub.examTitle}
                                </h4>
                                {sub.isLiveSubmission === false && (
                                  <span className="bg-amber-100 text-amber-900 text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0">
                                    অনুশীলন
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-slate-500 mt-1 font-mono">সময়কাল: {sub.timeSpent}</p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-violet-600 transition shrink-0 mt-0.5" />
                          </div>

                          <div className="mt-2.5">
                            {canShow ? (
                              <span className="flex items-center justify-between gap-2 bg-indigo-100 group-hover:bg-indigo-200 text-indigo-700 font-bold px-3 py-2 rounded-xl text-xs transition">
                                <span className="truncate">স্কোর: {toBengaliDigits(sub.score)}</span>
                                <span className="text-[10px] font-black text-indigo-600 shrink-0">ফলাফল দেখুন →</span>
                              </span>
                            ) : (
                              <span className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-100 px-3 py-2 rounded-xl font-bold">
                                <Lock className="w-3 h-3 shrink-0" /> ফলাফল প্রকাশের অপেক্ষায়
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}

          {/* TAB 2: ANALYTICS & WEAKNESS BREAKDOWN */}
          {activeTab === "analytics" && (
            <div className="space-y-5">
              {!analytics || analytics.totalExams === 0 ? (
                <div className="text-center py-12 text-slate-400 space-y-2 bg-slate-50 rounded-2xl border border-slate-200">
                  <BarChart3 className="w-10 h-10 mx-auto text-indigo-400" />
                  <h4 className="font-bold text-slate-700 text-sm">পর্যাপ্ত ডেটা নেই</h4>
                  <p className="text-xs max-w-sm mx-auto">
                    কমপক্ষে ১টি পরীক্ষায় অংশগ্রহণ করলে আপনার শক্তি ও দুর্বলতার স্বয়ংক্রিয় অ্যানালিটিক্স রিপোর্ট এখানে তৈরি হবে।
                  </p>
                </div>
              ) : (
                <>
                  {/* Top 3 Summary Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="p-3.5 bg-emerald-50/80 rounded-2xl border border-emerald-200 space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                        <TrendingUp className="w-4 h-4 text-emerald-600" />
                        <span>সবচেয়ে শক্তিশালী বিষয়</span>
                      </div>
                      <h4 className="text-base font-black text-emerald-950 truncate">
                        {analytics.strongestSubject || "সবগুলোতে সমান"}
                      </h4>
                      <p className="text-xs text-emerald-700">সর্বোচ্চ সঠিক উত্তরের হার</p>
                    </div>

                    <div className="p-3.5 bg-rose-50/80 rounded-2xl border border-rose-200 space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
                        <AlertTriangle className="w-4 h-4 text-rose-600" />
                        <span>মনোযোগ প্রয়োজন (দুর্বল)</span>
                      </div>
                      <h4 className="text-base font-black text-rose-950 truncate">
                        {analytics.weakestSubject || "নেই"}
                      </h4>
                      <p className="text-xs text-rose-700">ভুলের হার তুলনামূলক বেশি</p>
                    </div>

                    <div className="p-3.5 bg-indigo-50/80 rounded-2xl border border-indigo-200 space-y-1">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-800">
                        <SparklesIcon className="w-4 h-4 text-indigo-600" />
                        <span>সার্বিক অ্যাকুরেসি</span>
                      </div>
                      <h4 className="text-base font-black text-indigo-950">
                        {toBengaliDigits(analytics.overallAccuracy)}%
                      </h4>
                      <p className="text-xs text-indigo-700">
                        মোট {toBengaliDigits(analytics.totalAttemptedQuestions)}টি প্রশ্নের বিশ্লেষণে
                      </p>
                    </div>
                  </div>

                  {/* Smart Prep Recommendation Box */}
                  <div className="p-4 rounded-2xl bg-gradient-to-r from-indigo-50 via-slate-50 to-purple-50 border border-indigo-100 flex items-start gap-3 shadow-sm">
                    <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0 mt-0.5">
                      <Lightbulb className="w-4 h-4 text-indigo-600" />
                    </div>
                    <div className="space-y-0.5">
                      <h5 className="text-xs font-bold text-indigo-950">স্মার্ট প্রস্তুতি পরামর্শ (AI Recommendation):</h5>
                      <p className="text-xs text-slate-600 leading-relaxed">{analytics.recommendation}</p>
                    </div>
                  </div>

                  {/* Subject Breakdown List */}
                  <div className="space-y-3 pt-1">
                    <h4 className="font-bold text-xs sm:text-sm text-slate-800 flex items-center justify-between">
                      <span>বিষয়ভিত্তিক দক্ষতা ও পারফরম্যান্স ছক:</span>
                      <span className="text-sm text-slate-400 font-normal">অ্যাকুরেসি অনুযায়ী সাজানো</span>
                    </h4>

                    <div className="space-y-3">
                      {analytics.subjectBreakdown.map((item, idx) => {
                        const isStrong = item.status === "strong";
                        const isWeak = item.status === "weak";

                        const barColor = isStrong
                          ? "bg-emerald-500"
                          : isWeak
                          ? "bg-rose-500"
                          : "bg-amber-500";

                        const badgeClass = isStrong
                          ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                          : isWeak
                          ? "bg-rose-100 text-rose-800 border-rose-200"
                          : "bg-amber-100 text-amber-800 border-amber-200";

                        const statusText = isStrong
                          ? "🟢 শক্তিশালী প্রস্তুতি"
                          : isWeak
                          ? "🔴 দুর্বলতা চিহ্নিত"
                          : "🟡 সন্তোষজনক";

                        return (
                          <div
                            key={idx}
                            className="p-4 rounded-2xl border border-slate-200 bg-white space-y-3 shadow-sm text-xs"
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                              <div>
                                <div className="flex items-center gap-2">
                                  <h5 className="font-bold text-slate-900 text-xs sm:text-sm">
                                    {item.subject}
                                  </h5>
                                  <span className={`text-xs font-bold px-2 py-0.5 rounded-md border ${badgeClass}`}>
                                    {statusText}
                                  </span>
                                </div>
                                <p className="text-sm text-slate-500 mt-0.5">
                                  মোট প্রশ্ন: <strong>{toBengaliDigits(item.totalQuestions)}টি</strong> • সঠিক:{" "}
                                  <strong className="text-emerald-700">{toBengaliDigits(item.correct)}টি</strong> • ভুল:{" "}
                                  <strong className="text-rose-600">{toBengaliDigits(item.incorrect)}টি</strong>
                                </p>
                              </div>

                              <div className="flex items-center gap-2.5 self-end sm:self-center">
                                <span className="font-black text-slate-900 text-xs sm:text-sm font-mono">
                                  {toBengaliDigits(item.accuracy)}%
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleStartSubjectPractice(item.subject)}
                                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border border-indigo-200 font-bold px-3 py-1.5 rounded-xl text-sm flex items-center gap-1 transition cursor-pointer shadow-sm shrink-0"
                                >
                                  <Play className="w-3 h-3 text-indigo-600 fill-indigo-600" />
                                  <span>অনুশীলন</span>
                                </button>
                              </div>
                            </div>

                            {/* Accuracy Visual Progress Bar */}
                            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                              <div
                                className={`${barColor} h-full rounded-full transition-all duration-500`}
                                style={{ width: `${Math.max(5, item.accuracy)}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 3: MISTAKE NOTEBOOK */}
          {activeTab === "mistakes" && (
            <div className="space-y-4">
              <div className="bg-rose-50/80 p-4 rounded-2xl border border-rose-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h4 className="font-bold text-rose-950 text-sm flex items-center gap-1.5">
                    <AlertOctagon className="w-4 h-4 text-rose-600" /> ভুল উত্তরের খাতা (Mistake Bank)
                  </h4>
                  <p className="text-xs text-rose-700">
                    পরীক্ষায় ভুল হওয়া প্রশ্নগুলো এখানে স্বয়ংক্রিয়ভাবে সংরক্ষিত থাকে রিভিশন দেওয়ার জন্য।
                  </p>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {mistakes.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={handleStartMistakesQuiz}
                        className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-white" />
                        <span>ভুলগুলোর পরীক্ষা দিন ({toBengaliDigits(mistakes.length)})</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleClearAllMistakes}
                        title="সকল ভুল মুছে ফেলুন"
                        className="p-2 rounded-xl bg-white hover:bg-rose-100 text-rose-700 border border-rose-200 transition cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {mistakes.length === 0 ? (
                <div className="text-center py-12 text-slate-400 space-y-2">
                  <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500" />
                  <h4 className="font-bold text-slate-700 text-sm">কোনো ভুল সংরক্ষিত নেই!</h4>
                  <p className="text-xs max-w-sm mx-auto">
                    পরীক্ষা দেওয়ার সময় যে প্রশ্নগুলো ভুল করবেন সেগুলো স্বয়ংক্রিয়ভাবে এখানে যুক্ত হবে।
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {shownMistakes.map((m, idx) => (
                    <div
                      key={m.id || idx}
                      className="p-4 rounded-2xl border border-rose-200 bg-white space-y-3 shadow-sm text-xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                              {m.examTitle}
                            </span>
                            {m.topic && (
                              <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded">
                                টপিক: {m.topic}
                              </span>
                            )}
                          </div>
                          <h4 className="font-bold text-slate-900 text-xs sm:text-sm leading-relaxed">
                            {toBengaliDigits(idx + 1)}. {m.q}
                          </h4>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleToggleBookmark(m)}
                            title="বুকমার্ক"
                            className="p-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-500 border border-slate-200"
                          >
                            <Bookmark className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveMistake(m.id)}
                            title="ভুলের তালিকা থেকে বাদ দিন (Mastered)"
                            className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Options with Wrong vs Right Highlight */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {m.opts.map((opt, optIdx) => {
                          const isCorrect = optIdx === m.correct;
                          const isUserWrong = m.userAns === optIdx;

                          return (
                            <div
                              key={optIdx}
                              className={`p-2 rounded-lg border flex items-center justify-between ${
                                isCorrect
                                  ? "bg-emerald-50 border-emerald-300 text-emerald-950 font-bold"
                                  : isUserWrong
                                  ? "bg-rose-50 border-rose-300 text-rose-950 font-semibold"
                                  : "bg-slate-50 border-slate-200 text-slate-600"
                              }`}
                            >
                              <span>
                                ({optLabels[optIdx]}) {opt}
                              </span>
                              {isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                              {isUserWrong && <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />}
                            </div>
                          );
                        })}
                      </div>

                      {m.exp && (
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-sm text-slate-600 leading-relaxed">
                          <strong>ব্যাখ্যা:</strong> {m.exp}
                        </div>
                      )}
                    </div>
                  ))}

                  {shownMistakes.length < mistakes.length && (
                    <button
                      type="button"
                      onClick={() => setVisibleMistakes((v) => v + MISTAKE_PAGE_SIZE)}
                      className="w-full py-2.5 rounded-xl border border-rose-200 bg-rose-50/60 hover:bg-rose-100 text-rose-700 font-bold text-xs transition cursor-pointer"
                    >
                      আরও দেখুন ({toBengaliDigits(mistakes.length - shownMistakes.length)} টি বাকি)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: BOOKMARKS */}
          {activeTab === "bookmarks" && (
            <div className="space-y-4">
              <div className="bg-amber-50/80 p-4 rounded-2xl border border-amber-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h4 className="font-bold text-amber-950 text-sm flex items-center gap-1.5">
                    <Bookmark className="w-4 h-4 text-amber-600" /> বুকমার্ককৃত প্রশ্নাবলী
                  </h4>
                  <p className="text-xs text-amber-700">
                    গুরুত্বপূর্ণ যেসব প্রশ্ন আপনি পরবর্তীতে রিভিশনের জন্য বুকমার্ক করে রেখেছেন।
                  </p>
                </div>

                {bookmarks.length > 0 && (
                  <button
                    type="button"
                    onClick={handleStartBookmarksQuiz}
                    className="bg-amber-600 hover:bg-amber-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    <span>বুকমার্কগুলোর পরীক্ষা দিন ({toBengaliDigits(bookmarks.length)})</span>
                  </button>
                )}
              </div>

              {bookmarks.length === 0 ? (
                <div className="text-center py-12 text-slate-400 space-y-2">
                  <Bookmark className="w-10 h-10 mx-auto text-amber-400" />
                  <h4 className="font-bold text-slate-700 text-sm">কোনো বুকমার্ক প্রশ্ন নেই</h4>
                  <p className="text-xs max-w-sm mx-auto">
                    পরীক্ষার উত্তর পর্যালোচনার সময় যেকোনো গুরুত্বপূর্ণ প্রশ্ন বুকমার্ক করে এখানে সংরক্ষণ করতে পারেন।
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {shownBookmarks.map((b, idx) => (
                    <div
                      key={b.id || idx}
                      className="p-4 rounded-2xl border border-amber-200 bg-white space-y-3 shadow-sm text-xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          {b.topic && (
                            <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded inline-block mb-1">
                              টপিক: {b.topic}
                            </span>
                          )}
                          <h4 className="font-bold text-slate-900 text-xs sm:text-sm leading-relaxed">
                            {toBengaliDigits(idx + 1)}. {b.q}
                          </h4>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleToggleBookmark(b)}
                          className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-bold px-2.5 py-1 rounded-lg text-sm flex items-center gap-1 shrink-0 cursor-pointer"
                        >
                          <Bookmark className="w-3 h-3 fill-amber-500 text-amber-600" />
                          <span>মুছুন</span>
                        </button>
                      </div>

                      {/* Options with Correct Highlight */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {b.opts.map((opt, optIdx) => {
                          const isCorrect = optIdx === b.correct;

                          return (
                            <div
                              key={optIdx}
                              className={`p-2 rounded-lg border flex items-center justify-between ${
                                isCorrect
                                  ? "bg-emerald-50 border-emerald-300 text-emerald-950 font-bold"
                                  : "bg-slate-50 border-slate-200 text-slate-600"
                              }`}
                            >
                              <span>
                                ({optLabels[optIdx]}) {opt}
                              </span>
                              {isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                            </div>
                          );
                        })}
                      </div>

                      {b.exp && (
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-sm text-slate-600 leading-relaxed">
                          <strong>ব্যাখ্যা:</strong> {b.exp}
                        </div>
                      )}
                    </div>
                  ))}

                  {shownBookmarks.length < bookmarks.length && (
                    <button
                      type="button"
                      onClick={() => setVisibleBookmarks((v) => v + MISTAKE_PAGE_SIZE)}
                      className="w-full py-2.5 rounded-xl border border-amber-200 bg-amber-50/60 hover:bg-amber-100 text-amber-800 font-bold text-xs transition cursor-pointer"
                    >
                      আরও দেখুন ({toBengaliDigits(bookmarks.length - shownBookmarks.length)} টি বাকি)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

      </div>

      {/* Re-Quiz Modal for Mistakes / Bookmarks */}
      <SelfPracticeModal
        isOpen={isQuizModalOpen}
        onClose={() => setIsQuizModalOpen(false)}
        questions={quizQuestions}
        subjectName={quizTitle}
        mode="instant"
        onRestart={() => {
          // Genuine restart for mistakes/bookmarks quizzes: hand the modal a
          // NEW array (reshuffled copy of the same set). The modal's session
          // reset is keyed on question order + restart tick, so this new array
          // actually starts a fresh round.
          const shuffled = shuffleArray([...quizQuestions]);
          setQuizQuestions(shuffled);
        }}
      />

    </div>
  );
};
