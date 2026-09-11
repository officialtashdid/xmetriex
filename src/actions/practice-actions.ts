"use server";

import { supabase } from "@/lib/supabase";
import type { PracticeQuestion, TopicOption } from "@/lib/practice-helper";
import type { Exam } from "@/types/exam";

/**
 * Server-side Self-Practice data.
 *
 * Previously the home page shipped the ENTIRE topic_questions table + every
 * exam's questions to the client just to build the practice pool. Now the
 * questions are fetched from the database only when a practice session
 * actually starts — the home page stays light.
 */

// টপিক-তালিকার ছোট মেমো-ক্যাশ (প্রতি সার্ভার instance-এ; ৯০ সেকেন্ড)
const PRACTICE_TOPICS_TTL_MS = 90 * 1000;
const practiceTopicsCache = new Map<string, { at: number; data: TopicOption[] }>();

export async function getPracticeTopics(studentId?: string, email?: string): Promise<TopicOption[]> {
  // PERF: টপিক-তালিকা/কাউন্ট প্রতি ভিজিটে পুরো topic_questions + links স্ক্যান
  // করত। ছোট TTL cache (instance-স্তর) রাখলে পরপর খোলায় সাথে সাথে আসে।
  const cacheKey = `${String(studentId || "").trim()}|${String(email || "").trim().toLowerCase()}`;
  const cached = practiceTopicsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PRACTICE_TOPICS_TTL_MS) {
    return cached.data;
  }

  try {
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const isTeacher = await isTeacherSession();
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    const cleanId = String(studentId || "").trim();

    // স্টুডেন্ট হলে: কোন কোন পরীক্ষা দেখতে পারে (কোর্স) আর কোনগুলো লক করা —
    // কাউন্ট যেন fetch-এর সাথে মিলে যায় (অন্যথায় "১০টা দেখায়, খুললে খালি")।
    let accessibleExamIds: Set<string> | null = null;
    let lockedExamIds = new Set<string>();

    if (!isTeacher && cleanId) {
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const access = await verifyStudentAccess(cleanId, "ALL", email);
      if (!access.allowed) return [];

      // নিয়ম: যেকোনো একটি কোর্সে এনরোল্ড থাকলেই সব কোর্সের প্রশ্নব্যাংক/
      // প্র্যাকটিস অ্যাক্সেসযোগ্য — কোর্স-স্কোপ ফিল্টার আর নেই। শুধু যেসব
      // নির্ধারিত (লাইভ) পরীক্ষার উত্তর এখনো প্রকাশিত নয় সেগুলো লক থাকে
      // (কাউন্ট fetch-এর সাথে মিলে যায় — "১০টা দেখায়, খুললে খালি" নয়)।
      const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
      const { data: allExams } = await supabase
        .from("exams")
        .select("id, course, start_time, end_time, leaderboard_end_time, is_result_published");
      accessibleExamIds = new Set<string>();
      (allExams || []).forEach((ex: any) => {
        const examObj = {
          startTime: ex.start_time,
          endTime: ex.end_time,
          leaderboardEndTime: ex.leaderboard_end_time,
          isResultPublished: ex.is_result_published === true
        } as Exam;
        const isScheduled = !!(ex.start_time && (ex.end_time || ex.leaderboard_end_time));
        if (isScheduled && !isAnswerTimeReached(examObj)) lockedExamIds.add(ex.id);
        accessibleExamIds!.add(ex.id);
      });
    }

    // শিক্ষক / exam_key-বিহীন (স্থায়ী মিরর) → সব; স্টুডেন্ট → সব (কোর্স-নির্বিশেষে) কিন্তু লক-বিহীন।
    // মনে রাখো: যে exam আর নেই (ডিলিট করা) তার মিরর করা প্রশ্নগুলো আর্কাইভ — সেগুলো
    // কখনো লক করা যায় না, নাহলে সেই টপিকগুলো শিক্ষার্থীর কাছে চিরতরে হারিয়ে যায়।
    const canSee = (examKey: string | null | undefined): boolean => {
      if (isTeacher || !examKey) return true;
      if (!accessibleExamIds || !accessibleExamIds.has(examKey)) return true; // অজানা/ডিলিট exam
      return !lockedExamIds.has(examKey);
    };

    const topicCountMap = new Map<string, number>();

    // 1. Registered topic list in app_settings
    const { data: settings } = await supabase
      .from("app_settings")
      .select("topics")
      .eq("id", "main")
      .maybeSingle();
    const registered: string[] = settings?.topics || [];
    registered.forEach((t) => {
      const trimmed = String(t || "").trim();
      if (trimmed && !topicCountMap.has(trimmed)) topicCountMap.set(trimmed, 0);
    });

    // 2. Count from permanent topicQuestions repository (visible rows only)
    //    PERF: unbounded select নয় — বড় DB-তে স্ক্যান সীমিত (৫০০০)
    const { data: topicQuestions } = await supabase
      .from("topic_questions")
      .select("topic, q, exam_key")
      .limit(5000);
    const mirroredKeys = new Set<string>();
    (topicQuestions || []).forEach((tq: any) => {
      const t = String(tq.topic || "").trim();
      mirroredKeys.add(`${norm(tq.q)}___${norm(t)}`);
      if (t && !topicCountMap.has(t)) topicCountMap.set(t, 0);
      if (t && canSee(tq.exam_key)) topicCountMap.set(t, (topicCountMap.get(t) || 0) + 1);
    });

    // 3. Count exam-linked questions (excluding already-mirrored), visible only
    //    PERF: unbounded select নয় — সীমিত (৫০০০)
    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("exam_id, question_bank(topic, q)")
      .limit(5000);

    (links || []).forEach((link: any) => {
      const q = link.question_bank?.q;
      const t = String(link.question_bank?.topic || "").trim();
      if (t && q) {
        if (!topicCountMap.has(t)) topicCountMap.set(t, 0);
        if (canSee(link.exam_id)) {
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
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const isTeacher = await isTeacherSession();

    const cleanId = String(studentId || "").trim();
    let access: { allowed: boolean; courses?: string[] } | null = null;
    if (isTeacher) {
      access = { allowed: true, courses: ["all"] };
    } else {
      if (!cleanId) return [];
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      access = await verifyStudentAccess(cleanId, "ALL", email);
      if (!access.allowed) return [];
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

    // Build exam access/lock info: any enrolled student (ANY course) may
    // practice every course's questions; only answer-locked scheduled exams
    // (results not yet published) are excluded.
    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    // PERF: exams একবারই আনি (subject/title সহ) — আগে দুবার আলাদা কোয়েরি হতো
    const { data: allExams } = await supabase
      .from("exams")
      .select("id, course, subject, title, start_time, end_time, leaderboard_end_time, is_result_published");

    const lockedExamIds = new Set<string>();
    const accessibleExamIds = new Set<string>();
    (allExams || []).forEach((ex: any) => {
      const examObj = {
        id: ex.id,
        startTime: ex.start_time,
        endTime: ex.end_time,
        leaderboardEndTime: ex.leaderboard_end_time,
        isResultPublished: ex.is_result_published === true
      } as Exam;
      const isScheduled = !!(ex.start_time && (ex.end_time || ex.leaderboard_end_time));
      if (!isTeacher && isScheduled && !isAnswerTimeReached(examObj)) lockedExamIds.add(ex.id);
      // এনরোল্ড (যেকোনো একটি কোর্স) হলে সব কোর্সের প্রশ্নই অ্যাক্সেসযোগ্য
      accessibleExamIds.add(ex.id);
    });

    // 1. Persistent Topic Questions repository (skip questions mirrored from
    //    answer-locked exams or from exams of courses the student is not in).
    //    PERF: নির্দিষ্ট টপিক বাছলে সার্ভার-সাইডেই coarse filter (ilike) — পুরো
    //    টেবিল নামিয়ে JS-এ ফিল্টার করা বন্ধ। পরে isTopicMatch দিয়ে নির্ভুল করা হয়।
    const topicLikePattern = isAll ? "" : `%${selectedTopic.trim()}%`;
    let tqQuery = supabase
      .from("topic_questions")
      .select("id, topic, q, opts, correct, exp, original_subject, original_course, original_exam_title, exam_key")
      .limit(2000);
    if (topicLikePattern) {
      tqQuery = tqQuery.ilike("topic", topicLikePattern);
    }
    const { data: topicQuestions } = await tqQuery;

    (topicQuestions || []).forEach((tq: any, idx: number) => {
      const matchTopic = isAll || isTopicMatch(tq.topic);
      if (tq.exam_key) {
        // লক কেবল তখনই যখন exam এখনও আছে ও উত্তর রিলিজ হয়নি। যে exam ডিলিট হয়েছে
        // তার প্রশ্ন আর্কাইভ — চিরতরে ব্লক করা যাবে না।
        if (lockedExamIds.has(tq.exam_key)) return;
      }
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
    //    PERF: exams আগেই আনা হয়েছে (allExams)। মাপা গেছে — nested ilike ফিল্টার
    //    (~462ms) সাধারণ join-এর (~236ms) চেয়ে ধীর, আর টেবিল ছোট (৫০০ লিংক) —
    //    তাই সাধারণ join-ই দ্রুত; JS-এ isTopicMatch দিয়ে নির্ভুল করা হয়।
    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("exam_id, order_index, question_bank!inner(id, q, opts, topic, correct, exp)")
      .limit(3000);

    const byExam: Record<string, any[]> = {};
    (links || []).forEach((link: any) => {
      if (!byExam[link.exam_id]) byExam[link.exam_id] = [];
      byExam[link.exam_id].push(link);
    });

    for (const ex of allExams || []) {
      if (lockedExamIds.has(ex.id)) continue;
      if (!accessibleExamIds.has(ex.id)) continue;

      const examQuestions = (byExam[ex.id] || [])
        .sort((a: any, b: any) => Number(a.order_index) - Number(b.order_index))
        .map((l: any) => l.question_bank)
        .filter(Boolean);

      if (examQuestions.length === 0) continue;

      const matchingIndices: number[] = [];
      examQuestions.forEach((qItem: any, qIdx: number) => {
        const matchTopic = isAll ? String(qItem.topic || "").trim().length > 0 : isTopicMatch(qItem.topic);
        if (matchTopic) matchingIndices.push(qIdx);
      });

      matchingIndices.forEach((qIdx) => {
        const qItem = examQuestions[qIdx];
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

    if (!unlimited) {
      // Fisher-Yates shuffle (same as before) — কুইজ/সীমিত মোডে এলোমেলো
      for (let i = uniqueList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [uniqueList[i], uniqueList[j]] = [uniqueList[j], uniqueList[i]];
      }
      return uniqueList.slice(0, requestedCount);
    }

    // "সব প্রশ্ন" মোড (count=0): ডাটাবেস অর্ডারে সম্পূর্ণ তালিকা — পড়ার জন্য
    return uniqueList;
  } catch (err) {
    console.error("Get practice questions error:", err);
    return [];
  }
}
