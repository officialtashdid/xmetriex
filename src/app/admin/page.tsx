"use client";

import { CourseEditModal } from "@/components/admin/CourseEditModal";
import { CourseDetailsModal } from "@/components/admin/CourseDetailsModal";
import { AdminLogin } from "@/components/admin/AdminLogin";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import { AdminNav, AdminTabType } from "@/components/admin/AdminNav";
import { LiveExamReport } from "@/components/admin/LiveExamReport";
import dynamic from "next/dynamic";

const LoadingFallback = () => (
  <div className="flex items-center justify-center p-10 text-slate-500 gap-2 font-bengali">
    <Loader2 className="w-5 h-5 animate-spin" /> লোড হচ্ছে...
  </div>
);

const ExamManager = dynamic(() => import("@/components/admin/ExamManager").then(mod => mod.ExamManager), { loading: LoadingFallback });
const QuestionBuilder = dynamic(() => import("@/components/admin/QuestionBuilder").then(mod => mod.QuestionBuilder), { loading: LoadingFallback });
const BulkQuestionImporterModal = dynamic(() => import("@/components/admin/BulkQuestionImporterModal").then(mod => mod.BulkQuestionImporterModal));
const StudentApproval = dynamic(() => import("@/components/admin/StudentApproval").then(mod => mod.StudentApproval), { loading: LoadingFallback });
const QuestionBankManager = dynamic(() => import("@/components/admin/QuestionBankManager").then(mod => mod.QuestionBankManager), { loading: LoadingFallback });
const AdminAnalyticsDashboard = dynamic(() => import("@/components/admin/AdminAnalyticsDashboard").then(mod => mod.AdminAnalyticsDashboard), { loading: LoadingFallback });
const ArchiveManager = dynamic(() => import("@/components/admin/ArchiveManager").then(mod => mod.ArchiveManager), { loading: LoadingFallback });
const CourseVideoManager = dynamic(() => import("@/components/admin/CourseVideoManager").then(mod => mod.CourseVideoManager), { loading: LoadingFallback });
const NewsManager = dynamic(() => import("@/components/admin/NewsManager").then(mod => mod.NewsManager), { loading: LoadingFallback });
const WhatsAppGroupManager = dynamic(() => import("@/components/admin/WhatsAppGroupManager").then(mod => mod.WhatsAppGroupManager), { loading: LoadingFallback });
import { fetchAppConfig, fetchAppConfigLite, saveAppConfig, deleteTopicQuestion } from "@/actions/admin-actions";
import { supabase } from "@/lib/supabase";
import { AppConfigData, Exam, QuestionItem, TopicQuestion } from "@/types/exam";
import {
  LogOut,
  Users,
  Plus,
  Trash2,
  Link2,
  Loader2,
  Edit3,
  Check,
  X,
  Layers,
  Tag,
  Search,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  HelpCircle,
  BookOpen,
  Pin
} from "lucide-react";
import { toBengaliDigits } from "@/lib/utils";

