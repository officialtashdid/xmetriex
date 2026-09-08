"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Play,
  Loader2,
  Lock,
  LogIn,
  ShoppingCart,
  Layers,
  ChevronRight,
  ChevronDown,
  Check,
  RotateCcw,
  BookOpen
} from "lucide-react";
import { getPracticeTopics } from "@/actions/practice-actions";
import { verifyTeacherSession } from "@/actions/admin-actions";
import { getLocalStudentUser, loginWithGoogle } from "@/lib/student-auth";
import type { TopicOption } from "@/lib/practice-helper";
import { buildTopicCountMap, buildTopicGroupTree, colorFor, type HubNode } from "@/lib/topic-group";
import { toBengaliDigits } from "@/lib/utils";

/**
 * সেলফ প্র্যাকটিস হাব — Live MCQ-স্টাইলের টপিক-গ্রুপ কার্ড গ্রিড।
 *
 * নিয়ম (সার্ভার-অ্যাকশনে ইতোমধ্যে কার্যকর, এখানে শুধু UI):
 *  ১. যেকোনো একটি কোর্সে এনরোল্ড (বা শিক্ষক) থাকলেই সব টপিক-গ্রুপের সব প্রশ্ন
 *     প্র্যাকটিসযোগ্য — কোর্স-স্কোপ ফিল্টার নেই। এনরোলমেন্ট ছাড়া গেটে আটকে যায়।
 *  ২. নির্ধারিত (লাইভ) পরীক্ষার প্রশ্ন ফলাফল-সময়ের আগে কখনো দেখানো/গোনা হয় না;
 *     লাইভ শেষ (endTime + grace) হলে সেগুলো স্বয়ংক্রিয়ভাবে এখানে যুক্ত হয়।
 *
 * কার্যকারিতা অপরিবর্তিত: টপিক/গ্রুপ নির্বাচন → প্রশ্নসংখ্যা (১০/২০/৩০/৫০) →
 * ইনস্ট্যান্ট/মক মোড → /practice/session (আলাদা উইন্ডো/ট্যাব)।
 */

interface PracticeHubProps {
  onOpenEnrollModal?: () => void;
}

const ALL_LABEL = "সকল টপিক (মিক্সড)";
const QUESTION_COUNTS = [10, 20, 30, 50];

