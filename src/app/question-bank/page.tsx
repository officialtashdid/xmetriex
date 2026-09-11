"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Header } from "@/components/shared/Header";
import { Footer } from "@/components/shared/Footer";
import {
  BookOpen,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Layers,
  Lightbulb,
  Loader2,
  Lock,
  LogIn,
  Maximize2,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { getPracticeTopics, getPracticeQuestions } from "@/actions/practice-actions";
import { verifyTeacherSession } from "@/actions/admin-actions";
import { getLocalStudentUser, loginWithGoogle } from "@/lib/student-auth";
import { toBengaliDigits } from "@/lib/utils";
import { buildTopicGroupTree, colorFor, pruneEmptyNodes, type HubNode } from "@/lib/topic-group";
import { LoadingState } from "@/components/shared/LoadingState";

/**
 * প্রশ্নব্যাংক — সেলফ প্র্যাকটিস হাবের মতোই টপিক-গ্রুপ কার্ড গ্রিডে সাজানো।
 * টপিক/গ্রুপে ট্যাপ করলেই সেই অংশের সব প্রশ্ন (উত্তর ও ব্যাখ্যাসহ) পড়া যায়।
 * অ্যাক্সেস নিয়ম অপরিবর্তিত: যেকোনো একটি কোর্সে এনরোল্ড (বা শিক্ষক) = সব পড়া যায়;
 * লাইভ (নির্ধারিত) পরীক্ষার প্রশ্ন ফলাফল-সময়ের আগে দেখানো হয় না — সার্ভার-সাইড।
 */

interface BankQ {
  id: string;
  q: string;
  opts: string[];
  correct: number;
  exp?: string;
  subject?: string;
  topic?: string;
}

interface TopicEntry {
  name: string;
  count: number;
}

const optLabels = ["ক", "খ", "গ", "ঘ"];

// টপিক-তালিকা লোকাল cache — আবার পেজ খুললে সাথে সাথে পুরনো তালিকা দেখায়,
// পেছনে সার্ভার থেকে নতুন কাউন্ট আপডেট হয় (সংক্ষিপ্ত TTL, নিরাপদ)।
const TOPICS_CACHE_PREFIX = "csp_qbank_topics_";
const TOPICS_CACHE_TTL_MS = 90 * 1000; // ৯০ সেকেন্ড

function readTopicsCache(uid: string): TopicEntry[] | null {
  if (typeof window === "undefined" || !uid) return null;
  try {
    const raw = localStorage.getItem(TOPICS_CACHE_PREFIX + uid);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.list)) return null;
    if (Date.now() - Number(parsed.ts || 0) > TOPICS_CACHE_TTL_MS) return null;
    return parsed.list as TopicEntry[];
  } catch {
    return null;
  }
}

function writeTopicsCache(uid: string, list: TopicEntry[]): void {
  if (typeof window === "undefined" || !uid) return;
  try {
    localStorage.setItem(TOPICS_CACHE_PREFIX + uid, JSON.stringify({ list, ts: Date.now() }));
  } catch {
    // ignore (private mode) — শুধু গতি, মূল ফিচার নয়
  }
}

// রিডিং-এ একবারে রেন্ডার হওয়া প্রশ্নের সংখ্যা (সব লোড হয়; বাকিগুলো "আরও দেখুন"-এ আসে)
const READ_CHUNK = 200;

