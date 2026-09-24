"use server";

import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import type { PracticeQuestion, TopicOption } from "@/lib/practice-helper";
import { loadAnswerLockState, isQuestionLocked } from "@/lib/answer-lock";
import { resolveStudyIdentity } from "@/lib/student-session";

/**
 * Server-side Self-Practice data.
 *
 * Previously the home page shipped the ENTIRE topic_questions table + every
 * exam's questions to the client just to build the practice pool. Now the
 * questions are fetched from the database only when a practice session
 * actually starts — the home page stays light.
 *
 * SECURITY (এই ফাইলে দুটি বড় সংশোধন):
 *  ১. পরিচয় এখন **সেশনের** উপর নির্ভর করে, ক্লায়েন্টের পাঠানো id/email-এর উপর নয়
 *     (lib/student-session.ts)। আগে যে কেউ একজন এনরোল্ড ছাত্রের ফোন নম্বর জানলেই
 *     লগইন ছাড়া পুরো পেইড প্রশ্নব্যাংক উত্তর সহ বের করে নিতে পারত।
 *  ২. উত্তর-লক এখন **প্রশ্নের পরিচয়** ধরে, পরীক্ষার key ধরে নয়
 *     (lib/answer-lock.ts)। আগে ব্যাংক থেকে লিংক করা (recycled) প্রশ্নের উত্তর
 *     লাইভ পরীক্ষা চলাকালীন পুরো সময় ফাঁস হতো।
 *
 * নিয়ম অপরিবর্তিত: **যেকোনো একটি কোর্সে এনরোল্ড থাকলেই** সব কোর্সের প্রশ্নব্যাংক
 * ও প্র্যাকটিস অ্যাক্সেসযোগ্য — কোর্স-স্কোপ ফিল্টার নেই।
 */

// টপিক-তালিকার ছোট মেমো-ক্যাশ (প্রতি সার্ভার instance-এ; ৯০ সেকেন্ড)
const PRACTICE_TOPICS_TTL_MS = 90 * 1000;
const practiceTopicsCache = new Map<string, { at: number; data: TopicOption[] }>();

// প্র্যাকটিস-পুলের ছোট মেমো-ক্যাশ: একই টপিকে ("আবার শুরু" বা পুনরায় ঢুকলে)
// ডাটাবেস আবার স্ক্যান না করে সাথে সাথে প্রশ্ন দেয়। কী-তে **resolved** স্টুডেন্ট
// পরিচয় থাকে (ক্লায়েন্টের দেওয়া নয়), তাই একজনের ক্যাশ কখনো অন্যের কাছে যায় না —
// আর এনরোলমেন্ট যাচাই ক্যাশের **আগেই** হয়।
const PRACTICE_POOL_TTL_MS = 60 * 1000;
const PRACTICE_POOL_CACHE_MAX = 300;
const practicePoolCache = new Map<string, { at: number; data: PracticeQuestion[] }>();

/** পুল থেকে চূড়ান্ত তালিকা: সীমিত মোডে শাফল করে কেটে দিই, "সব প্রশ্ন" মোডে পুরোটা। */
function finalizePool(list: PracticeQuestion[], unlimited: boolean, requestedCount: number): PracticeQuestion[] {
  const copy = list.slice();
  if (unlimited) return copy;
  // Fisher-Yates shuffle (আগের মতোই) — কুইজ/সীমিত মোডে এলোমেলো
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, requestedCount);
}