export const PracticeHub: React.FC<PracticeHubProps> = ({ onOpenEnrollModal }) => {
  const [phase, setPhase] = useState<"loading" | "guest" | "locked" | "hub">("loading");
  const [accessError, setAccessError] = useState("");
  const [topics, setTopics] = useState<TopicOption[] | null>(null);
  const [topicsError, setTopicsError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  // হাব স্টেট
  const [selectedTopic, setSelectedTopic] = useState(ALL_LABEL);
  const [activeGroupPath, setActiveGroupPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [selectedCount, setSelectedCount] = useState(10);
  const [practiceMode, setPracticeMode] = useState<"instant" | "exam">("instant");
  const [isStarting, setIsStarting] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const tree = useMemo(() => buildTopicGroupTree(topics || []), [topics]);
  const countMap = useMemo(() => buildTopicCountMap(tree), [tree]);
  const totalCount = useMemo(() => tree.reduce((s, n) => s + n.count, 0), [tree]);
  const hasNested = useMemo(() => tree.some((n) => n.children.length > 0), [tree]);

  const loadTopics = async (id: string, email: string) => {
    try {
      const t = await getPracticeTopics(id, email);
      setTopics(t || []);
      setTopicsError("");
    } catch {
      setTopics([]);
      setTopicsError("টপিক তালিকা লোড করা যায়নি। নিচের 'আবার চেষ্টা করুন' বাটনে চাপুন।");
    }
    setPhase("hub");
  };

  // অ্যাক্সেস যাচাই: শিক্ষক সরাসরি; শিক্ষার্থী → যেকোনো একটি কোর্সে এনরোল্ড কিনা।
  // Google uid/email-এ না মিললে আগে যাচাই-কৃত (ফোন/ম্যানুয়াল) পরিচয় দিয়ে চেষ্টা।
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const u = getLocalStudentUser();
      if (!u) {
        if (!cancelled) setPhase("guest");
        return;
      }
      setAccessError("");
      try {
        const teacher = await verifyTeacherSession();
        if (teacher.ok) {
          if (!cancelled) await loadTopics(u.uid, u.email || "");
          return;
        }
        const { checkEnrollmentCached } = await import("@/lib/access-cache");
        let allowed = false;
        let effId = u.uid;
        let effEmail = u.email || "";
        const g = await checkEnrollmentCached(u.uid, u.email);
        if (g.allowed) {
          allowed = true;
        } else {
          const { getVerifiedStudent } = await import("@/lib/student-identity");
          const verified = getVerifiedStudent();
          if (verified && verified.id && verified.id !== u.uid) {
            const alt = await checkEnrollmentCached(verified.id, verified.email);
            if (alt.allowed) {
              allowed = true;
              effId = verified.id;
              effEmail = verified.email || "";
            }
          }
        }
        if (!allowed) {
          if (!cancelled) setPhase("locked");
          return;
        }
        if (!cancelled) await loadTopics(effId, effEmail);
      } catch {
        if (!cancelled) {
          setAccessError("এক্সেস যাচাই করা যায়নি। নেটওয়ার্ক ঠিক আছে কি না দেখে আবার চেষ্টা করুন।");
          setPhase("locked");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const openEnroll = () => {
    if (onOpenEnrollModal) {
      onOpenEnrollModal();
      return;
    }
    if (typeof window !== "undefined") {
      sessionStorage.setItem("open_enroll", "1");
      window.location.href = "/";
    }
  };

  const selectNode = (fullPath: string) => {
    setSelectedTopic(fullPath);
  };

  const openGroup = (node: HubNode) => {
    setActiveGroupPath(node.fullPath);
    setSelectedTopic(node.fullPath); // পুরো গ্রুপ ডিফল্ট টার্গেট
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const backToGroups = () => {
    setActiveGroupPath(null);
  };

  const toggleExpand = (fullPath: string) => {
    setExpandedPaths((prev) => ({ ...prev, [fullPath]: !prev[fullPath] }));
  };

  const activeGroupNode = useMemo(() => {
    if (!activeGroupPath) return null;
    const walk = (nodes: HubNode[]): HubNode | null => {
      for (const n of nodes) {
        if (n.fullPath === activeGroupPath) return n;
        const found = walk(n.children);
        if (found) return found;
      }
      return null;
    };
    return walk(tree);
  }, [tree, activeGroupPath]);

  const availableForSelection = useMemo(() => {
    if (selectedTopic === ALL_LABEL) return totalCount;
    return countMap.get(selectedTopic) ?? 0;
  }, [selectedTopic, countMap, totalCount]);

  const canStart = availableForSelection > 0 && phase === "hub";

  const handleStartPractice = () => {
    if (!canStart) return;
    const params = new URLSearchParams({
      topic: selectedTopic,
      count: String(selectedCount),
      mode: practiceMode
    });
    if (typeof window !== "undefined") {
      setIsStarting(true);
      window.open(`/practice/session?${params.toString()}`, "_blank", "noopener,noreferrer");
      setTimeout(() => setIsStarting(false), 800);
    }
  };

  // গ্রুপ-ডিটেইলে নোড-রো (রিকার্সিভ) — সিলেক্ট + চেভরন-এক্সপ্যান্ড
  const renderNodeRows = (nodes: HubNode[]) => {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedPaths[node.fullPath] ?? false;
      const isSelected = selectedTopic === node.fullPath;
      const row = (
        <div
          key={node.fullPath}
          className={`flex items-center gap-1.5 p-2 rounded-xl border transition cursor-pointer ${
            isSelected
              ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
              : "bg-white border-slate-300 text-black hover:border-indigo-400 hover:bg-indigo-50/40"
          }`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.fullPath);
              }}
              className={`p-0.5 rounded hover:bg-black/10 transition cursor-pointer shrink-0 ${
                isSelected ? "text-white" : "text-slate-400"
              }`}
              aria-label="খুলুন/বন্ধ করুন"
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : (
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${isSelected ? "bg-white" : "bg-indigo-500"}`} />
          )}

          <button
            type="button"
            onClick={() => selectNode(node.fullPath)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left font-bold truncate cursor-pointer"
            title={node.fullPath}
          >
            {hasChildren ? (
              <Layers className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-white" : "text-amber-500"}`} />
            ) : (
              <BookOpen className={`w-3.5 h-3.5 shrink-0 ${isSelected ? "text-white" : "text-indigo-600"}`} />
            )}
            <span className="truncate">{node.name}</span>
            {node.count > 0 && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                  isSelected ? "bg-white/20" : "bg-slate-100 text-slate-600"
                }`}
              >
                {toBengaliDigits(node.count)}টি
              </span>
            )}
          </button>

          {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-white" />}
        </div>
      );

      return (
        <div key={node.fullPath}>
          {row}
          {hasChildren && isExpanded && (
            <div className="ml-3 sm:ml-4 pl-2.5 border-l-2 border-indigo-100 space-y-1 mt-1">
              {renderNodeRows(node.children)}
            </div>
          )}
        </div>
      );
    });
  };

  /* ------------------- গেট ভিউ: গেস্ট / লকড ------------------- */
  if (phase === "loading") {
    return (
      <div className="bg-white rounded-3xl p-10 border border-slate-200 shadow-sm flex flex-col items-center justify-center gap-3 font-bengali text-center">
        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
        <p className="text-sm font-bold text-slate-700">এক্সেস যাচাই করা হচ্ছে...</p>
      </div>
    );
  }

  if (phase === "guest") {
    return (
      <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm text-center space-y-4 font-bengali">
        <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl mx-auto flex items-center justify-center">
          <LogIn className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-black text-slate-900">সেলফ প্র্যাকটিস দেখতে Google লগইন করুন</h3>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            যেকোনো একটি কোর্সে এনরোল্ড থাকলেই <strong>সব বিষয় ও টপিক-গ্রুপের</strong> সব প্রশ্নে
            প্র্যাকটিস করা যায় — উত্তর ও ব্যাখ্যাসহ।
          </p>
        </div>
        <button
          type="button"
          onClick={() => loginWithGoogle(undefined, "/practice")}
          className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-8 py-3 rounded-2xl text-sm cursor-pointer transition"
        >
          Google দিয়ে লগইন করুন
        </button>
      </div>
    );
  }

  if (phase === "locked") {
    return (
      <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm text-center space-y-4 font-bengali">
        <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-2xl mx-auto flex items-center justify-center">
          <Lock className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h3 className="text-base font-black text-slate-900">সেলফ প্র্যাকটিস শুধু এনরোল্ড স্টুডেন্টদের জন্য</h3>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            <strong>যেকোনো একটি কোর্সে</strong> এনরোল করলেই সব টপিক-গ্রুপের সব প্রশ্নে প্র্যাকটিস
            খুলে যায়। লাইভ পরীক্ষার প্রশ্নগুলো পরীক্ষা শেষ হলে স্বয়ংক্রিয়ভাবে এখানে যুক্ত হয়।
          </p>
        </div>
        {accessError && <p className="text-xs text-rose-600 font-semibold">{accessError}</p>}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={openEnroll}
            className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-7 py-3 rounded-2xl text-sm cursor-pointer transition shadow-sm"
          >
            <ShoppingCart className="w-4 h-4" /> কোর্স এনরোল করুন
          </button>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="inline-flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-5 py-3 rounded-2xl text-sm cursor-pointer transition"
          >
            <RotateCcw className="w-4 h-4" /> আবার চেষ্টা করুন
          </button>
        </div>
      </div>
    );
  }

  /* ------------------- হাব ভিউ ------------------- */
  if (topics === null) {
    return (
      <div className="bg-white rounded-3xl p-10 border border-slate-200 shadow-sm flex flex-col items-center justify-center gap-3 font-bengali text-center">
        <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
        <p className="text-sm font-bold text-slate-700">প্রশ্নের তালিকা লোড হচ্ছে...</p>
      </div>
    );
  }

  const groupCardCls = (count: number, isSelected: boolean) =>
    `w-full text-left font-bengali rounded-3xl border shadow-sm hover:shadow-md transition-all duration-200 p-4 sm:p-5 cursor-pointer h-full active:scale-[0.995] ${
      isSelected
        ? "bg-indigo-50 border-indigo-400 ring-2 ring-indigo-200"
        : count > 0
        ? "bg-white border-slate-200 hover:border-indigo-300"
        : "bg-slate-50 border-slate-200 opacity-80"
    }`;

  return (
    <div className="font-bengali space-y-5">
      {/* নিয়ম-হিন্ট */}
      <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3.5 sm:p-4 flex flex-col sm:flex-row gap-2.5 sm:items-center text-[11px] sm:text-xs font-semibold text-indigo-950">
        <span className="flex items-center gap-1.5">
          <Check className="w-4 h-4 text-indigo-600 shrink-0" />
          যেকোনো একটি কোর্সে এনরোল্ড থাকলেই সব টপিক-গ্রুপ আনলক
        </span>
        <span className="hidden sm:inline text-indigo-300">•</span>
        <span className="flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
          লাইভ পরীক্ষা শেষ হলেই তার প্রশ্ন এখানে স্বয়ংক্রিয়ভাবে যুক্ত হয়
        </span>
      </div>

      {topics.length === 0 ? (
        <div className="bg-white rounded-3xl p-8 sm:p-10 border border-slate-200 shadow-sm text-center space-y-3 font-bengali">
          <div className="w-12 h-12 bg-slate-100 text-slate-400 rounded-2xl mx-auto flex items-center justify-center">
            <BookOpen className="w-6 h-6" />
          </div>
          <h3 className="text-base font-black text-slate-800">এখনো কোনো প্র্যাকটিসযোগ্য প্রশ্ন নেই</h3>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            প্রশ্নব্যাংকে প্রশ্ন যুক্ত হলে বা কোনো লাইভ পরীক্ষা শেষ হলে এখানে দেখা যাবে।
          </p>
          {topicsError && <p className="text-xs text-rose-600 font-semibold">{topicsError}</p>}
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-2.5 rounded-xl text-sm cursor-pointer transition"
          >
            <RotateCcw className="w-4 h-4" /> আবার চেষ্টা করুন
          </button>
        </div>
      ) : (
        <>
          {/* ===== টপিক-গ্রুপ কার্ড গ্রিড (Live MCQ স্টাইল) ===== */}
          <section className="bg-white rounded-3xl p-4 sm:p-6 border border-slate-200 shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-200 pb-4 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm shrink-0">
                <Layers className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
                  টপিক-গ্রুপ বেছে নিন
                </h2>
                <p className="text-[11px] sm:text-xs text-slate-500 font-medium">
                  গ্রুপে ট্যাপ করুন — তারপর সাব-টপিক বেছে বা পুরো গ্রুপে প্র্যাকটিস শুরু করুন
                </p>
              </div>
            </div>

            {/* মাস্টার কার্ড — সকল টপিক */}
            <button
              type="button"
              onClick={() => {
                setSelectedTopic(ALL_LABEL);
                setActiveGroupPath(null);
              }}
              className={`w-full text-left rounded-3xl border-2 p-4 sm:p-5 transition cursor-pointer mb-4 ${
                selectedTopic === ALL_LABEL
                  ? "border-indigo-500 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-600/20"
                  : "border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 text-slate-900 hover:border-indigo-400"
              }`}
            >
              <div className="flex items-center gap-3.5">
                <div
                  className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
                    selectedTopic === ALL_LABEL ? "bg-white/20" : "bg-indigo-600"
                  }`}
                >
                  <Sparkles className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-black text-sm sm:text-base leading-tight">সকল টপিক (মিক্সড মডেল টেস্ট)</h3>
                  <p
                    className={`text-[11px] sm:text-xs font-bold mt-0.5 ${
                      selectedTopic === ALL_LABEL ? "text-indigo-100" : "text-indigo-800"
                    }`}
                  >
                    সব গ্রুপের প্রশ্ন এলোমেলো — মোট {toBengaliDigits(totalCount)}টি
                  </p>
                </div>
                {selectedTopic === ALL_LABEL && <Check className="w-5 h-5 shrink-0 text-white" />}
                <span
                  className={`hidden sm:inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-black shrink-0 ${
                    selectedTopic === ALL_LABEL ? "bg-white/20 text-white" : "bg-indigo-600 text-white"
                  }`}
                >
                  নির্বাচন করুন <ChevronRight className="w-4 h-4" />
                </span>
              </div>
            </button>

            {/* গ্রুপ কার্ড গ্রিড */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3">
              {tree.map((group, gi) => {
                const isSelected =
                  selectedTopic === group.fullPath || activeGroupPath === group.fullPath;
                const tile = isSelected ? "bg-white/25" : `bg-gradient-to-br ${colorFor(gi)}`;
                return (
                  <button
                    key={group.fullPath}
                    type="button"
                    onClick={() => openGroup(group)}
                    className={groupCardCls(group.count, isSelected)}
                    title={`${group.fullPath} — ${toBengaliDigits(group.count)}টি প্রশ্ন`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className={`w-10 h-10 rounded-xl text-white flex items-center justify-center font-black text-base shadow-sm shrink-0 ${tile}`}
                      >
                        {group.name.trim().charAt(0)}
                      </div>
                      {group.count > 0 ? (
                        <span className="text-[11px] font-black bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full shrink-0">
                          {toBengaliDigits(group.count)}টি
                        </span>
                      ) : (
                        <span className="text-[11px] font-black bg-slate-100 text-slate-400 px-2 py-0.5 rounded-full shrink-0">
                          আসছে
                        </span>
                      )}
                    </div>
                    <h3 className="font-black text-slate-900 text-xs sm:text-sm mt-2.5 leading-snug line-clamp-2">
                      {group.name}
                    </h3>
                    <p className="text-[11px] text-slate-500 font-semibold mt-1 flex items-center gap-1">
                      <ChevronRight className="w-3 h-3 shrink-0" />
                      {hasNested ? "গ্রুপ খুলে টপিক দেখুন" : "প্র্যাকটিস শুরু করুন"}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ===== গ্রুপ ডিটেইল: সাব-টপিক তালিকা ===== */}
          {activeGroupNode && hasNested && (
            <section
              ref={detailRef}
              className="bg-white rounded-3xl p-4 sm:p-6 border border-slate-200 shadow-sm scroll-mt-20"
            >
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4 mb-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={backToGroups}
                    className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer shrink-0"
                    aria-label="সব টপিক-গ্রুপে ফিরুন"
                  >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                  </button>
                  <div className="min-w-0">
                    <h2 className="text-base sm:text-lg font-black text-slate-900 truncate">
                      {activeGroupNode.name}
                    </h2>
                    <p className="text-[11px] sm:text-xs text-slate-500 font-semibold">
                      {toBengaliDigits(activeGroupNode.count)}টি প্রশ্ন এই গ্রুপে — সাব-টপিক বেছে নিন বা পুরো
                      গ্রুপে দিন
                    </p>
                  </div>
                </div>
                <span className="text-[11px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full shrink-0">
                  {activeGroupNode.name} — {toBengaliDigits(activeGroupNode.count)}টি
                </span>
              </div>

              <div className="space-y-1 max-h-[60vh] overflow-y-auto pr-1">
                {/* পুরো গ্রুপ রো */}
                <div
                  className={`flex items-center gap-1.5 p-2 rounded-xl border transition cursor-pointer ${
                    selectedTopic === activeGroupNode.fullPath
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                      : "bg-gradient-to-r from-indigo-50 to-white border-slate-300 text-black hover:border-indigo-400"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ml-1 ${
                      selectedTopic === activeGroupNode.fullPath ? "bg-white" : "bg-indigo-500"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => selectNode(activeGroupNode.fullPath)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left font-bold truncate cursor-pointer"
                  >
                    <Sparkles
                      className={`w-3.5 h-3.5 shrink-0 ${
                        selectedTopic === activeGroupNode.fullPath ? "text-white" : "text-amber-500"
                      }`}
                    />
                    <span className="truncate">পুরো {activeGroupNode.name} গ্রুপ (মিক্সড)</span>
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${
                        selectedTopic === activeGroupNode.fullPath ? "bg-white/20" : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {toBengaliDigits(activeGroupNode.count)}টি
                    </span>
                  </button>
                  {selectedTopic === activeGroupNode.fullPath && (
                    <Check className="w-3.5 h-3.5 shrink-0 text-white" />
                  )}
                </div>

                {renderNodeRows(activeGroupNode.children)}
              </div>



              <p className="text-[11px] text-slate-400 mt-3 font-medium">
                💡 টপিক বাছাই করে সবচেয়ে নিচের &ldquo;প্র্যাকটিস শুরু করুন&rdquo; চাপুন — সাব-টপিক বাছাই করলে শুধু সেই অংশের
                প্রশ্ন আসবে।
              </p>
            </section>
          )}
          {/* ===== নির্বাচন + কনফিগ বার (সব ভিউতে) ===== */}
          <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex items-center gap-2 text-xs sm:text-sm">
                <span className="text-slate-500 font-semibold shrink-0">🎯 নির্বাচিত:</span>
                <strong className="text-indigo-900 truncate">{selectedTopic}</strong>
                {availableForSelection > 0 && (
                  <span className="text-slate-400 font-semibold shrink-0">
                    ({toBengaliDigits(availableForSelection)}টি প্রশ্ন)
                  </span>
                )}
              </div>
              <span className="text-[11px] sm:text-xs font-bold text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full shrink-0">
                মোট {toBengaliDigits(totalCount)}টি প্রশ্ন
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-4 lg:items-center">
              {/* ২. প্রশ্নের সংখ্যা */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black text-slate-800">প্রশ্নের সংখ্যা:</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {QUESTION_COUNTS.map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setSelectedCount(cnt)}
                      className={`py-1.5 px-2 rounded-xl text-xs font-black transition cursor-pointer border-2 ${
                        selectedCount === cnt
                          ? "bg-black border-black text-white shadow-sm"
                          : "bg-white/80 border-slate-300 text-black hover:bg-slate-50"
                      }`}
                    >
                      {toBengaliDigits(cnt)}টি
                    </button>
                  ))}
                </div>
              </div>

              {/* ৩. মোড */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-black text-slate-800">মোড:</span>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setPracticeMode("instant")}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black transition cursor-pointer border-2 ${
                      practiceMode === "instant"
                        ? "bg-black border-black text-white shadow-sm"
                        : "bg-white/80 border-slate-300 text-black hover:bg-slate-50"
                    }`}
                  >
                    ইনস্ট্যান্ট <span className="font-bold opacity-70">(ক্লিকেই উত্তর)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPracticeMode("exam")}
                    className={`px-3 py-1.5 rounded-xl text-xs font-black transition cursor-pointer border-2 ${
                      practiceMode === "exam"
                        ? "bg-black border-black text-white shadow-sm"
                        : "bg-white/80 border-slate-300 text-black hover:bg-slate-50"
                    }`}
                  >
                    মক টেস্ট <span className="font-bold opacity-70">(টাইমারসহ)</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1 border-t border-indigo-100 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-[11px] sm:text-xs text-slate-500">
                {practiceMode === "instant"
                  ? "উত্তর দিলেই সাথে সাথে সঠিক উত্তর ও ব্যাখ্যা দেখতে পাবেন।"
                  : "টাইমারসহ পুরো তালিকা — জমা দেওয়ার পর স্কোরকার্ড ও সমাধান রিভিউ।"}
              </p>
              <button
                type="button"
                disabled={!canStart || isStarting}
                onClick={handleStartPractice}
                className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 text-white font-bold px-8 py-3 rounded-2xl text-xs sm:text-sm shadow-md transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  canStart ? "bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] shadow-indigo-600/20" : "bg-slate-400"
                }`}
              >
                {isStarting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> উইন্ডো খুলছে...
                  </>
                ) : canStart ? (
                  <>
                    <Play className="w-4 h-4 fill-white" /> প্র্যাকটিস শুরু করুন
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" /> এই নির্বাচনে এখনো প্রশ্ন নেই
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