export default function QuestionBankPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ uid: string; name: string; email?: string } | null>(null);
  const [entries, setEntries] = useState<TopicEntry[]>([]);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessId, setAccessId] = useState("");
  const [accessEmail, setAccessEmail] = useState("");

  // রিডিং স্টেট
  const [questions, setQuestions] = useState<BankQ[]>([]);
  const [selectedLabel, setSelectedLabel] = useState("");
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(READ_CHUNK);

  // হাব (টপিক-গ্রুপ) স্টেট
  const [activeGroupPath, setActiveGroupPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const detailRef = useRef<HTMLDivElement | null>(null);

  // ০-প্রশ্ন গ্রুপ বাদ দিয়ে দেখাই — যা কার্ডে দেখা যায়, তাতে ট্যাপ করলে প্রশ্ন
  // পাওয়া নিশ্চিত (আগে খালি গ্রুপে ঢুকে "কোনো প্রশ্ন নেই" দেখাত)।
  const rawTree = useMemo(() => buildTopicGroupTree(entries), [entries]);
  const tree = useMemo(() => pruneEmptyNodes(rawTree), [rawTree]);
  const hiddenGroups = rawTree.length - tree.length;
  const totalCount = useMemo(() => tree.reduce((s, n) => s + n.count, 0), [tree]);
  const hasNested = useMemo(() => tree.some((n) => n.children.length > 0), [tree]);

  useEffect(() => {
    const u = getLocalStudentUser();
    setUser(u);
    if (!u) return;

    (async () => {
      try {
        const teacher = await verifyTeacherSession();
        // কার্যকর পরিচয়: Google uid/email-ই প্রথম। এতে এনরোলমেন্ট না মিললে
        // আগে যাচাই-কৃত (ফোন/ম্যানুয়াল) পরিচয় দিয়ে চেষ্টা — পুরনো
        // ইমেইলবিহীন ফোন-এনরোলমেন্টের শিক্ষার্থীরাও যেন প্রশ্ন পড়তে পারেন।
        let effId = u.uid;
        let effEmail = u.email;
        if (!teacher.ok) {
          const { checkEnrollmentCached } = await import("@/lib/access-cache");
          let allowed = false;
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
          setEnrolled(allowed);
          if (!allowed) return;
        } else {
          setEnrolled(true);
        }
        setAccessId(effId);
        setAccessEmail(effEmail || "");

        // দ্রুত খোলা: পরিচয় ঠিক হলেই লোকাল cache-এর তালিকা সাথে সাথে দেখাই —
        // তারপর পেছনে সার্ভার থেকে নতুন কাউন্ট এনে cache হালনাগাদ হয়।
        const cached = readTopicsCache(effId || effEmail);
        if (cached && cached.length > 0) {
          setEntries(cached);
        }

        const t = await getPracticeTopics(effId, effEmail);
        const mapped = (t || []).map((x: { name: string; count: number }) => ({
          name: x.name,
          count: x.count
        }));
        setEntries(mapped);
        if (mapped.length > 0) {
          writeTopicsCache(effId || effEmail, mapped);
        }
      } catch {
        setLoadError("সার্ভার থেকে তথ্য লোড করা যায়নি। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openTopic = async (value: string, label: string) => {
    if (!user) return;
    setBusy(true);
    setLoadError("");
    setRevealed(new Set());
    try {
      // count=0 → সার্ভার থেকে এই নির্বাচনের (গ্রুপ/টপিক/সাবটপিক) সব প্রশ্ন আসে —
      // ৫০-এর ক্যাপ ছাড়া। খালি value = সব টপিক।
      const qs = await getPracticeQuestions(value, 0, accessId || user.uid, accessEmail || user.email);
      if (!qs || qs.length === 0) {
        setLoadError(
          "এই নির্বাচনে বর্তমানে দেখানোর মতো প্রশ্ন পাওয়া যায়নি — নির্ধারিত (লাইভ) পরীক্ষার প্রশ্ন ফলাফল প্রকাশের আগে প্রশ্নব্যাংকে দেখানো হয় না। অন্য বিষয়/টপিক বেছে নিন।"
        );
        setBusy(false);
        return;
      }
      setQuestions(qs);
      setSelectedLabel(label);
      setVisibleCount(READ_CHUNK);
      setFullscreen(false);
      window.scrollTo({ top: 0 });
    } catch {
      setLoadError("প্রশ্ন লোড করা যায়নি। আবার চেষ্টা করুন।");
    }
    setBusy(false);
  };

  const backToBank = () => {
    setQuestions([]);
    setLoadError("");
    setRevealed(new Set());
    setFullscreen(false);
    setVisibleCount(READ_CHUNK);
  };

  const openGroup = (node: HubNode) => {
    // ফ্ল্যাট (কোনো সাব-টপিক নেই) হলে সরাসরি পড়া শুরু; নাহলে গ্রুপ-ডিটেইল খুলি
    if (!hasNested) {
      openTopic(node.fullPath, node.fullPath);
      return;
    }
    setActiveGroupPath(node.fullPath);
    // গ্রুপের নিচের সব শাখা একসাথে খোলা দেখাই — যাতে কোনো সাব-টপিক "লুকিয়ে" না থাকে
    if (node.children.length > 0) expandBranch(node);
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const backToGroups = () => {
    setActiveGroupPath(null);
  };

  const toggleExpand = (fullPath: string) => {
    setExpandedPaths((prev) => ({ ...prev, [fullPath]: !prev[fullPath] }));
  };

  // একটি নোডের নিচের সব শাখা (সব গভীরতায়) প্রসারিত অবস্থায় চিহ্নিত করে —
  // গ্রুপে ক্লিক করলেই সম্পূর্ণ সাব-শাখা একসাথে দেখাতে।
  const collectPaths = (node: HubNode): string[] =>
    node.children.flatMap((c) => [c.fullPath, ...collectPaths(c)]);

  const expandBranch = (node: HubNode) => {
    setExpandedPaths((prev) => {
      const next = { ...prev };
      collectPaths(node).forEach((p) => (next[p] = true));
      return next;
    });
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

  const toggleReveal = (idx: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const revealAll = () => setRevealed(new Set(questions.map((_, i) => i)));

  // ফুল-স্ক্রিন মোডে: Escape চাপলে বন্ধ + পেছনের পেজ স্ক্রল আটকানো
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // প্রশ্ন-কার্ড তালিকা (ইনলাইন ও ফুল-স্ক্রিন — দুটোতেই একই)
  const renderQuestionCardsList = () => (
    <div className="space-y-3">
      {questions.slice(0, visibleCount).map((q, idx) => {
        const isOpen = revealed.has(idx);
        return (
          <div key={q.id || idx} className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
            <p className="text-sm font-bold text-slate-900 leading-relaxed">
              {toBengaliDigits(idx + 1)}. {q.q}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2.5">
              {q.opts.map((opt, oIdx) => (
                <div
                  key={oIdx}
                  className={`p-2.5 rounded-xl border flex items-center gap-2 text-xs ${
                    isOpen && oIdx === q.correct
                      ? "border-emerald-300 bg-emerald-50 text-emerald-950 font-bold"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  <span className="w-5 h-5 rounded-md flex items-center justify-center text-xs font-bold shrink-0 bg-slate-800 text-white">
                    {optLabels[oIdx]}
                  </span>
                  <span>{opt}</span>
                  {isOpen && oIdx === q.correct && (
                    <span className="ml-auto text-emerald-700 font-bold shrink-0">✓ সঠিক</span>
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => toggleReveal(idx)}
              className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
            >
              {isOpen ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {isOpen ? "উত্তর লুকান" : "সঠিক উত্তর ও ব্যাখ্যা দেখুন"}
            </button>

            {isOpen && q.exp && (
              <div className="mt-2 p-3 rounded-xl bg-amber-50/70 border border-amber-200 text-xs text-slate-700 leading-relaxed flex gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-amber-900">ব্যাখ্যা:</strong> {q.exp}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {visibleCount < questions.length && (
        <div className="flex flex-col items-center gap-2.5 pt-2 pb-4">
          <p className="text-[11px] font-bold text-slate-400">
            মোট {toBengaliDigits(questions.length)}টির মধ্যে {toBengaliDigits(visibleCount)}টি দেখানো হচ্ছে
          </p>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <button
              type="button"
              onClick={() => setVisibleCount((v) => Math.min(questions.length, v + READ_CHUNK))}
              className="bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold px-5 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
            >
              <BookOpen className="w-4 h-4" /> আরও{" "}
              {toBengaliDigits(Math.min(READ_CHUNK, questions.length - visibleCount))}টি প্রশ্ন দেখুন
            </button>
            <button
              type="button"
              onClick={() => setVisibleCount(questions.length)}
              className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-5 py-2.5 rounded-xl text-xs cursor-pointer transition"
            >
              সবগুলো দেখান ({toBengaliDigits(questions.length)}টি)
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // টপিক-রো (রিকার্সিভ) — চেভরনে এক্সপ্যান্ড, পুরো রো বড় "পড়ুন" বাটন
  const renderNodeRows = (nodes: HubNode[]) => {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedPaths[node.fullPath] ?? false;
      const nodeName = node.name.trim();
      const accent = nodeName.charAt(0);
      return (
        <div key={node.fullPath}>
          <div className="flex items-stretch gap-1.5 p-1.5 sm:p-2 rounded-2xl border transition bg-white border-slate-200 hover:border-indigo-400 hover:shadow-sm">
            {/* শুধু নেস্টেড টপিকের expand/colapse (পড়ার জন্য নয়) */}
            {hasChildren && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand(node.fullPath);
                }}
                className="shrink-0 w-9 sm:w-10 self-stretch rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center transition cursor-pointer"
                aria-label="সাব-টপিক খুলুন/বন্ধ করুন"
                title={isExpanded ? "সাব-টপিক বন্ধ করুন" : "সাব-টপিক খুলুন"}
              >
                <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
              </button>
            )}

            {/* পুরো রো = বড় পড়ুন বাটন */}
            <button
              type="button"
              onClick={() => openTopic(node.fullPath, node.fullPath)}
              className="flex-1 min-w-0 rounded-xl px-2.5 py-2 sm:px-3 flex items-center gap-2.5 text-left cursor-pointer group transition"
              title={`${node.fullPath} — পড়ুন`}
            >
              {hasChildren ? (
                <span className="shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 text-white flex items-center justify-center text-sm font-black shadow-sm">
                  {accent}
                </span>
              ) : (
                <span className="shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center text-sm font-black shadow-sm">
                  {accent}
                </span>
              )}
              <span className="min-w-0 flex-1">
                {/* মোবাইলে নাম কাটা পড়ত (truncate) — এখন পুরো নাম wrap হয়ে দেখা যায় */}
                <span className="block font-black text-slate-900 text-sm sm:text-base leading-snug break-words group-hover:text-indigo-700 transition">
                  {node.name}
                </span>
                {hasChildren && (
                  <span className="block text-[11px] text-slate-400 font-semibold">
                    {isExpanded ? "সাব-টপিক খোলা আছে" : "গ্রুপ — ভেতরে সাব-টপিক আছে"}
                  </span>
                )}
              </span>
              {node.count > 0 && (
                <span className="shrink-0 text-[11px] font-black bg-slate-100 text-slate-600 px-2 py-1 rounded-full">
                  {toBengaliDigits(node.count)}টি
                </span>
              )}
              <span className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 text-white text-[11px] sm:text-xs font-black px-2.5 sm:px-3 py-2 shadow-sm group-hover:bg-indigo-700 transition">
                <span className="hidden sm:inline">পড়ুন</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </span>
            </button>
          </div>

          {hasChildren && isExpanded && (
            <div className="ml-4 sm:ml-6 pl-2 sm:pl-3 border-l-2 border-indigo-100 space-y-1 mt-1.5">
              {renderNodeRows(node.children)}
            </div>
          )}
        </div>
      );
    });
  };

  const groupCardCls = (count: number, isActive: boolean) =>
    `w-full text-left font-bengali rounded-3xl border shadow-sm hover:shadow-md transition-all duration-200 p-4 sm:p-5 cursor-pointer h-full active:scale-[0.995] ${
      isActive
        ? "bg-indigo-50 border-indigo-400 ring-2 ring-indigo-200"
        : count > 0
        ? "bg-white border-slate-200 hover:border-indigo-300"
        : "bg-slate-50 border-slate-200 opacity-80"
    }`;

  return (
    <>
      <Header />

      {/* টপিক/গ্রুপ খোলার সময় — পূর্ণ-স্ক্রিন অ্যানিমেটেড লোডিং (কিছু সময় নিলে বোঝা যায়) */}
      {busy && (
        <div className="fixed inset-0 z-[70] bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm">
            <LoadingState
              label="প্রশ্ন লোড হচ্ছে..."
              hint="শুধু নির্বাচিত টপিকের প্রশ্ন আনা হচ্ছে"
              variant="card"
            />
          </div>
        </div>
      )}

      <main className="flex-grow max-w-6xl w-full mx-auto p-3 sm:p-5 md:p-6 font-bengali space-y-5">
        {/* Page header */}
        <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-3xl p-5 sm:p-7 shadow-sm border border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center shrink-0">
              <Layers className="w-6 h-6 text-indigo-300" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black leading-tight tracking-tight">প্রশ্নব্যাংক</h1>
              <p className="text-xs sm:text-sm text-slate-400">
                টপিক-গ্রুপ বেছে নিন — সঠিক উত্তর ও ব্যাখ্যাসহ বিস্তারিত পড়ুন
              </p>
            </div>
          </div>
        </div>

        {/* gates */}
        {!user && (
          <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-sm text-center space-y-4">
            <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl mx-auto flex items-center justify-center">
              <LogIn className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-black text-slate-900">প্রশ্নব্যাংক দেখতে Google লগইন করুন</h3>
              <p className="text-xs sm:text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
                এনরোল্ড শিক্ষার্থীরাই চ্যাপ্টারভিত্তিক প্রশ্নব্যাংক পড়তে পারেন।
              </p>
            </div>
            <button
              type="button"
              onClick={() => loginWithGoogle(undefined, "/question-bank")}
              className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-8 py-3 rounded-2xl text-sm cursor-pointer"
            >
              Google দিয়ে লগইন করুন
            </button>
          </div>
        )}

        {user && enrolled === false && (
          <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm text-center space-y-3">
            <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-2xl mx-auto flex items-center justify-center">
              <Lock className="w-6 h-6" />
            </div>
            <p className="text-sm font-bold text-slate-800">প্রশ্নব্যাংক শুধু এনরোল্ড স্টুডেন্টদের জন্য</p>
            <p className="text-xs text-slate-500">
              যেকোনো একটি কোর্সে এনরোল করে শিক্ষকের অনুমোদন পেলে এই সেকশন খুলে যাবে।
            </p>
            <button
              type="button"
              onClick={() => {
                sessionStorage.setItem("open_enroll", "1");
                router.push("/");
              }}
              className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-6 py-2.5 rounded-xl text-sm cursor-pointer transition shadow-sm"
            >
              <ShoppingCart className="w-4 h-4" /> কোর্স এনরোল করুন
            </button>
          </div>
        )}

        {user && enrolled === null && (
          <LoadingState
            label="এক্সেস যাচাই হচ্ছে..."
            hint="আপনার এনরোলমেন্ট ও টপিক-তালিকা প্রস্তুত করা হচ্ছে"
            variant="card"
          />
        )}

        {loadError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3.5 rounded-2xl">{loadError}</div>
        )}

        {/* ============ টপিক-গ্রুপ হাব (সেলফ প্র্যাকটিসের মতো সাজানো) ============ */}
        {user && enrolled === true && questions.length === 0 && (
          <section className="space-y-5">
            {/* নিয়ম-হিন্ট */}
            <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3.5 sm:p-4 flex flex-col sm:flex-row gap-2.5 sm:items-center text-[11px] sm:text-xs font-semibold text-indigo-950">
              <span className="flex items-center gap-1.5">
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                যেকোনো একটি কোর্সে এনরোল্ড থাকলেই সব টপিক-গ্রুপের প্রশ্ন পড়া যায়
              </span>
              <span className="hidden sm:inline text-indigo-300">•</span>
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
                লাইভ পরীক্ষা শেষ হলেই তার প্রশ্ন এখানে স্বয়ংক্রিয়ভাবে যুক্ত হয়
              </span>
            </div>

            {tree.length === 0 ? (
              <div className="bg-white rounded-3xl p-8 sm:p-10 border border-slate-200 shadow-sm text-center space-y-3">
                <div className="w-12 h-12 bg-slate-100 text-slate-400 rounded-2xl mx-auto flex items-center justify-center">
                  <BookOpen className="w-6 h-6" />
                </div>
                <h3 className="text-base font-black text-slate-800">এখনো পড়ার মতো কোনো প্রশ্ন নেই</h3>
                <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
                  প্রশ্নব্যাংকে প্রশ্ন যুক্ত হলে বা কোনো লাইভ পরীক্ষা শেষ হলে এখানে দেখা যাবে।
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold px-6 py-2.5 rounded-xl text-sm cursor-pointer transition"
                >
                  <RotateCcw className="w-4 h-4" /> আবার চেষ্টা করুন
                </button>
              </div>
            ) : (
              <>
                {/* মাস্টার কার্ড — সব টপিক */}
                <button
                  type="button"
                  onClick={() => openTopic("", "সব টপিক (সম্পূর্ণ প্রশ্নব্যাংক)")}
                  className="w-full text-left rounded-3xl border-2 p-4 sm:p-5 transition cursor-pointer bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-600/20 border-indigo-500 hover:from-indigo-700 hover:to-violet-700"
                >
                  <div className="flex items-center gap-3.5">
                    <div className="w-11 h-11 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                      <Sparkles className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-black text-sm sm:text-base leading-tight">সব টপিক (সম্পূর্ণ প্রশ্নব্যাংক)</h3>
                      <p className="text-[11px] sm:text-xs font-bold text-indigo-100 mt-0.5">
                        সব গ্রুপের প্রশ্ন একসাথে পড়ুন — মোট {toBengaliDigits(totalCount)}টি
                      </p>
                    </div>
                    <span className="hidden sm:inline-flex items-center gap-1 rounded-xl bg-white/20 text-white px-3 py-2 text-xs font-black shrink-0">
                      পড়া শুরু করুন <ChevronRight className="w-4 h-4" />
                    </span>
                  </div>
                </button>

                {/* টপিক-গ্রুপ হেডার */}
                <div className="bg-white rounded-3xl p-4 sm:p-6 border border-slate-200 shadow-sm">
                  <div className="flex items-center gap-3 border-b border-slate-200 pb-4 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white flex items-center justify-center shadow-sm shrink-0">
                      <Layers className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
                        টপিক-গ্রুপ বেছে নিন
                      </h2>
                      <p className="text-[11px] sm:text-xs text-slate-500 font-medium">
                        গ্রুপে ট্যাপ করুন — তারপর সাব-টপিক বেছে পড়া শুরু করুন
                      </p>
                    </div>
                    <span className="text-[11px] sm:text-xs font-bold text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full shrink-0">
                      মোট {toBengaliDigits(totalCount)}টি প্রশ্ন
                    </span>
                  </div>

                  {/* গ্রুপ কার্ড গ্রিড */}
                  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3">
                    {tree.map((group, gi) => {
                      const isActive = activeGroupPath === group.fullPath;
                      const tile = isActive ? "bg-white/25" : `bg-gradient-to-br ${colorFor(gi)}`;
                      return (
                        <button
                          key={group.fullPath}
                          type="button"
                          onClick={() => openGroup(group)}
                          className={groupCardCls(group.count, isActive)}
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
                          {/* মোবাইলে ২ লাইনে নাম কাটা পড়ত — এখন ৩ লাইন + শব্দ-ভাঙা */}
                          <h3 className="font-black text-slate-900 text-sm sm:text-base mt-2.5 leading-snug line-clamp-3 break-words">
                            {group.name}
                          </h3>
                          <p className="text-xs text-slate-500 font-semibold mt-1 flex items-center gap-1">
                            <ChevronRight className="w-3 h-3 shrink-0" />
                            {hasNested ? "গ্রুপ খুলে টপিক দেখুন" : "প্রশ্ন পড়ুন"}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  {/* খালি গ্রুপগুলো এখানে দেখানো হয় না (ট্যাপ করলে প্রশ্ন পাওয়া যায় না) */}
                  {hiddenGroups > 0 && (
                    <p className="text-[11px] sm:text-xs text-slate-400 font-semibold mt-4 leading-relaxed flex items-start gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                      <span>
                        আরও {toBengaliDigits(hiddenGroups)}টি টপিক-গ্রুপের প্রশ্ন এখনো প্রস্তুত হয়নি বা লাইভ পরীক্ষার
                        উত্তর প্রকাশের অপেক্ষায় আছে — প্রস্তুত হলেই এখানে স্বয়ংক্রিয়ভাবে যুক্ত হবে।
                      </span>
                    </p>
                  )}
                </div>

                {/* গ্রুপ ডিটেইল: সাব-টপিক তালিকা */}
                {activeGroupNode && hasNested && (
                  <div
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
                          <h2 className="text-base sm:text-lg font-black text-slate-900 leading-snug break-words">
                            {activeGroupNode.name}
                          </h2>
                          <p className="text-[11px] sm:text-xs text-slate-500 font-semibold">
                            {toBengaliDigits(activeGroupNode.count)}টি প্রশ্ন এই গ্রুপে — টপিকে ট্যাপ করলেই পড়া শুরু
                          </p>
                        </div>
                      </div>
                      <span className="text-[11px] font-black text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full shrink-0">
                        {activeGroupNode.name} — {toBengaliDigits(activeGroupNode.count)}টি
                      </span>
                    </div>

                    <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
                      {/* পুরো গ্রুপ পড়ুন — বড় পরিষ্কার বাটন */}
                      <button
                        type="button"
                        onClick={() => openTopic(activeGroupNode.fullPath, activeGroupNode.fullPath)}
                        className="w-full flex items-center gap-2.5 p-2.5 sm:p-3 rounded-2xl border transition cursor-pointer bg-gradient-to-r from-indigo-600 to-violet-600 border-indigo-600 text-white hover:from-indigo-700 hover:to-violet-700 hover:shadow-md group"
                        title={`পুরো ${activeGroupNode.name} গ্রুপ পড়ুন`}
                      >
                        <span className="shrink-0 w-8 h-8 rounded-lg bg-white/20 text-white flex items-center justify-center text-sm font-black">
                          <Sparkles className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-black text-sm sm:text-base leading-snug break-words">
                            পুরো {activeGroupNode.name} গ্রুপ পড়ুন (মিক্সড)
                          </span>
                          <span className="block text-[11px] text-indigo-100 font-semibold">
                            সাব-টপিক ভেদে না গিয়ে সব প্রশ্ন একসাথে পড়ুন
                          </span>
                        </span>
                        {activeGroupNode.count > 0 && (
                          <span className="shrink-0 text-[11px] font-black bg-white/20 text-white px-2.5 py-1 rounded-full">
                            {toBengaliDigits(activeGroupNode.count)}টি
                          </span>
                        )}
                        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-white text-indigo-700 text-[11px] sm:text-xs font-black px-3 py-2 shadow-sm">
                          পড়ুন <ChevronRight className="w-3.5 h-3.5" />
                        </span>
                      </button>

                      {renderNodeRows(activeGroupNode.children)}
                    </div>

                    <p className="text-[11px] text-slate-400 mt-3 font-medium">
                      💡 যেকোনো টপিক/সাব-টপিকে ট্যাপ করলেই সেই অংশের সব প্রশ্ন উত্তর ও ব্যাখ্যাসহ খুলে যাবে — বড়
                      হলে ধাপে ধাপে লোড হয়।
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* ============ Reading detail (ইনলাইন) ============ */}
        {questions.length > 0 && !fullscreen && (
          <section className="space-y-4">
            <div className="bg-white rounded-3xl p-4 sm:p-5 border border-slate-200 shadow-sm flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={backToBank}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-bold cursor-pointer"
                >
                  ← প্রশ্নব্যাংকে ফিরে যান
                </button>
                <h2 className="font-black text-slate-900 text-sm sm:text-base truncate mt-1">{selectedLabel}</h2>
                <p className="text-xs text-slate-400 font-semibold">{toBengaliDigits(questions.length)}টি প্রশ্ন</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={revealAll}
                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Eye className="w-4 h-4" /> সব উত্তর দেখুন
                </button>
                <button
                  type="button"
                  onClick={() => setFullscreen(true)}
                  className="bg-slate-900 hover:bg-slate-800 text-white font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Maximize2 className="w-4 h-4" /> ফুল স্ক্রিনে পড়ুন
                </button>
              </div>
            </div>

            {renderQuestionCardsList()}
          </section>
        )}

        {/* ============ ফুল-স্ক্রিন রিডিং (ওভারলে) ============ */}
        {fullscreen && questions.length > 0 && (
          <div className="fixed inset-0 z-[80] bg-white overflow-y-auto font-bengali">
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={backToBank}
                  className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-bold cursor-pointer"
                >
                  ← প্রশ্নব্যাংকে ফিরে যান
                </button>
                <h2 className="font-black text-slate-900 text-sm sm:text-base truncate mt-1">{selectedLabel}</h2>
                <p className="text-xs text-slate-400 font-semibold">{toBengaliDigits(questions.length)}টি প্রশ্ন</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={revealAll}
                  className="bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Eye className="w-4 h-4" /> সব উত্তর দেখুন
                </button>
                <button
                  type="button"
                  onClick={() => setFullscreen(false)}
                  className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-3.5 py-2 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition"
                >
                  <X className="w-4 h-4" /> ফুল স্ক্রিন বন্ধ
                </button>
              </div>
            </div>

            <div className="max-w-4xl mx-auto p-4 sm:p-6">{renderQuestionCardsList()}</div>
          </div>
        )}
      </main>

      <Footer />
    </>
  );
}