export async function getPracticeTopics(studentId?: string, email?: string): Promise<TopicOption[]> {
  try {
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const norm = (s: string) => String(s || "").trim().toLowerCase();

    // PERF: টপিক-তালিকা/কাউন্ট প্রতি ভিজিটে পুরো topic_questions + links স্ক্যান
    // করত। ছোট TTL cache (instance-স্তর) রাখলে পরপর খোলায় সাথে সাথে আসে।

    // SECURITY: ক্লায়েন্টের পাঠানো id/email কোনো পরিচয় নয়। যাচাইকৃত সেশন আগে;
    // সেশন না থাকলে م্যানুয়াল fallback-এ id **ও** email দুটোই একই রোস্টার-সারিতে
    // মিলতে হবে (lib/student-session.ts)।
    const isTeacher = await isTeacherSession();
    const identity = isTeacher ? null : await resolveStudyIdentity(studentId, email);

    if (!isTeacher) {
      if (!identity) return [];
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const access = await verifyStudentAccess(identity.id, "ALL", identity.email);
      if (!access.allowed) return [];
    }

    // PERF: ক্যাশ-কী resolved পরিচয় দিয়ে — ক্লায়েন্টের ইনপুট দিয়ে নয়, যাতে একজন
    // দর্শক অন্য কারও এন্ট্রি তৈরি বা পড়তে না পারে।
    const cacheKey = isTeacher ? "teacher" : `${identity!.id}|${norm(identity!.email || "")}`;
    const cached = practiceTopicsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PRACTICE_TOPICS_TTL_MS) {
      return cached.data;
    }

    // PERF: তিনটি স্বাধীন কোয়েরি একসাথে (আগে সিরিয়াল ছিল)।
    // ⚠️ `.limit(5000)` কাজ করে না — PostgREST সার্ভার-সাইডে **১০০০ সারিতে** কেটে
    // দেয়, আর বাকিগুলো নীরবে বাদ পড়ে। টেবিল বড় হওয়ার পর টপিক-তালিকা ও প্রশ্ন-
    // সংখ্যা কম দেখাত। তাই এখন পৃষ্ঠা-পৃষ্ঠা (`fetchAllRows`)।
    // প্রথমে count বের করি প্যারালাল ফেচের জন্য
    const [{ count: tqCount }, { count: linkCount }] = await Promise.all([
      supabase.from("topic_questions").select("*", { count: "exact", head: true }),
      supabase.from("exam_questions_link").select("*", { count: "exact", head: true })
    ]);

    const { fetchAllRowsParallel } = await import("@/lib/fetch-all");

    const [settingsRes, topicQuestionsRows, linksRows] = await Promise.all([
      supabase.from("app_settings").select("topics").eq("id", "main").maybeSingle(),
      fetchAllRowsParallel<any>(tqCount || 0, (from, to) =>
        supabase
          .from("topic_questions")
          .select("topic, q, exam_key")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRowsParallel<any>(linkCount || 0, (from, to) =>
        supabase
          .from("exam_questions_link")
          .select("exam_id, question_bank(id, topic, q)")
          .order("exam_id", { ascending: true })
          .order("question_id", { ascending: true })
          .range(from, to)
      )
    ]);
    // নিচের ব্যবহারগুলো (`topicQuestionsRes.data`, `linksRes.data`) অপরিবর্তিত রাখতে
    // পুরোনো আকারেই মুড়ে দিই।
    const topicQuestionsRes = { data: topicQuestionsRows };
    const linksRes = { data: linksRows };

    // SECURITY: প্রশ্ন-পর্যায়ের উত্তর-লক (lib/answer-lock.ts)। আগের exam-key-ভিত্তিক
    // লকের চেয়ে শক্তিশালী — যে প্রশ্ন লাইভ পরীক্ষায় ব্যবহৃত হচ্ছে, সেটি অন্য কোনো
    // রিলিজ-হয়ে-যাওয়া পরীক্ষাতেও থাকলেও এখন আর দেখানো হয় না।
    const lock = isTeacher ? null : await loadAnswerLockState();

    // শিক্ষক → সব। স্টুডেন্ট → সব (কোর্স-নির্বিশেষে) কিন্তু লাইভ-লকড প্রশ্ন বাদ।
    // যে exam আর নেই (ডিলিট করা) তার মিরর করা প্রশ্নগুলো আর্কাইভ — সেগুলো লক হয় না,
    // নাহলে সেই টপিকগুলো শিক্ষার্থীর কাছে চিরতরে হারিয়ে যায়।
    const canSee = (text: string | null | undefined, examKey: string | null | undefined): boolean => {
      if (!lock) return true;
      return !isQuestionLocked(lock, { examKey, text });
    };

    const topicCountMap = new Map<string, number>();

    // 1. Registered topic list in app_settings (উপরের Promise.all-এ একসাথে আনা)
    const registered: string[] = settingsRes.data?.topics || [];
    registered.forEach((t) => {
      const trimmed = String(t || "").trim();
      if (trimmed && !topicCountMap.has(trimmed)) topicCountMap.set(trimmed, 0);
    });

    // 2. Count from permanent topicQuestions repository (visible rows only)
    //    PERF: unbounded select নয় — বড় DB-তে স্ক্যান সীমিত (৫০০০); উপরে
    //    একসাথে আনা হয়েছে (আর আলাদা রাউন্ড-ট্রিপ নেই)
    const topicQuestions = topicQuestionsRes.data;
    const mirroredKeys = new Set<string>();
    (topicQuestions || []).forEach((tq: any) => {
      const t = String(tq.topic || "").trim();
      mirroredKeys.add(`${norm(tq.q)}___${norm(t)}`);
      if (t && !topicCountMap.has(t)) topicCountMap.set(t, 0);
      if (t && canSee(tq.q, tq.exam_key)) topicCountMap.set(t, (topicCountMap.get(t) || 0) + 1);
    });

    // 3. Count exam-linked questions (excluding already-mirrored), visible only
    //    PERF: unbounded select নয় — সীমিত (৫০০০); উপরে একসাথে আনা হয়েছে
    const links = linksRes.data;

    (links || []).forEach((link: any) => {
      const rawQ = link.question_bank;
      const qb = Array.isArray(rawQ) ? rawQ[0] : rawQ;
      const q = qb?.q;
      const t = String(qb?.topic || "").trim();
      if (t && q) {
        if (!topicCountMap.has(t)) topicCountMap.set(t, 0);
        if (canSee(q, link.exam_id)) {
          const key = `${norm(q)}___${norm(t)}`;
          if (!mirroredKeys.has(key)) topicCountMap.set(t, (topicCountMap.get(t) || 0) + 1);
        }
      }
    });

    const result: TopicOption[] = [];
    topicCountMap.forEach((count, name) => {
      // নিবন্ধিত সব টপিকই দেখানো হয় (০-কাউন্টও) — যাতে কেউ কোনো টপিক "হারিয়ে" না ফেলে
      result.push({ name, count });
    });
    const sorted = result.sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name, "bn")
    );
    // PERF: পরের ভিজিটে সাথে সাথে দিতে ছোট cache-এ রাখি
    practiceTopicsCache.set(cacheKey, { at: Date.now(), data: sorted });
    return sorted;
  } catch (err) {
    console.error("Get practice topics error:", err);
    return [];
  }
}