export default function AdminPage() {
  const router = useRouter();
  const [config, setConfig] = useState<AppConfigData | null>(null);
  const [isFullDataLoaded, setIsFullDataLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTabType>(() => {
    // "শিক্ষার্থীর ফলাফল" পেজ থেকে ফিরে এলে (…/admin?tab=students) সরাসরি ওই ট্যাব খোলে
    if (typeof window !== "undefined") {
      const t = new URLSearchParams(window.location.search).get("tab");
      const valid: AdminTabType[] = [
        "analytics", "exams", "courses", "subjects", "students",
        "questions", "question_bank", "videos", "archive", "drivelinks", "news", "whatsapp"
      ];
      if (t && (valid as string[]).includes(t)) return t as AdminTabType;
    }
    return "exams";
  });
  const [selectedExamKey, setSelectedExamKey] = useState("");
  const [teacherUser, setTeacherUser] = useState<{ email: string } | null>(null);
  // অথেনটিকেশন গেট: যাচাই চলছে → লগইন ল্যান্ডিং → প্যানেল
  const [authState, setAuthState] = useState<"checking" | "login" | "panel">("checking");

  // Sub-forms state
  const [newCourseName, setNewCourseName] = useState("");
  const [newSubjectCourse, setNewSubjectCourse] = useState("");
  const [newSubjectName, setNewSubjectName] = useState("");
  const [driveRoutine, setDriveRoutine] = useState("");
  const [driveSyllabus, setDriveSyllabus] = useState("");

  // Subject editing state
  const [editingSubjectIdx, setEditingSubjectIdx] = useState<number | null>(null);
  const [editSubjectName, setEditSubjectName] = useState("");
  const [editSubjectCourse, setEditSubjectCourse] = useState("");

  // Course editing state
  const [editingCourseIdx, setEditingCourseIdx] = useState<number | null>(null);
  const [editCourseName, setEditCourseName] = useState("");
  const [editingCourse, setEditingCourse] = useState<string | null>(null);
  const [courseDirty, setCourseDirty] = useState(false);
  // কোর্সের বিস্তারিত (লম্বা লেখা) লেখা/এডিট করার মোডাল
  const [detailsCourse, setDetailsCourse] = useState<string | null>(null);

  const openCourseEdit = (c: string) => {
    setEditingCourse(c);
    setCourseDirty(false);
  };
  const closeCourseEdit = () => {
    if (courseDirty) {
      window.location.reload(); // নাম/দাম/ভিডিও পরিবর্তন সব জায়গায় প্রতিফলিত হবে
    } else {
      setEditingCourse(null);
    }
  };
  const markCourseDirty = () => setCourseDirty(true);

  // Topic states (standalone topic names)
  const [newTopicName, setNewTopicName] = useState("");
  const [editingTopicIdx, setEditingTopicIdx] = useState<number | null>(null);
  const [editTopicName, setEditTopicName] = useState("");
  const [topicSearch, setTopicSearch] = useState("");
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null);
  const [bulkTopicName, setBulkTopicName] = useState<string | null>(null);

  const applyConfigToState = (data: AppConfigData) => {
    setConfig(data);
    setDriveRoutine(data.driveRoutineUrl || "");
    setDriveSyllabus(data.driveSyllabusUrl || "");
    if (data.courses?.length) {
      setNewSubjectCourse(data.courses[0]);
    }
    const keys = Object.keys(data.exams || {});
    if (keys.length > 0) {
      setSelectedExamKey((prevKey) => (prevKey && data.exams?.[prevKey] ? prevKey : keys[0]));
    }
  };

  const loadData = async (initialLoad = false) => {
    // SECURITY: verify server-side (sessionStorage alone can be forged via DevTools)
    const { verifyTeacherSession } = await import("@/actions/admin-actions");
    const { data: { session } } = await supabase.auth.getSession();
    const verified = await verifyTeacherSession(session?.access_token);
    if (!verified.ok || !verified.email) {
      sessionStorage.removeItem("teacher_user");
      // আগে হোমে পাঠানো হতো; এখন /admin-এই লগইন ল্যান্ডিং দেখাই
      setAuthState("login");
      return;
    }
    setTeacherUser({ email: verified.email });
    setAuthState("panel");

    if (initialLoad) {
      // Phase 1: Lite load — shows exam list instantly (no heavy JOIN)
      const liteData = await fetchAppConfigLite();
      applyConfigToState(liteData);
      setIsFullDataLoaded(false);
    }

    // Phase 2 (or only phase for refresh): Full data with all questions
    const data = await fetchAppConfig(true);
    applyConfigToState(data);
    setIsFullDataLoaded(true);
  };

  useEffect(() => {
    loadData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  // লগইন ল্যান্ডিং — শিক্ষক নন বা সেশন নেই
  if (authState === "login") {
    return <AdminLogin />;
  }

  // যাচাই চলছে / ডেটা লোড হচ্ছে
  if (authState === "checking" || !config || !teacherUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 font-bengali text-slate-500 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> প্যানেল লোড হচ্ছে...
      </div>
    );
  }

  const handleLogout = async () => {
    if (confirm("আপনি কি নিশ্চিতভাবে শিক্ষক প্যানেল থেকে লগআউট করতে চান?")) {
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.error("Error signing out from Supabase:", err);
      }
      sessionStorage.removeItem("teacher_user");
      sessionStorage.removeItem("current_student");
      localStorage.removeItem("bcs_student_user");
      router.push("/");
    }
  };

  // Add course
  const handleAddCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = newCourseName.trim();
    if (!val || config.courses.includes(val)) return;

    const nextCourses = [...config.courses, val];
    await saveAppConfig({ courses: nextCourses });
    setNewCourseName("");
    loadData();
  };

  const handleDeleteCourse = async (courseName: string) => {
    if (config.courses.length <= 1) {
      alert("কমপক্ষে একটি কোর্স থাকা আবশ্যক।");
      return;
    }
    const courseExams = Object.values(config.exams || {}).filter((ex) => ex.course === courseName);
    const courseSubjects = (config.subjects || []).filter((s) => s.course === courseName);
    const orphanWarning =
      courseExams.length > 0 || courseSubjects.length > 0
        ? `\n\n⚠️ সতর্কতা: এই কোর্সে ${courseExams.length}টি পরীক্ষা ও ${courseSubjects.length}টি সাবজেক্ট আছে। কোর্সটি মুছলে সেগুলো হোম পেজে আর দেখা যাবে না (ডেটা মুছে যাবে না — প্রয়োজনে কোর্সটি নতুন নামে আবার যোগ করলেই সেগুলো আবার দেখা যাবে)।`
        : "";
    if (confirm(`আপনি কি '${courseName}' কোর্সটি মুছে ফেলতে চান?${orphanWarning}`)) {
      const nextCourses = config.courses.filter((c) => c !== courseName);
      await saveAppConfig({ courses: nextCourses });
      loadData();
    }
  };

  const startEditCourse = (idx: number, oldName: string) => {
    setEditingCourseIdx(idx);
    setEditCourseName(oldName);
  };

  const handleSaveCourseEdit = async (idx: number) => {
    const newVal = editCourseName.trim();
    if (!newVal) return;

    const oldVal = config.courses[idx];
    if (newVal === oldVal) {
      setEditingCourseIdx(null);
      return;
    }

    if (config.courses.includes(newVal)) {
      alert("এই নামের একটি কোর্স ইতিমধ্যেই রয়েছে।");
      return;
    }

    // Persist the rename across the courses list, subjects, exams, question
    // bank and topic questions via a dedicated server action. (saveAppConfig
    // used to silently drop exams/topicQuestions, orphaning exams under the
    // old course name.)
    const { renameCourse } = await import("@/actions/admin-actions");
    const res = await renameCourse(oldVal, newVal);
    if (!res.success) {
      alert(res.message || "কোর্স রিনেম করতে সমস্যা হয়েছে।");
      return;
    }

    setEditingCourseIdx(null);
    loadData();
    alert("কোর্স সফলভাবে আপডেট করা হয়েছে।");
  };

  // Add Subject
  const handleAddSubject = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = newSubjectName.trim();
    if (!val) return;

    if (config.subjects.some((s) => s.name === val && s.course === newSubjectCourse)) {
      alert("এই কোর্সে এই সাবজেক্টটি ইতিমধ্যে বিদ্যমান।");
      return;
    }

    const nextSubjects = [...config.subjects, { name: val, course: newSubjectCourse }];
    await saveAppConfig({ subjects: nextSubjects });
    setNewSubjectName("");
    loadData();
  };

  const handleDeleteSubject = async (idx: number) => {
    if (config.subjects.length <= 1) {
      alert("কমপক্ষে একটি সাবজেক্ট থাকা আবশ্যক।");
      return;
    }
    if (confirm("আপনি কি এই সাবজেক্টটি মুছে ফেলতে চান?")) {
      const nextSubjects = [...config.subjects];
      nextSubjects.splice(idx, 1);
      await saveAppConfig({ subjects: nextSubjects });
      loadData();
    }
  };

  const startEditSubject = (idx: number, sub: { name: string; course: string }) => {
    setEditingSubjectIdx(idx);
    setEditSubjectName(sub.name);
    setEditSubjectCourse(sub.course);
  };

  const handleSaveSubjectEdit = async (idx: number) => {
    const nameVal = editSubjectName.trim();
    if (!nameVal) return;

    const nextSubjects = [...config.subjects];
    nextSubjects[idx] = {
      name: nameVal,
      course: editSubjectCourse
    };

    await saveAppConfig({ subjects: nextSubjects });
    setEditingSubjectIdx(null);
    loadData();
    alert("সাবজেক্ট সফলভাবে আপডেট করা হয়েছে।");
  };

  // Add Topic
  const handleAddTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = newTopicName.trim();
    if (!val) return;

    const currentTopics = config.topics || [];
    if (currentTopics.includes(val)) {
      alert("এই নামের একটি টপিক ইতিমধ্যে বিদ্যমান।");
      return;
    }

    const nextTopics = [...currentTopics, val];
    await saveAppConfig({ topics: nextTopics });
    setNewTopicName("");
    loadData();
  };

  const handleDeleteTopic = async (idx: number) => {
    const topicToDelete = (config.topics || [])[idx];
    if (confirm(`আপনি কি '${topicToDelete}' টপিকটি মুছে ফেলতে চান?`)) {
      const nextTopics = [...(config.topics || [])];
      nextTopics.splice(idx, 1);
      await saveAppConfig({ topics: nextTopics });
      loadData();
    }
  };

  const startEditTopic = (idx: number, t: string) => {
    setEditingTopicIdx(idx);
    setEditTopicName(t);
  };

  // Helper to aggregate all persistent topic questions for a given topic
  // (Survives course, subject, or exam deletion!)
  const getQuestionsByTopic = (topicName: string): TopicQuestion[] => {
    const list: TopicQuestion[] = [];
    const seenMap = new Set<string>();

    // 1. Primary source: persistent topicQuestions repository
    (config?.topicQuestions || []).forEach((tq) => {
      if (tq.topic === topicName) {
        list.push(tq);
        seenMap.add(`${tq.q.trim()}___${tq.topic}`);
      }
    });

    // 2. Secondary source: active exams (ensures full coverage)
    if (config?.exams) {
      Object.entries(config.exams).forEach(([examKey, exam]) => {
        (exam.questions || []).forEach((q, qIdx) => {
          if (q.topic === topicName) {
            const key = `${q.q.trim()}___${q.topic}`;
            if (!seenMap.has(key)) {
              list.push({
                id: `tq_${examKey}_${qIdx}`,
                topic: q.topic,
                q: q.q,
                opts: q.opts,
                correct: 0,
                exp: "",
                originalExamTitle: exam.title,
                originalCourse: exam.course,
                originalSubject: exam.subject,
                examKey: examKey,
              });
              seenMap.add(key);
            }
          }
        });
      });
    }

    return list;
  };

  const handleDeleteTopicQuestion = async (id: string) => {
    if (confirm("আপনি কি এই প্রশ্নটি টপিক ভাণ্ডার থেকে মুছে ফেলতে চান?")) {
      await deleteTopicQuestion(id);
      loadData();
    }
  };

  const handleSaveTopicEdit = async (idx: number) => {
    const nameVal = editTopicName.trim();
    if (!nameVal) return;

    const currentTopics = config?.topics || [];
    const oldTopicName = currentTopics[idx];
    if (currentTopics.includes(nameVal) && oldTopicName !== nameVal) {
      alert("এই নামের একটি টপিক ইতিমধ্যে বিদ্যমান।");
      return;
    }

    const nextTopics = [...currentTopics];
    nextTopics[idx] = nameVal;

    // Cascade the topic rename to topic_questions, question_bank and the
    // registered topics list via the server-side renameTopicNode action
    // (saveAppConfig used to silently drop these payloads).
    if (oldTopicName) {
      const { renameTopicNode } = await import("@/actions/admin-actions");
      const res = await renameTopicNode(oldTopicName, nameVal);
      if (!res.success) {
        alert(res.message || "টপিক রিনেম করতে সমস্যা হয়েছে।");
        return;
      }
    } else {
      await saveAppConfig({ topics: nextTopics });
    }
    setEditingTopicIdx(null);
    loadData();
    alert("টপিক সফলভাবে আপডেট করা হয়েছে।");
  };

  // Drive links
  const handleSaveDriveLinks = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveAppConfig({
      driveRoutineUrl: driveRoutine.trim(),
      driveSyllabusUrl: driveSyllabus.trim(),
    });
    alert("গুগল ড্রাইভ লিংক সফলভাবে আপডেট করা হয়েছে।");
  };

  // Pin / unpin a course (pinned courses show first on the home page)
  const handleTogglePinCourse = async (courseName: string) => {
    const current = config.pinnedCourses || [];
    const next = current.includes(courseName)
      ? current.filter((c) => c !== courseName)
      : [...current, courseName];
    await saveAppConfig({ pinnedCourses: next });
    loadData();
  };



  return (
    <>
      <Header />

      <main className="flex-grow max-w-5xl w-full mx-auto p-4 sm:p-6 font-bengali space-y-6">
        <div className="bg-white rounded-3xl p-4 sm:p-8 shadow-md border border-slate-200 space-y-5">
          {/* Header Panel Top */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center pb-3 border-b border-slate-100 gap-3">
            <div>
              <h2 className="text-base sm:text-xl font-bold text-slate-900 flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" /> শিক্ষক প্যানেল
              </h2>
              <p className="text-xs text-slate-500">পরীক্ষা, কোর্স, সাবজেক্ট এবং ফলাফল নিয়ন্ত্রণ করুন</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto justify-between sm:justify-end">
              <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-200/80 px-3 py-1.5 rounded-xl shadow-sm">
                <div className="w-6 h-6 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm">
                  {teacherUser.email.charAt(0).toUpperCase()}
                </div>
                <div className="text-left leading-tight">
                  <p className="text-sm sm:text-xs font-bold text-indigo-950 truncate max-w-[120px] sm:max-w-[180px]">
                    {teacherUser.email}
                  </p>
                </div>
              </div>

              <LiveExamReport />

              <button
                onClick={handleLogout}
                className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-sm cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" /> <span className="hidden sm:inline">লগআউট</span>
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <AdminNav activeTab={activeTab} onTabChange={setActiveTab} />

          {/* Tab Content */}
          <div className="pt-2">
            {activeTab === "exams" && (
              <ExamManager
                exams={config.exams || {}}
                courses={config.courses || []}
                subjects={config.subjects || []}
                topics={config.topics || []}
                activeExamKey={selectedExamKey}
                onSelectExamForQuestions={(k) => {
                  setSelectedExamKey(k);
                  setActiveTab("questions");
                }}
                onRefresh={loadData}
              />
            )}

            {activeTab === "question_bank" && (
              <QuestionBankManager
                topics={config.topics || []}
                subjects={config.subjects || []}
                onRefresh={loadData}
              />
            )}

            {activeTab === "analytics" && (
              <AdminAnalyticsDashboard />
            )}

            {activeTab === "courses" && (
              <div className="space-y-5">
                <div className="bg-indigo-50 p-4 sm:p-5 rounded-2xl border border-indigo-100 space-y-3">
                  <h3 className="font-bold text-indigo-900 text-xs sm:text-sm flex items-center gap-1.5">
                    <Plus className="w-4 h-4" /> নতুন কোর্স যোগ করুন
                  </h3>
                  <form onSubmit={handleAddCourse} className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      required
                      placeholder="যেমন: বিসিএস প্রিলি কোর্স"
                      value={newCourseName}
                      onChange={(e) => setNewCourseName(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-xl border border-indigo-200 text-xs sm:text-sm bg-white"
                    />
                    <button
                      type="submit"
                      className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-5 py-2.5 rounded-xl text-xs sm:text-sm transition whitespace-nowrap shadow cursor-pointer"
                    >
                      যোগ করুন
                    </button>
                  </form>
                </div>

                <div>
                  <h4 className="font-bold text-slate-800 text-xs sm:text-sm mb-2.5">বিদ্যমান কোর্সসমূহ:</h4>
                  <div className="space-y-2">
                    {config.courses.map((course, idx) => {
                      const isEditing = editingCourseIdx === idx;
                      return (
                        <div
                          key={idx}
                          className={`p-3 rounded-xl border transition-all ${isEditing ? "border-indigo-400 bg-indigo-50/20" : "border-slate-200 bg-slate-50"
                            } flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm`}
                        >
                          {isEditing ? (
                            <div className="flex flex-col sm:flex-row gap-2 w-full">
                              <input
                                type="text"
                                value={editCourseName}
                                onChange={(e) => setEditCourseName(e.target.value)}
                                className="flex-grow px-3 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white"
                                required
                              />
                              <div className="flex gap-1.5 sm:ml-auto">
                                <button
                                  onClick={() => handleSaveCourseEdit(idx)}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition cursor-pointer flex items-center gap-1"
                                >
                                  <Check className="w-3.5 h-3.5" /> সংরক্ষণ
                                </button>
                                <button
                                  onClick={() => setEditingCourseIdx(null)}
                                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold px-3 py-1.5 rounded-lg text-xs transition cursor-pointer flex items-center gap-1"
                                >
                                  <X className="w-3.5 h-3.5" /> বাতিল
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <span className="font-bold text-slate-800">
                                {toBengaliDigits(idx + 1)}. {course}
                              </span>
                              <div className="flex gap-2 justify-end sm:ml-auto">
                                <button
                                  onClick={() => handleTogglePinCourse(course)}
                                  title={config.pinnedCourses?.includes(course) ? "পিন খুলুন" : "কোর্স পিন করুন"}
                                  className={`text-xs px-2 py-1 cursor-pointer flex items-center gap-1 font-semibold rounded-lg transition ${
                                    config.pinnedCourses?.includes(course)
                                      ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                      : "text-slate-500 hover:text-amber-600 hover:bg-amber-50"
                                  }`}
                                >
                                  <Pin className="w-3.5 h-3.5" />
                                  {config.pinnedCourses?.includes(course) ? "পিনকৃত" : "পিন"}
                                </button>
                                <button
                                  onClick={() => openCourseEdit(course)}
                                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-xs px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1 transition"
                                  title="নাম, দাম, ভিডিও, পরীক্ষা — সব এক জায়গায় এডিট করুন"
                                >
                                  <Edit3 className="w-3.5 h-3.5" /> এডিট
                                </button>
                                <button
                                  onClick={() => setDetailsCourse(course)}
                                  className="bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-bold text-xs px-3 py-1.5 rounded-lg cursor-pointer flex items-center gap-1 transition"
                                  title="কোর্সের বিস্তারিত (লম্বা বিবরণ) লিখুন/এডিট করুন — শিক্ষার্থীরা কোর্স পেজে দেখবে"
                                >
                                  <FileText className="w-3.5 h-3.5" /> বিস্তারিত
                                </button>
                                <button
                                  onClick={() => handleDeleteCourse(course)}
                                  className="text-rose-600 hover:text-rose-800 font-semibold text-xs px-2 py-1 cursor-pointer flex items-center gap-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" /> মুছুন
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {editingCourse && (
              <CourseEditModal
                course={editingCourse}
                exams={config.exams || {}}
                subjects={config.subjects || []}
                onClose={closeCourseEdit}
                onChanged={markCourseDirty}
                onManageExams={(c) => {
                  setEditingCourse(null);
                  setCourseDirty(false);
                  setActiveTab("exams");
                }}
              />
            )}

            {detailsCourse && (
              <CourseDetailsModal course={detailsCourse} onClose={() => setDetailsCourse(null)} />
            )}

            {activeTab === "subjects" && (
              <div className="space-y-5">
                <div className="bg-indigo-50 p-4 sm:p-5 rounded-2xl border border-indigo-100 space-y-3">
                  <h3 className="font-bold text-indigo-900 text-xs sm:text-sm flex items-center gap-1.5">
                    <Plus className="w-4 h-4" /> নতুন সাবজেক্ট যোগ করুন
                  </h3>
                  <form onSubmit={handleAddSubject} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">কোর্স নির্বাচন করুন</label>
                      <select
                        value={newSubjectCourse}
                        onChange={(e) => setNewSubjectCourse(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-indigo-200 text-xs sm:text-sm bg-white"
                      >
                        {config.courses.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-600 mb-1">সাবজেক্টের নাম</label>
                      <input
                        type="text"
                        required
                        placeholder="যেমন: বিজ্ঞান"
                        value={newSubjectName}
                        onChange={(e) => setNewSubjectName(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border border-indigo-200 text-xs sm:text-sm bg-white"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <button
                        type="submit"
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-5 py-2.5 rounded-xl text-xs sm:text-sm transition shadow cursor-pointer"
                      >
                        সাবজেক্ট যোগ করুন
                      </button>
                    </div>
                  </form>
                </div>

                <div>
                  <h4 className="font-bold text-slate-800 text-xs sm:text-sm mb-2.5">বিদ্যমান সাবজেক্টসমূহ:</h4>
                  <div className="space-y-2">
                    {config.subjects.map((sub, idx) => {
                      const isEditing = editingSubjectIdx === idx;
                      return (
                        <div
                          key={idx}
                          className={`p-3 rounded-xl border transition-all ${isEditing ? "border-indigo-400 bg-indigo-50/20" : "border-slate-200 bg-slate-50"
                            } flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs sm:text-sm`}
                        >
                          {isEditing ? (
                            <div className="flex flex-col sm:flex-row gap-2 w-full">
                              <input
                                type="text"
                                value={editSubjectName}
                                onChange={(e) => setEditSubjectName(e.target.value)}
                                className="flex-grow px-3 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white"
                                required
                              />
                              <select
                                value={editSubjectCourse}
                                onChange={(e) => setEditSubjectCourse(e.target.value)}
                                className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs sm:text-sm bg-white"
                              >
                                {!config.courses.includes(editSubjectCourse) && (
                                  <option value={editSubjectCourse}>
                                    {editSubjectCourse} (মুছে ফেলা কোর্স)
                                  </option>
                                )}
                                {config.courses.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                              <div className="flex gap-1.5 sm:ml-auto">
                                <button
                                  onClick={() => handleSaveSubjectEdit(idx)}
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-3 py-1.5 rounded-lg text-xs transition cursor-pointer flex items-center gap-1"
                                >
                                  <Check className="w-3.5 h-3.5" /> সংরক্ষণ
                                </button>
                                <button
                                  onClick={() => setEditingSubjectIdx(null)}
                                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold px-3 py-1.5 rounded-lg text-xs transition cursor-pointer flex items-center gap-1"
                                >
                                  <X className="w-3.5 h-3.5" /> বাতিল
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div>
                                <span className="font-bold text-slate-800">
                                  {toBengaliDigits(idx + 1)}. {sub.name}
                                </span>
                                <span className="text-sm text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded ml-2">
                                  {sub.course}
                                </span>
                              </div>
                              <div className="flex gap-2 justify-end sm:ml-auto">
                                <button
                                  onClick={() => startEditSubject(idx, sub)}
                                  className="text-amber-600 hover:text-amber-800 font-semibold text-xs px-2 py-1 cursor-pointer flex items-center gap-1"
                                >
                                  <Edit3 className="w-3.5 h-3.5" /> এডিট
                                </button>
                                <button
                                  onClick={() => handleDeleteSubject(idx)}
                                  className="text-rose-600 hover:text-rose-800 font-semibold text-xs px-2 py-1 cursor-pointer flex items-center gap-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" /> মুছুন
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}


            {activeTab === "students" && <StudentApproval courses={config.courses || []} />}

            {activeTab === "questions" && config.exams?.[selectedExamKey] && (
              isFullDataLoaded ? (
                <QuestionBuilder
                  activeExamKey={selectedExamKey}
                  exam={config.exams[selectedExamKey]}
                  allExams={config.exams || {}}
                  onSelectExamKey={(k) => setSelectedExamKey(k)}
                  topics={config.topics || []}
                  onRefresh={loadData}
                />
              ) : (
                <div className="flex items-center justify-center p-10 text-slate-500 gap-2 font-bengali">
                  <Loader2 className="w-5 h-5 animate-spin" /> প্রশ্ন লোড হচ্ছে...
                </div>
              )
            )}

            {activeTab === "videos" && <CourseVideoManager courses={config.courses || []} subjects={config.subjects || []} />}

            {activeTab === "news" && <NewsManager />}

            {activeTab === "whatsapp" && <WhatsAppGroupManager courses={config.courses || []} />}

            {activeTab === "archive" && (
              <ArchiveManager
                exams={config.exams || {}}
                onRefresh={loadData}
              />
            )}

            {activeTab === "drivelinks" && (
              <div className="max-w-md bg-slate-50 p-4 sm:p-5 rounded-2xl border border-slate-200 space-y-4">
                <h3 className="font-bold text-slate-800 text-xs sm:text-sm flex items-center gap-2">
                  <Link2 className="w-4 h-4 text-emerald-600" /> গুগল ড্রাইভ লিংক সেটিংস (রুটিন ও সিলেবাস)
                </h3>
                <form onSubmit={handleSaveDriveLinks} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      পরীক্ষার রুটিন (Google Drive URL)
                    </label>
                    <input
                      type="url"
                      placeholder="https://drive.google.com/file/d/..."
                      value={driveRoutine}
                      onChange={(e) => setDriveRoutine(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">
                      কোর্স সিলেবাস (Google Drive URL)
                    </label>
                    <input
                      type="url"
                      placeholder="https://drive.google.com/file/d/..."
                      value={driveSyllabus}
                      onChange={(e) => setDriveSyllabus(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs sm:text-sm bg-white"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-xl text-xs sm:text-sm transition shadow cursor-pointer"
                  >
                    লিংক আপডেট করুন
                  </button>
                </form>
              </div>
            )}


          </div>
        </div>
      </main>

      {bulkTopicName && (
        <BulkQuestionImporterModal
          isOpen={true}
          targetTopic={bulkTopicName}
          topics={config?.topics || []}
          onClose={() => setBulkTopicName(null)}
          onSuccess={loadData}
        />
      )}

      <Footer />
    </>
  );
}