export async function getPracticeQuestions(
  selectedTopic: string,
  count: number,
  studentId?: string,
  email?: string
): Promise<PracticeQuestion[]> {
  try {
    // SECURITY: self-practice requires an enrolled student (ANY course) —
    // UNLESS the caller is a verified teacher (admins may browse the whole
    // bank, including not-yet-released exams — they are the content owners).
    //
    // পরিচয় কখনো ক্লায়েন্ট থেকে নেওয়া হয় না: verified session আগে, আর সেশন
    // না থাকলে id+email দুটোই একই রোস্টার-সারিতে মিলতে হবে। আগে যে কেউ একজন
    // এনরোল্ড ছাত্রের ফোন নম্বর জানলেই লগইন ছাড়া পুরো পেইড ব্যাংক (উত্তর ও
    // ব্যাখ্যা সহ, count=0 মানে "সব") বের করে নিতে পারত।
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const isTeacher = await isTeacherSession();
    const identity = isTeacher ? null : await resolveStudyIdentity(studentId, email);

    let ownerId = "";
    if (!isTeacher) {
      if (!identity) return [];
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const accessRes = await verifyStudentAccess(identity.id, "ALL", identity.email);
      if (!accessRes.allowed) return [];
      // রোস্টারের canonical আইডি — submission/notebook এটাই ব্যবহার করে।
      ownerId = accessRes.normalizedId || identity.id;
    }

    // count = 0 → "সব প্রশ্ন" (unlimited)। প্রশ্নব্যাংক রিডিং-এ সব প্রশ্ন দেখানোর
    // জন্য page.tsx ০ পাঠায়; বাকি কলাররা (কুইজ ১০/১৫/৫০) আগের মতোই সীমিত থাকে।
    const rawCount = Number(count);
    const unlimited = Number.isFinite(rawCount) && rawCount === 0;
    const requestedCount = unlimited ? 0 : Math.max(1, Math.min(50, rawCount || 10));

    const pool: PracticeQuestion[] = [];
    const normalizedTopic = selectedTopic.trim().toLowerCase();
    const isAll =
      !selectedTopic ||
      selectedTopic === "all" ||
      selectedTopic === "সকল বিষয় (মিক্সড)" ||
      selectedTopic === "সকল টপিক (মিক্সড)";

    // PERF: একই টপিক+সংখ্যায় আবার শুরু করলে ডাটাবেস না ছুঁয়ে সাথে সাথে দিই
    // (এনরোলমেন্ট যাচাই উপরে হয়েই গেছে — ক্যাশে শুধু অনুমোদিতদের পুল থাকে)।
    // SECURITY: কী-তে resolved পরিচয়, ক্লায়েন্টের পাঠানো আইডি নয়।
    const poolCacheKey = `${isTeacher ? "t" : "s"}|${ownerId}|${String(identity?.email || "").trim().toLowerCase()}|${selectedTopic.trim()}|${unlimited ? "all" : requestedCount}`;
    const cachedPool = practicePoolCache.get(poolCacheKey);
    if (cachedPool && Date.now() - cachedPool.at < PRACTICE_POOL_TTL_MS) {
      return finalizePool(cachedPool.data, unlimited, requestedCount);
    }

    // Segment-boundary topic matching (not raw substring): selecting "বাংলা"
    // matches "বাংলা" and "বাংলা > প্রাচীন যুগ" (descendants) but NOT
    // "বাংলাদেশ বিষয়াবলী". Consistent with fetchTopicQuestionsForStudent.
    const { getTopicSegments } = await import("@/lib/topic-hierarchy");
    const isTopicMatch = (rawTopic?: string | null): boolean => {
      if (!rawTopic || !String(rawTopic).trim()) return false;
      const segs = getTopicSegments(String(rawTopic));
      const full = segs.join(" > ").toLowerCase();
      return (
        full === normalizedTopic ||
        full.startsWith(normalizedTopic + " > ") ||
        segs.some((s: string) => s.toLowerCase() === normalizedTopic)
      );
    };

    // 1. Persistent Topic Questions repository (skip questions mirrored from
    //    answer-locked exams or from exams of courses the student is not in).
    //    PERF: নির্দিষ্ট টপিক বাছলে সার্ভার-সাইডেই coarse filter (ilike) — পুরো
    //    টেবিল নামিয়ে JS-এ ফিল্টার করা বন্ধ। পরে isTopicMatch দিয়ে নির্ভুল করা হয়।
    const topicLikePattern = isAll ? "" : `%${selectedTopic.trim()}%`;
    // ⚠️ `.limit(2000)`/`.limit(3000)` নয় — PostgREST ১০০০-এ কাটে, তাই বড় টপিকে
    // প্র্যাকটিস-পুল থেকে প্রশ্ন নীরবে হারিয়ে যেত ("টেবিল ছোট (৫০০ লিংক)" ধারণাটা
    // আর সত্য নয়)। এখন পৃষ্ঠা-পৃষ্ঠা করে আনি।
    const buildTopicQuestionsPage = (from: number, to: number) => {
      let pageQuery = supabase
        .from("topic_questions")
        .select("id, topic, q, opts, correct, exp, original_subject, exam_key")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (topicLikePattern) pageQuery = pageQuery.ilike("topic", topicLikePattern);
      return pageQuery;
    };

    let examsRes: any, topicQuestionRows: any[] = [], linkRows: any[] = [];

    // PERF: "সকল টপিক (মিক্সড)" হলে পুরো ডাটাবেস ডাউনলোড না করে শুধু কয়েকটি র‍্যান্ডম পেজ আনি
    if (isAll && !unlimited) {
      // শুধু ১০০০টি র‍্যান্ডম প্রশ্ন নিয়ে কাজ করি
      const [{ count: tqCount }, { count: linkCount }] = await Promise.all([
        supabase.from("topic_questions").select("*", { count: "exact", head: true }),
        supabase.from("exam_questions_link").select("*", { count: "exact", head: true })
      ]);
      const maxTq = Math.max(0, (tqCount || 0) - 1000);
      const randomTqFrom = Math.floor(Math.random() * (maxTq > 0 ? maxTq : 1));
      
      const maxLink = Math.max(0, (linkCount || 0) - 500);
      const randomLinkFrom = Math.floor(Math.random() * (maxLink > 0 ? maxLink : 1));

      const [eRes, tqRes, lRes] = await Promise.all([
        supabase.from("exams").select("id, subject"),
        buildTopicQuestionsPage(randomTqFrom, randomTqFrom + 999),
        supabase
          .from("exam_questions_link")
          .select("exam_id, order_index, question_bank!inner(id, q, opts, topic, correct, exp)")
          .order("exam_id", { ascending: true })
          .order("question_id", { ascending: true })
          .range(randomLinkFrom, randomLinkFrom + 499)
      ]);
      examsRes = eRes;
      topicQuestionRows = tqRes.data || [];
      linkRows = lRes.data || [];
    } else {
      // নির্দিষ্ট টপিক বা কোশ্চেন ব্যাংকের জন্য পুরোটা (ilike দিয়ে ফিল্টার করা)
      const [eRes, tqRes, lRes] = await Promise.all([
        supabase.from("exams").select("id, subject"),
        fetchAllRows<any>(buildTopicQuestionsPage),
        fetchAllRows<any>((from, to) => {
          let q = supabase
            .from("exam_questions_link")
            .select("exam_id, order_index, question_bank!inner(id, q, opts, topic, correct, exp)")
            .order("exam_id", { ascending: true })
            .order("question_id", { ascending: true })
            .range(from, to);
          if (topicLikePattern) {
            q = q.ilike("question_bank.topic", topicLikePattern);
          }
          return q;
        })
      ]);
      examsRes = eRes;
      topicQuestionRows = tqRes;
      linkRows = lRes;
    }

    // নিচের ব্যবহারগুলো অপরিবর্তিত রাখতে পুরোনো আকারে মুড়ে দিই
    const tqRes = { data: topicQuestionRows };
    const linksRes = { data: linkRows };

    const allExams = examsRes.data;

    // SECURITY: প্রশ্ন-পর্যায়ের উত্তর-লক (lib/answer-lock.ts)। লকড পরীক্ষাগুলোর
    // প্রতিটি প্রশ্নের id ও নরমালাইজড টেক্সট সংগ্রহ করা হয় — তাই যে প্রশ্ন
    // ব্যাংক থেকে লিংক করে নতুন লাইভ পরীক্ষায় দেওয়া হয়েছে, সেটি আগের রিলিজ-হয়ে-
    // যাওয়া পরীক্ষার সূত্রেও আর বেরোবে না। (failClosed হলে অজানা exam-linked
    // প্রশ্নও বাদ পড়ে — উত্তর ফাঁসের চেয়ে কনটেন্ট আটকে থাকা ভালো।)
    const lock = isTeacher ? null : await loadAnswerLockState();

    // 1. Persistent Topic Questions repository — উপরের Promise.all-এ আনা হয়েছে
    const topicQuestions = tqRes.data;

    (topicQuestions || []).forEach((tq: any, idx: number) => {
      const matchTopic = isAll || isTopicMatch(tq.topic);
      // মিরর রো-এর নিজের id `question_bank`-এর id নয়, তাই শুধু exam_key ও টেক্সট দিয়ে মেলাই।
      if (lock && isQuestionLocked(lock, { examKey: tq.exam_key, text: tq.q })) return;
      if (matchTopic && tq.q && tq.opts && tq.opts.length >= 2) {
        pool.push({
          id: tq.id || `tq_${idx}`,
          q: tq.q,
          opts: tq.opts,
          correct: Number(tq.correct ?? 0),
          exp: tq.exp || "",
          subject: tq.original_subject || tq.topic || "টপিক ভিত্তিক",
          topic: tq.topic
        });
      }
    });

    // 2. Exam questions with the matching topic — only from accessible exams
    //    whose answers are released (always-open practice exams are fine).
    //    PERF: উপরের Promise.all-এ একসাথে আনা। মাপা গেছে — nested ilike ফিল্টার
    //    (~462ms) সাধারণ join-এর (~236ms) চেয়ে ধীর, আর টেবিল ছোট (৫০০ লিংক) —
    //    তাই সাধারণ join-ই দ্রুত; JS-এ isTopicMatch দিয়ে নির্ভুল করা হয়।
    const links = linksRes.data;

    const byExam: Record<string, any[]> = {};
    (links || []).forEach((link: any) => {
      if (!byExam[link.exam_id]) byExam[link.exam_id] = [];
      byExam[link.exam_id].push(link);
    });

    for (const ex of allExams || []) {
      const examQuestions = (byExam[ex.id] || [])
        .sort((a: any, b: any) => Number(a.order_index) - Number(b.order_index))
        .map((l: any) => Array.isArray(l.question_bank) ? l.question_bank[0] : l.question_bank)
        .filter(Boolean);

      if (examQuestions.length === 0) continue;

      const matchingIndices: number[] = [];
      examQuestions.forEach((qItem: any, qIdx: number) => {
        const matchTopic = isAll ? String(qItem.topic || "").trim().length > 0 : isTopicMatch(qItem.topic);
        if (matchTopic) matchingIndices.push(qIdx);
      });

      matchingIndices.forEach((qIdx) => {
        const qItem = examQuestions[qIdx];
        // SECURITY: প্রশ্ন-পর্যায়ের লক — এই exam রিলিজ হলেও প্রশ্নটি অন্য কোনো
        // লাইভ পরীক্ষায় থাকলে বাদ।
        if (lock && isQuestionLocked(lock, { questionId: qItem.id, examKey: ex.id, text: qItem.q })) return;
        pool.push({
          id: `ex_${ex.id}_${qIdx}`,
          q: qItem.q,
          opts: qItem.opts,
          correct: Number(qItem.correct ?? 0),
          exp: qItem.exp || "",
          subject: ex.subject || qItem.topic || "টপিক ভিত্তিক",
          topic: qItem.topic
        });
      });
    }

    // Deduplicate by question text (same as before)
    const uniqueMap = new Map<string, PracticeQuestion>();
    pool.forEach((item) => {
      const key = item.q.trim().toLowerCase();
      if (!uniqueMap.has(key)) uniqueMap.set(key, item);
    });

    const uniqueList = Array.from(uniqueMap.values());

    // PERF: পরের বার (একই টপিক+সংখ্যা) ডাটাবেস ছোঁয়া ছাড়াই দেওয়ার জন্য
    // পুলটা ছোট TTL ক্যাশে রাখি — শাফল প্রতিবার নতুন করে হয়।
    if (practicePoolCache.size >= PRACTICE_POOL_CACHE_MAX) {
      const oldest = practicePoolCache.keys().next().value;
      if (oldest) practicePoolCache.delete(oldest);
    }
    practicePoolCache.set(poolCacheKey, { at: Date.now(), data: uniqueList });

    // "সব প্রশ্ন" মোডে (count=0) ডাটাবেস অর্ডারে সম্পূর্ণ তালিকা — পড়ার জন্য;
    // সীমিত মোডে শাফল করে কেটে দেওয়া (আগের আচরণ অপরিবর্তিত)।
    return finalizePool(uniqueList, unlimited, requestedCount);
  } catch (err) {
    console.error("Get practice questions error:", err);
    return [];
  }
}

/**
 * প্রশ্নব্যাংকের জন্য পেজ-ভিত্তিক প্রশ্ন আনা।
 * এতে শুধুমাত্র একটি পেজের প্রশ্ন নেটওয়ার্কে পাঠানো হয়, এবং মোট সংখ্যাটি metadata হিসেবে দেওয়া হয়।
 */
export async function getQuestionBankTopicQuestions(
  selectedTopic: string,
  page: number,
  limit: number,
  studentId?: string,
  email?: string
): Promise<{ questions: PracticeQuestion[]; metadata: { total: number } }> {
  try {
    // আগের মতোই সব প্রশ্ন জেনারেট/ক্যাশ করা হয়
    const allQuestions = await getPracticeQuestions(selectedTopic, 0, studentId, email);
    
    // পেজ অনুযায়ী কাটা (pagination)
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedQuestions = allQuestions.slice(startIndex, endIndex);

    return {
      questions: paginatedQuestions,
      metadata: {
        total: allQuestions.length
      }
    };
  } catch (err) {
    console.error("Get paginated questions error:", err);
    return { questions: [], metadata: { total: 0 } };
  }
}

