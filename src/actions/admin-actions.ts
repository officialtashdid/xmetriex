"use server";

import { revalidatePath } from "next/cache";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetch-all";
import { requireTeacher, getTeacherUser } from "@/lib/teacher-auth";
import { AppConfigData, Exam, QuestionItem, QuestionSolution, TopicQuestion, ArchivedQuestion } from "@/types/exam";
import { getExamSolutions } from "@/actions/exam-actions";
import { Submission } from "@/types/submission";

let cachedConfig: AppConfigData | null = null;
let lastFetchTime = 0;
let inflightFetch: Promise<AppConfigData> | null = null;
const CACHE_TTL_MS = 60000; // 60 seconds cache (questions change only via admin edits, which invalidate the cache)

// ─── অ্যাডমিন প্যানেল: মেটাডেটা-প্রথম লোডিং ────────────────────────────────
// আগে প্যানেল খোলার সাথে সাথে পুরো প্রশ্ন-করপাস (topic_questions + প্রতিটি
// exam-এর প্রশ্ন) নামত, আর প্রতিটি সেভের পরেই আবার নামত। এখন শুধু মেটাডেটা +
// সার্ভারে গোনা সংখ্যা আসে; প্রকৃত প্রশ্ন আসে কেবল যে সেকশন খোলা হয় তার।
let cachedExamCounts: { at: number; data: Record<string, number> } | null = null;
let inflightExamCounts: Promise<Record<string, number>> | null = null;
const EXAM_COUNTS_TTL_MS = 60 * 1000;

// কোন পরীক্ষা কতজন দিয়েছে — সাবমিশন ঘন ঘন বদলায়, তাই কম TTL (৩০s)
let cachedSubmissionCounts: { at: number; data: Record<string, number> } | null = null;
let inflightSubmissionCounts: Promise<Record<string, number>> | null = null;
const SUBMISSION_COUNTS_TTL_MS = 30 * 1000;

let cachedTopicPaths: { at: number; data: string[] } | null = null;
const TOPIC_PATHS_TTL_MS = 90 * 1000;

/**
 * Supabase/PostgREST এরর → পড়ার মতো এক লাইন।
 *
 * কেন দরকার: এই ফাইলের প্রায় প্রতিটি write-action `catch`-এ শুধু
 * `console.error` করে `false` ফেরে, তাই UI-তে সবসময় একই "সমস্যা হয়েছে"
 * দেখায় — ডুপ্লিকেট-কী, NOT NULL, FK-ভঙ্গ বা অনুমতি-ত্রুটি আলাদা করা যায় না,
 * আর কারণটা কেবল সার্ভার-টার্মিনালে থাকে। এরর-বস্তু থেকে কোড/বার্তা তুলে
 * UI-তে পাঠালে ব্যবহারকারীই সাথে সাথে কারণ জানতে পারেন।
 */
function describeError(err: unknown): string {
  if (!err) return "অজানা সমস্যা";
  if (typeof err === "string") return err;
  const e = err as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const parts = [
    e.code ? `[${String(e.code)}]` : "",
    e.message ? String(e.message) : "",
    e.details ? String(e.details) : "",
    e.hint ? String(e.hint) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : String(err);
}

const DEFAULT_DATA: AppConfigData = {
  courses: ["সাধারণ কোর্স", "বিসিএস প্রিলি"],
  subjects: [
    { name: "বাংলা", course: "সাধারণ কোর্স" },
    { name: "ইংরেজি", course: "সাধারণ কোর্স" },
    { name: "গণিত", course: "সাধারণ কোর্স" },
    { name: "সাধারণ জ্ঞান", course: "সাধারণ কোর্স" }
  ],
  topics: [
    "প্রাচীন ও মধ্যযুগ",
    "আধুনিক যুগ",
    "বাংলা ব্যাকরণ",
    "English Grammar",
    "English Literature",
    "পাটিগণিত",
    "বীজগণিত",
    "জ্যামিতি",
    "বাংলাদেশ বিষয়াবলী",
    "আন্তর্জাতিক বিষয়াবলী",
    "সাধারণ বিজ্ঞান",
    "কম্পিউটার ও তথ্যপ্রযুক্তি",
    "ভূগোল ও পরিবেশ",
    "নৈতিকতা ও সুশাসন"
  ],
  topicQuestions: [],
  exams: {},
  teacherPass: "",
  driveRoutineUrl: "https://drive.google.com",
  driveSyllabusUrl: "https://drive.google.com",
  pinnedCourses: []
};

function invalidateConfigCache() {
  cachedConfig = null;
  lastFetchTime = 0;
  cachedConfigLite = null;
  lastFetchTimeLite = 0;
  cachedConfigMeta = null;
  lastFetchTimeMeta = 0;
  // প্রশ্নসংখ্যা ও টপিক-তালিকার মেমো-ক্যাশও একসাথে বাতিল — নাহলে প্রশ্ন যোগ/মুছলে
  // প্যানেল পুরনো সংখ্যা দেখাত।
  cachedExamCounts = null;
  inflightExamCounts = null;
  cachedTopicPaths = null;
  cachedSubmissionCounts = null;
  inflightSubmissionCounts = null;
  // কনফিগ বদলানোর প্রতিটি জায়গা থেকেই পাবলিক পেজ (হোম/কোর্স) নতুন করে রেন্ডার
  // হয় — যাতে এডমিন এডিটের পর লাইভ/সময় পরিবর্তন দেপ্লয়ড সাইটেও সাথে সাথে ফুটে।
  revalidatePublicPages();
}

/**
 * Exam/কনফিগ পরিবর্তনের পর পাবলিক পেজ (হোম, কোর্স) যেন নতুন ডেটা দিয়ে সাথে
 * সাথে নতুন করে রেন্ডার হয় — শুধু ISR-এর `revalidate = 60`-এর উপর নির্ভর না
 * করে। দেপ্লয়ড (Vercel/Serverless) পরিবেশে module-লেভেল cache instance-ভেদে
 * খালি হয় না, তাই admin এডিটের পর হোম পেজে পুরনো সময়/লাইভ স্ট্যাটাস আটকে
 * থাকার সমস্যা এতে দূর হয়।
 */
function revalidatePublicPages() {
  try {
    revalidatePath("/");
    revalidatePath("/course/[courseName]", "page");
  } catch {
    // revalidatePath কেবল একটি request-এর ভেতর থেকে ডাকা যায়; বাইরে হলে নীরবে ছেড়ে দিন
  }
}

export async function fetchAppConfig(forceRefresh = false): Promise<AppConfigData> {
  // SECURITY: the full config includes topic_questions with correct/exp answer
  // keys — only verified teachers may fetch it.
  await requireTeacher();

  const now = Date.now();
  if (!forceRefresh && cachedConfig && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (inflightFetch) {
    return inflightFetch;
  }

  const timeoutPromise = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error("Firestore timeout")), 2500)
  );

  inflightFetch = (async () => {
    try {
      const fetchPromise = Promise.all([
        supabase.from("app_settings").select("*").eq("id", "main").maybeSingle(),
        supabase.from("subjects").select("name, course"),
        supabase.from("exams").select("*").order("start_time", { ascending: true }),
        // ⚠️ পৃষ্ঠা-পৃষ্ঠা করে আনি — PostgREST এক অনুরোধে **১০০০ সারির বেশি দেয় না**
        // (`max-rows`), আর সীমার বাইরের সারি নীরবে বাদ পড়ে; কোনো এরর আসে না।
        // এই দুই টেবিল ১০০০ ছাড়িয়ে যাওয়ার পর থেকে নতুন যোগ করা প্রশ্ন আর অ্যাডমিন
        // প্যানেলে দেখাই যেত না (মাপা গেছে: পরীক্ষার ১৭টি লিংকের মধ্যে ১টি দেখাত)।
        fetchAllRows<any>((from, to) =>
          supabase
            .from("exam_questions_link")
            .select("exam_id, order_index, question_bank(id, q, opts, topic)")
            .order("exam_id", { ascending: true })
            .order("order_index", { ascending: true })
            .order("question_id", { ascending: true })
            .range(from, to)
        ),
        fetchAllRows<any>((from, to) =>
          supabase
            .from("topic_questions")
            .select("*")
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
        )
      ]);

      const results = await Promise.race([
        fetchPromise,
        timeoutPromise.then(() => { throw new Error("Timeout"); })
      ]);

      if (results) {
        const [settingsRes, subjectsRes, examsRes, linksRows, topicQuestionsRows] = results;
        // নিচের ব্যবহারগুলো (`linksRes?.data`, `topicQuestionsRes?.data`) অপরিবর্তিত
        // রাখতে পুরোনো আকারেই মুড়ে দিই — কম ঝুঁকি, ছোট diff।
        const linksRes = { data: linksRows };
        const topicQuestionsRes = { data: topicQuestionsRows };

        const settings = settingsRes?.data || {};
        const courses = settings.courses || DEFAULT_DATA.courses;
        const topics = settings.topics || DEFAULT_DATA.topics;
        const teacherPass = ""; // never expose the teacher pass to clients
        const driveRoutineUrl = settings.drive_routine_url || DEFAULT_DATA.driveRoutineUrl;
        const driveSyllabusUrl = settings.drive_syllabus_url || DEFAULT_DATA.driveSyllabusUrl;

        const subjects = (subjectsRes?.data || []).map((s) => ({
          name: s.name,
          course: s.course
        }));

        const topicQuestions: TopicQuestion[] = (topicQuestionsRes?.data || []).map((tq) => ({
          id: tq.id,
          topic: tq.topic,
          q: tq.q,
          opts: tq.opts,
          correct: Number(tq.correct),
          exp: tq.exp || "",
          originalExamTitle: tq.original_exam_title,
          originalCourse: tq.original_course,
          originalSubject: tq.original_subject,
          examKey: tq.exam_key,
          createdAt: tq.created_at
        }));

        const questionsByExam: Record<string, { order: number; question: QuestionItem }[]> = {};
        (linksRes?.data || []).forEach((link: any) => {
          const examId = link.exam_id;
          const qData = link.question_bank;
          if (!qData) return;

          if (!questionsByExam[examId]) {
            questionsByExam[examId] = [];
          }
          questionsByExam[examId].push({
            order: Number(link.order_index ?? 0),
            question: {
              id: qData.id,
              q: qData.q,
              opts: qData.opts,
              topic: qData.topic || undefined
            }
          });
        });

        const exams: Record<string, Exam> = {};
        (examsRes?.data || []).forEach((ex) => {
          const sortedQs = (questionsByExam[ex.id] || [])
            .sort((a, b) => a.order - b.order)
            .map((item) => item.question);

          exams[ex.id] = {
            id: ex.id,
            course: ex.course,
            subject: ex.subject,
            title: ex.title,
            timerMinutes: ex.timer_minutes,
            isFree: ex.is_free,
            passMark: Number(ex.pass_mark),
            startTime: ex.start_time,
            endTime: ex.end_time,
            isResultPublished: ex.is_result_published,
            leaderboardStartTime: ex.leaderboard_start_time,
            leaderboardEndTime: ex.leaderboard_end_time,
            questions: sortedQs
          };
        });

        const pinnedCourses = settings.pinned_courses || DEFAULT_DATA.pinnedCourses;

        const data: AppConfigData = {
          courses,
          subjects,
          topics,
          topicQuestions,
          exams,
          teacherPass,
          driveRoutineUrl,
          driveSyllabusUrl,
          pinnedCourses
        };

        cachedConfig = data;
        lastFetchTime = Date.now();
        return data;
      }
    } catch (err) {
      console.warn("Fetch app config timed out or failed, using cache/default:", err);
    } finally {
      inflightFetch = null;
    }

    if (cachedConfig) {
      return cachedConfig;
    }

    cachedConfig = DEFAULT_DATA;
    lastFetchTime = Date.now();
    return DEFAULT_DATA;
  })();

  return inflightFetch;
}

// ─── Lite Config (fast initial load — no full question JOIN) ────────────────

let cachedConfigLite: AppConfigData | null = null;
let lastFetchTimeLite = 0;
let inflightFetchLite: Promise<AppConfigData> | null = null;

/**
 * Fast version of fetchAppConfig for initial admin panel load.
 * Skips the heavy exam_questions_link JOIN — only fetches exam_id for counts.
 * Also skips topic_questions.
 * The exam list renders instantly; full data loads in the background.
 */
export async function fetchAppConfigLite(): Promise<AppConfigData> {
  const now = Date.now();
  if (cachedConfigLite && now - lastFetchTimeLite < CACHE_TTL_MS) {
    return cachedConfigLite;
  }

  if (inflightFetchLite) {
    return inflightFetchLite;
  }

  inflightFetchLite = (async () => {
    try {
      // Lightweight queries — question TOPICS only (for the topic tree), no full question text
      const fetchPromiseLite = Promise.all([
        supabase.from("app_settings").select("*").eq("id", "main").maybeSingle(),
        supabase.from("subjects").select("name, course"),
        supabase.from("exams").select("*").order("start_time", { ascending: true }),
        // ⚠️ এখানেও পৃষ্ঠা-পৃষ্ঠা — PostgREST-এর ১০০০-সারির সীমা ছাড়ালে নতুন
        // প্রশ্ন/টপিক অ্যাডমিন প্যানেলের গণনা ও টপিক-ট্রিতে ধরা পড়ে না।
        fetchAllRows<any>((from, to) =>
          supabase
            .from("exam_questions_link")
            .select("exam_id, question_bank(topic)")
            .order("exam_id", { ascending: true })
            .order("question_id", { ascending: true })
            .range(from, to)
        ),
        fetchAllRows<any>((from, to) =>
          supabase
            .from("topic_questions")
            .select("topic, original_subject")
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to)
        ),
      ]);
      const timeoutPromiseLite = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Lite fetch timeout")), 4000)
      );
      // Fail fast instead of hanging the page when Supabase is slow/unreachable
      const [settingsRes, subjectsRes, examsRes, linksRowsLite, topicsRowsLite] = await Promise.race([
        fetchPromiseLite,
        timeoutPromiseLite.then(() => { throw new Error("Lite fetch timeout"); })
      ]);
      // নিচের ব্যবহারগুলো অপরিবর্তিত রাখতে পুরোনো আকারে মুড়ে দিই
      const linksRes = { data: linksRowsLite };
      const topicsRes = { data: topicsRowsLite };

      const settings = settingsRes?.data || {};
      const courses = settings.courses || DEFAULT_DATA.courses;
      const topics = settings.topics || DEFAULT_DATA.topics;
      const teacherPass = ""; // never expose the teacher pass to clients
      const driveRoutineUrl = settings.drive_routine_url || DEFAULT_DATA.driveRoutineUrl;
      const driveSyllabusUrl = settings.drive_syllabus_url || DEFAULT_DATA.driveSyllabusUrl;

      const subjects = (subjectsRes?.data || []).map((s) => ({
        name: s.name,
        course: s.course
      }));

      // Questions per exam: topic strings only (enough for counts + the topic tree)
      const questionsByExam: Record<string, { q: string; opts: string[]; topic?: string }[]> = {};
      (linksRes?.data || []).forEach((link: any) => {
        if (!questionsByExam[link.exam_id]) questionsByExam[link.exam_id] = [];
        questionsByExam[link.exam_id].push({
          q: "",
          opts: [],
          topic: link.question_bank?.topic || undefined
        });
      });

      const exams: Record<string, Exam> = {};
      const banglaTime = await import("@/lib/bangladesh-time");
      const parseBangladeshDateTime = banglaTime.parseBangladeshDateTime;
      const trueNowMs = banglaTime.getTrueDate().getTime();
      const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

      (examsRes?.data || []).forEach((ex) => {
        // "alread live e eseche, ba live cholche ba 12hr er moddhe live e asbe"
        // Ignore exams that are more than 12 hours in the future
        if (ex.start_time) {
          const start = parseBangladeshDateTime(ex.start_time);
          if (start && start.getTime() > trueNowMs + TWELVE_HOURS_MS) {
            return; // Skip far-future exams
          }
        }

        exams[ex.id] = {
          id: ex.id,
          course: ex.course,
          subject: ex.subject,
          title: ex.title,
          timerMinutes: ex.timer_minutes,
          isFree: ex.is_free,
          passMark: Number(ex.pass_mark),
          startTime: ex.start_time,
          endTime: ex.end_time,
          isResultPublished: ex.is_result_published,
          leaderboardStartTime: ex.leaderboard_start_time,
          leaderboardEndTime: ex.leaderboard_end_time,
          // Topic-only stubs: ex.questions.length stays correct, content loads on the exam page
          questions: questionsByExam[ex.id] || []
        };
      });

      // Topic questions: topics only (for the tree), full content loads on demand
      const topicQuestions: TopicQuestion[] = (topicsRes?.data || []).map((tq: any, i: number) => ({
        id: tq.id || `tq_lite_${i}`,
        topic: tq.topic || "",
        q: "",
        opts: [],
        correct: 0,
        exp: "",
        originalExamTitle: "",
        originalCourse: "",
        originalSubject: tq.original_subject || "",
        examKey: undefined,
        createdAt: ""
      }));

      const pinnedCourses = settings.pinned_courses || DEFAULT_DATA.pinnedCourses;

      const data: AppConfigData = {
        courses,
        subjects,
        topics,
        topicQuestions,
        exams,
        teacherPass,
        driveRoutineUrl,
        driveSyllabusUrl,
        pinnedCourses
      };

      cachedConfigLite = data;
      lastFetchTimeLite = Date.now();
      return data;
    } catch (err) {
      console.warn("Lite fetch failed:", err);
    } finally {
      inflightFetchLite = null;
    }

    if (cachedConfigLite) return cachedConfigLite;
    cachedConfigLite = DEFAULT_DATA;
    lastFetchTimeLite = Date.now();
    return DEFAULT_DATA;
  })();

  return inflightFetchLite;
}

// ─── Meta Config (no question rows at all — for the dashboard & native API) ──

let cachedConfigMeta: AppConfigData | null = null;
let lastFetchTimeMeta = 0;
let inflightFetchMeta: Promise<AppConfigData> | null = null;

/**
 * সবচেয়ে হালকা কনফিগ — **প্রশ্নের একটিও সারি টানে না**।
 *
 * ── কেন দরকার ──
 * `/api/home` (ফ্লাটার ড্যাশবোর্ড) ও `/api/courses` আসলে দরকার শুধু কোর্স-তালিকা,
 * বিষয়, ও পরীক্ষার **মেটাডেটা** — প্রশ্নের টেক্সট/অপশন/উত্তর নয়। কিন্তু ওরা
 * `fetchAppConfigLite` ডাকত, যা প্রতি প্রশ্নে একটি সারি আনে (`question_bank(topic)`
 * জয়েন + `topic_questions`)। ফলে হোম/কোর্স খোলার প্রতিবারই পুরো করপাসের সমান
 * সারি-সংখ্যা নামত: ১,০০০ প্রশ্নে ~৪১৬ KB, ১৫,০০০-এ ~৬ MB — অথচ দরকারি ডেটা
 * কয়েক KB।
 *
 * মোবাইলে এটাই সবচেয়ে ব্যয়বহুল ছিল, কারণ হোম স্ক্রিন প্রতিবার খোলা হয়।
 * `questions: []` ও `topicQuestions: []` পাঠানো হয় — এই দুটো ফিল্ডের কোনো
 * ভোক্তাই ওই দুই রুটে নেই (যাচাই করা)।
 *
 * ⚠️ কোনো পেজ যেখানে টপিক-ট্রি বা প্রশ্ন-সংখ্যা দেখায়, সেখানে এটা ব্যবহার করবেন না —
 * ওখানে `fetchAppConfigLite` (বা পূর্ণ `fetchAppConfig`) লাগবে।
 */
export async function fetchAppConfigMeta(): Promise<AppConfigData> {
  const now = Date.now();
  if (cachedConfigMeta && now - lastFetchTimeMeta < CACHE_TTL_MS) {
    return cachedConfigMeta;
  }
  if (inflightFetchMeta) return inflightFetchMeta;

  inflightFetchMeta = (async () => {
    try {
      const timeout = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Meta fetch timeout")), 4000)
      );
      const [settingsRes, subjectsRes, examsRes] = await Promise.race([
        Promise.all([
          supabase.from("app_settings").select("*").eq("id", "main").maybeSingle(),
          supabase.from("subjects").select("name, course"),
          supabase.from("exams").select("*").order("start_time", { ascending: true }),
        ]),
        timeout.then(() => { throw new Error("Meta fetch timeout"); })
      ]);

      const settings = settingsRes?.data || {};
      const courses = settings.courses || DEFAULT_DATA.courses;
      const topics = settings.topics || DEFAULT_DATA.topics;
      const teacherPass = ""; // never expose the teacher pass to clients
      const driveRoutineUrl = settings.drive_routine_url || DEFAULT_DATA.driveRoutineUrl;
      const driveSyllabusUrl = settings.drive_syllabus_url || DEFAULT_DATA.driveSyllabusUrl;

      const subjects = (subjectsRes?.data || []).map((s) => ({ name: s.name, course: s.course }));

      const exams: Record<string, Exam> = {};
      (examsRes?.data || []).forEach((ex) => {
        exams[ex.id] = {
          id: ex.id,
          course: ex.course,
          subject: ex.subject,
          title: ex.title,
          timerMinutes: ex.timer_minutes,
          isFree: ex.is_free,
          passMark: Number(ex.pass_mark),
          startTime: ex.start_time,
          endTime: ex.end_time,
          isResultPublished: ex.is_result_published,
          leaderboardStartTime: ex.leaderboard_start_time,
          leaderboardEndTime: ex.leaderboard_end_time,
          questions: []
        };
      });

      const data: AppConfigData = {
        courses,
        subjects,
        topics,
        topicQuestions: [],
        exams,
        teacherPass,
        driveRoutineUrl,
        driveSyllabusUrl,
        pinnedCourses: settings.pinned_courses || DEFAULT_DATA.pinnedCourses
      };

      cachedConfigMeta = data;
      lastFetchTimeMeta = Date.now();
      return data;
    } catch (err) {
      console.warn("Meta fetch failed:", err);
    } finally {
      inflightFetchMeta = null;
    }

    if (cachedConfigMeta) return cachedConfigMeta;
    cachedConfigMeta = DEFAULT_DATA;
    lastFetchTimeMeta = Date.now();
    return DEFAULT_DATA;
  })();

  return inflightFetchMeta;
}

// ─── Admin bootstrap: মেটাডেটা + সার্ভার-সাইড সংখ্যা (প্রশ্নের একটিও সারি নয়) ──

export interface AdminBootstrap {
  /** কোর্স, সাবজেক্ট, টপিক, পরীক্ষার মেটাডেটা — `questions: []`, `topicQuestions: []` */
  config: AppConfigData;
  /** প্রতি পরীক্ষায় প্রশ্নসংখ্যা — সার্ভারে গোনা, প্রশ্নের টেক্সট ছাড়া */
  examQuestionCounts: Record<string, number>;
  /** প্রতি পরীক্ষায় সাবমিশনসংখ্যা — কোন পরীক্ষা কতজন দিয়েছে (প্রশ্ন/উত্তর ছাড়া) */
  examSubmissionCounts: Record<string, number>;
}

/**
 * প্রতি পরীক্ষায় প্রশ্নসংখ্যা — প্রশ্নের টেক্সট না এনে।
 *
 * কেন দরকার: অ্যাডমিন তালিকায় প্রতিটি পরীক্ষার পাশে "প্রশ্ন: ৪২" দেখানো হয়।
 * আগে এই সংখ্যাটা বের করতে ওই পরীক্ষার **সব প্রশ্ন (q + opts)** ক্লায়েন্টে নামত;
 * মেটাডেটা-প্রথম লোডিংয়ে সেটা চলে না।
 *
 * পদ্ধতি: প্রতি পরীক্ষায় একটি HEAD count (`count: exact, head: true`) — কোনো
 * প্রশ্ন-সারি ডাউনলোড হয় না, শুধু সংখ্যা আসে (মাপা: ১৯ পরীক্ষায় ~১১৫ ms, ~০.৪ KB),
 * আর PostgREST-এর ১০০০-সারির সীমাও এড়ায়। ছোট ব্যাচে সমান্তরালে চলে।
 *
 * (আগে একটি ঐচ্ছিক ডেটাবেজ-ফাংশনও (RPC) চেষ্টা করা হত; সেটি Supabase-এ আলাদা করে
 * চালাতে হত বলে সরিয়ে দেওয়া হয়েছে — এখন কোনো বাড়তি ধাপ নেই।)
 */
export async function getExamQuestionCounts(forceRefresh = false): Promise<Record<string, number>> {
  await requireTeacher();

  const now = Date.now();
  if (!forceRefresh && cachedExamCounts && now - cachedExamCounts.at < EXAM_COUNTS_TTL_MS) {
    return cachedExamCounts.data;
  }
  if (inflightExamCounts) return inflightExamCounts;

  const work = (async () => {
    const counts: Record<string, number> = {};
    try {
      const { data: exams } = await supabase.from("exams").select("id");
      const ids = (exams || []).map((e: { id: unknown }) => String(e.id)).filter(Boolean);
      const BATCH = 25;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((id) =>
            supabase.from("exam_questions_link").select("*", { count: "exact", head: true }).eq("exam_id", id)
          )
        );
        results.forEach((r, idx) => {
          counts[batch[idx]] = Number(r.count || 0);
        });
      }
    } catch (err) {
      console.error("Exam question counts error:", err);
    }
    return counts;
  })();

  inflightExamCounts = work;
  try {
    const data = await work;
    cachedExamCounts = { at: Date.now(), data };
    return data;
  } finally {
    if (inflightExamCounts === work) inflightExamCounts = null;
  }
}

/**
 * কোন পরীক্ষা কতজন দিয়েছে — `Record<examKey, সাবমিশন-সংখ্যা>`।
 *
 * কেন দরকার: শিক্ষক প্যানেলের তালিকায় দেখা দরকার "এই পরীক্ষাটা দেওয়া হয়েছে কি
 * না" — আর আগে সেটা দেখতে হলে `getAllSubmissions()` ডাকতে হত, যা **সব**
 * সাবমিশন (উত্তর-অ্যারে সহ, প্রতি রো কয়েক KB) টেনে আনে।
 *
 * পদ্ধতি: প্রতি পরীক্ষায় একটি HEAD count (`count: exact, head: true`) — কোনো
 * সাবমিশন-সারি ডাউনলোড হয় না, শুধু সংখ্যা আসে।
 *
 * (আগে একটি ঐচ্ছিক ডেটাবেজ-ফাংশনও (RPC) চেষ্টা করা হত; Supabase-এ আলাদা করে চালাতে
 * হত বলে সরিয়ে দেওয়া হয়েছে — এখন কোনো বাড়তি ধাপ নেই।)
 *
 * SECURITY: `requireTeacher` — এটা শুধু শিক্ষকের সংখ্যা। শিক্ষার্থীর নিজের সংখ্যা
 * `student-actions.ts → getCompletedExamKeys()` থেকে আসে (সেশন-মালিকানা যাচাই করে)।
 */
export async function getExamSubmissionCounts(forceRefresh = false): Promise<Record<string, number>> {
  await requireTeacher();

  const now = Date.now();
  if (!forceRefresh && cachedSubmissionCounts && now - cachedSubmissionCounts.at < SUBMISSION_COUNTS_TTL_MS) {
    return cachedSubmissionCounts.data;
  }
  if (inflightSubmissionCounts) return inflightSubmissionCounts;

  const work = (async () => {
    const counts: Record<string, number> = {};
    try {
      const { data: exams } = await supabase.from("exams").select("id");
      const ids = (exams || []).map((e: { id: unknown }) => String(e.id)).filter(Boolean);
      const BATCH = 25;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map((id) =>
            supabase.from("submissions").select("*", { count: "exact", head: true }).eq("exam_key", id)
          )
        );
        results.forEach((r, idx) => {
          counts[batch[idx]] = Number(r.count || 0);
        });
      }
    } catch (err) {
      console.error("Exam submission counts error:", err);
    }
    return counts;
  })();

  inflightSubmissionCounts = work;
  try {
    const data = await work;
    cachedSubmissionCounts = { at: Date.now(), data };
    return data;
  } finally {
    if (inflightSubmissionCounts === work) inflightSubmissionCounts = null;
  }
}

/**
 * অ্যাডমিন প্যানেলের প্রথম লোড — **শুধু মেটাডেটা**।
 *
 * আগে `fetchAppConfig(true)` ডাকা হত: প্রতিটি পরীক্ষার সব প্রশ্ন + পুরো
 * topic_questions (উত্তর ও ব্যাখ্যাসহ) — পরিমাপ: ~২ MB, ~১.৭ সেকেন্ড, আর
 * প্রতিটি কোর্স/সাবজেক্ট/টপিক/পরীক্ষা সেভ করার পরেই আবার। এখন যা আসে: কোর্স,
 * সাবজেক্ট, টপিক, পরীক্ষার মেটাডেটা আর প্রতি পরীক্ষার প্রশ্নসংখ্যা (~৫০ KB)।
 *
 * প্রকৃত প্রশ্ন আসে কেবল যে সেকশন খোলা হয় তার:
 *   • পরীক্ষার প্রশ্ন → `fetchExamWithQuestions(examKey)` ভিউ খোলার সময়
 *   • প্রশ্নব্যাংক     → `searchQuestionBank(...)` ফিল্টার/সার্চ অনুযায়ী
 */
export async function fetchAdminBootstrap(options?: { forceRefresh?: boolean }): Promise<AdminBootstrap> {
  await requireTeacher();
  const force = options?.forceRefresh === true;

  // `fetchAppConfigMeta`-র নিজের ৬০ সেকেন্ডের ক্যাশ আছে, আর প্রতিটি write-action
  // `invalidateConfigCache()` ডাকে — তাই সেভের পরের লোডে টাটকা মেটাডেটাই আসে।
  const [config, examQuestionCounts, examSubmissionCounts] = await Promise.all([
    fetchAppConfigMeta(),
    getExamQuestionCounts(force),
    getExamSubmissionCounts(force)
  ]);

  return { config, examQuestionCounts, examSubmissionCounts };
}

export async function saveAppConfig(config: Partial<AppConfigData>): Promise<boolean> {
  try {
    await requireTeacher();
    const updateData: any = {};
    if (config.courses) updateData.courses = config.courses;
    if (config.topics) updateData.topics = config.topics;
    if (config.teacherPass) updateData.teacher_pass = config.teacherPass;
    if (config.driveRoutineUrl) updateData.drive_routine_url = config.driveRoutineUrl;
    if (config.driveSyllabusUrl) updateData.drive_syllabus_url = config.driveSyllabusUrl;
    if (config.pinnedCourses) updateData.pinned_courses = config.pinnedCourses;

    if (Object.keys(updateData).length > 0) {
      const { error: settingsError } = await supabase
        .from("app_settings")
        .upsert({ id: "main", ...updateData });
      if (settingsError) throw settingsError;
    }

    if (config.subjects) {
      // Sync subjects table
      const { error: deleteError } = await supabase
        .from("subjects")
        .delete()
        .neq("name", "___nonexistent_subject___");
      if (deleteError) throw deleteError;

      const { error: insertError } = await supabase
        .from("subjects")
        .insert(config.subjects.map((s) => ({ name: s.name, course: s.course })));
      if (insertError) throw insertError;
    }

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Save app config error:", err);
    return false;
  }
}

export async function createExam(examData: Omit<Exam, "id">): Promise<string | null> {
  try {
    await requireTeacher();
    const examKey = `exam_${Date.now()}`;
    const { error } = await supabase.from("exams").insert({
      id: examKey,
      course: examData.course,
      subject: examData.subject,
      title: examData.title,
      timer_minutes: examData.timerMinutes,
      is_free: examData.isFree ?? false,
      pass_mark: examData.passMark ?? 1,
      start_time: examData.startTime || null,
      end_time: examData.endTime || null,
      is_result_published: examData.isResultPublished ?? false,
      leaderboard_start_time: examData.leaderboardStartTime || null,
      leaderboard_end_time: examData.leaderboardEndTime || null
    });

    if (error) throw error;

    invalidateConfigCache();
    return examKey;
  } catch (err) {
    console.error("Create exam error:", err);
    return null;
  }
}

export async function updateExam(examKey: string, examData: Partial<Exam>): Promise<boolean> {
  try {
    await requireTeacher();
    const updateData: any = {};
    if (examData.course) updateData.course = examData.course;
    if (examData.subject) updateData.subject = examData.subject;
    if (examData.title) updateData.title = examData.title;
    if (examData.timerMinutes !== undefined) updateData.timer_minutes = examData.timerMinutes;
    if (examData.isFree !== undefined) updateData.is_free = examData.isFree;
    if (examData.passMark !== undefined) updateData.pass_mark = examData.passMark;
    if (examData.startTime !== undefined) updateData.start_time = examData.startTime || null;
    if (examData.endTime !== undefined) updateData.end_time = examData.endTime || null;
    if (examData.isResultPublished !== undefined) updateData.is_result_published = examData.isResultPublished;
    if (examData.leaderboardStartTime !== undefined) updateData.leaderboard_start_time = examData.leaderboardStartTime || null;
    if (examData.leaderboardEndTime !== undefined) updateData.leaderboard_end_time = examData.leaderboardEndTime || null;

    const { error } = await supabase
      .from("exams")
      .update(updateData)
      .eq("id", examKey);

    if (error) throw error;

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Update exam error:", err);
    return false;
  }
}

export async function deleteExam(examKey: string): Promise<boolean> {
  try {
    await requireTeacher();
    const { error } = await supabase.from("exams").delete().eq("id", examKey);
    if (error) throw error;

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Delete exam error:", err);
    return false;
  }
}

/**
 * Rename a course across EVERY table that stores it: the registered courses
 * list, the subjects table, the exams table, question_bank and topic_questions.
 * Previously this was attempted via saveAppConfig with full config payloads,
 * which silently dropped exams/topicQuestions and orphaned exams under the old
 * course name.
 */
export async function renameCourse(
  oldName: string,
  newName: string
): Promise<{ success: boolean; message?: string }> {
  try {
    await requireTeacher();
    const oldV = String(oldName || "").trim();
    const newV = String(newName || "").trim();
    if (!oldV || !newV || oldV === newV) {
      return { success: false, message: "পুরনো ও নতুন কোর্সের নাম প্রয়োজন।" };
    }

    // 1. Registered courses list in app_settings
    const { data: settings } = await supabase
      .from("app_settings")
      .select("courses")
      .eq("id", "main")
      .maybeSingle();
    const courses: string[] = (settings?.courses || []).map((c: string) => String(c));
    const nextCourses = courses.map((c) => (c === oldV ? newV : c));
    if (JSON.stringify(nextCourses) !== JSON.stringify(courses)) {
      const { error } = await supabase
        .from("app_settings")
        .upsert({ id: "main", courses: nextCourses });
      if (error) throw error;
    }

    // 2. Subjects table
    const { error: subjErr } = await supabase
      .from("subjects")
      .update({ course: newV })
      .eq("course", oldV);
    if (subjErr) throw subjErr;

    // 3. Exams table (orphaned exams become visible again under the new name)
    const { error: examErr } = await supabase
      .from("exams")
      .update({ course: newV })
      .eq("course", oldV);
    if (examErr) throw examErr;

    // 4. question_bank
    const { error: qbErr } = await supabase
      .from("question_bank")
      .update({ course: newV })
      .eq("course", oldV);
    if (qbErr) throw qbErr;

    // 5. topic_questions
    const { error: tqErr } = await supabase
      .from("topic_questions")
      .update({ original_course: newV })
      .eq("original_course", oldV);
    if (tqErr) throw tqErr;

    // 6. course_prices (টেবিল না থাকলে কিছু হবে না)
    try {
      await supabase.from("course_prices").update({ course: newV }).eq("course", oldV);
    } catch {
      // ignore missing table
    }

    invalidateConfigCache();
    return { success: true };
  } catch (err) {
    console.error("Rename course error:", err);
    return { success: false, message: "কোর্স রিনেম করতে সমস্যা হয়েছে।" };
  }
}

export async function addQuestionToExam(
  examKey: string,
  question: QuestionItem,
  solution: QuestionSolution
): Promise<boolean | string> {
  try {
    await requireTeacher();
    const { data: examData, error: examError } = await supabase
      .from("exams")
      .select("title, course, subject")
      .eq("id", examKey)
      .single();

    if (examError) throw examError;

    // Deduplicate: skip if an identical question already exists in this exam
    const qText = String(question.q || "").trim().toLowerCase();
    if (qText) {
      const { data: existingLinks } = await supabase
        .from("exam_questions_link")
        .select("question_bank(q)")
        .eq("exam_id", examKey);
      const exists = (existingLinks || []).some((l: any) => {
        const qb = Array.isArray(l.question_bank) ? l.question_bank[0] : l.question_bank;
        return qb && String(qb.q || "").trim().toLowerCase() === qText;
      });
      if (exists) {
        throw new Error("এই প্রশ্নটি এই পরীক্ষায় আগেই যুক্ত করা হয়েছে!");
      }
    }

    // 1. Insert question into question_bank
    const targetTopic = question.topic?.trim() || "সাধারণ";
    const { data: newQ, error: qError } = await supabase
      .from("question_bank")
      .insert({
        q: question.q.trim(),
        opts: question.opts.map((o) => o.trim()),
        topic: targetTopic,
        correct: Number(solution.correct),
        exp: solution.exp.trim(),
        course: examData.course,
        subject: examData.subject
      })
      .select("id")
      .single();

    if (qError) throw qError;

    // 2. Find next order index
    const { data: currentLinks } = await supabase
      .from("exam_questions_link")
      .select("order_index")
      .eq("exam_id", examKey);

    const maxIndex = (currentLinks || []).reduce((max, link) => Math.max(max, Number(link.order_index)), -1);
    const nextIndex = maxIndex + 1;

    // 3. Link question to exam
    const { error: linkError } = await supabase
      .from("exam_questions_link")
      .insert({
        exam_id: examKey,
        question_id: newQ.id,
        order_index: nextIndex
      });

    if (linkError) throw linkError;

    // 4. Also add to topic questions pool for Self Practice mode
    const { error: tqError } = await supabase.from("topic_questions").insert({
      id: `tq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      topic: targetTopic,
      q: question.q.trim(),
      opts: question.opts.map((o) => o.trim()),
      correct: Number(solution.correct),
      exp: solution.exp.trim(),
      original_exam_title: examData.title,
      original_course: examData.course,
      original_subject: examData.subject,
      exam_key: examKey
    });
    if (tqError) throw tqError;

    // Mark all submissions as pending so they recalculate the score for everyone
    await supabase.from("submissions").update({ is_pending_evaluation: true }).eq("exam_key", examKey);

    invalidateConfigCache();
    return true;
  } catch (err: any) {
    console.error("Add question error:", err);
    return err.message || "Unknown error";
  }
}

export interface LinkQuestionResult {
  ok: boolean;
  /** ইতিমধ্যে ওই পরীক্ষায় যুক্ত ছিল — ত্রুটি নয়। */
  alreadyLinked?: boolean;
  /** ব্যর্থ হলে আসল কারণ। */
  error?: string;
}

export async function linkQuestionToExam(
  examKey: string,
  questionId: string
): Promise<LinkQuestionResult> {
  try {
    await requireTeacher();
    if (!examKey || !questionId) {
      return { ok: false, error: "পরীক্ষা বা প্রশ্নের আইডি পাওয়া যায়নি।" };
    }

    // ── কেন আগে থেকেই যুক্ত কি না দেখি ──
    // `exam_questions_link`-এর PRIMARY KEY = (exam_id, question_id), তাই একই প্রশ্ন
    // আবার insert করলে 23505 ডুপ্লিকেট-কী ত্রুটি আসে। কিন্তু মডাল ডুপ্লিকেট লুকায়
    // প্রশ্নের **টেক্সট** মিলিয়ে (QuestionBankSearchModal-এর isTextAdded), আইডি দিয়ে
    // নয় — তাই টেক্সটের সামান্য পার্থক্য বা বাসি তালিকায় বোতামটা দেখা যায়, আর
    // চাপলেই ক্লিক ব্যর্থ হয়। এখন "আগেই যুক্ত" মানে সফল, ত্রুটি নয়।
    const { data: existing, error: existsError } = await supabase
      .from("exam_questions_link")
      .select("question_id")
      .eq("exam_id", examKey)
      .eq("question_id", questionId)
      .maybeSingle();

    if (existsError) throw existsError;
    if (existing) return { ok: true, alreadyLinked: true };

    const { data: currentLinks, error: fetchError } = await supabase
      .from("exam_questions_link")
      .select("order_index")
      .eq("exam_id", examKey);

    if (fetchError) throw fetchError;

    const maxIndex = (currentLinks || []).reduce((max, link) => Math.max(max, Number(link.order_index)), -1);
    const nextIndex = maxIndex + 1;

    const { error: linkError } = await supabase
      .from("exam_questions_link")
      .insert({
        exam_id: examKey,
        question_id: questionId,
        order_index: nextIndex
      });

    if (linkError) {
      // একই মুহূর্তে অন্য কেউ যুক্ত করে ফেললে ডুপ্লিকেট-কী আসতে পারে — সেটাও সফলই
      if ((linkError as { code?: string }).code === "23505") {
        return { ok: true, alreadyLinked: true };
      }
      throw linkError;
    }

    // Mark all submissions as pending so they recalculate the score for everyone
    await supabase.from("submissions").update({ is_pending_evaluation: true }).eq("exam_key", examKey);

    invalidateConfigCache();
    return { ok: true };
  } catch (err) {
    console.error("Link question error:", err);
    return { ok: false, error: describeError(err) };
  }
}

/**
 * প্রশ্নব্যাংকের তালিকা — সার্ভার-সাইড সার্চ/ফিল্টার **এবং** পেজিনেশন।
 *
 * ⚠️ কেন পেজিনেশন বাধ্যতামূলক: `question_bank`-এ হাজার হাজার সারি হতে পারে।
 * আগে ফাংশনটি `.limit(100)` দিয়ে কেবল প্রথম ১০০টি ফেরাত — ব্যবহারকারী জানতেনই না
 * যে আরও ৯০০+ প্রশ্ন আছে, আর "সব সিলেক্ট করে মুছুন" ধারণাটাই ভুল ছিল। এখন:
 *   • `count: "exact"` — মোট কতটি মিলল সেটাও আসে (তালিকা স্ক্রল না করেই জানা যায়)
 *   • `.range(from, to)` — কেবল ওই পেজের সারিগুলোই ডাউনলোড হয়
 *   • ক্রম সবসময় নির্দিষ্ট (`id` tiebreaker সহ) — নাহলে পেজ বদলালে কোনো সারি
 *     দুইবার আসত বা একবারও আসত না (Postgres সমান মানের সারি যেকোনো ক্রমে দিতে পারে)
 *
 * ফিল্টার এখনো SQL-এই বসে (`ilike` সার্চ, `eq` টপিক/সাবজেক্ট) — পুরো টেবিল
 * কখনো ক্লায়েন্টে নামে না। PostgREST filter grammar-এ ব্যবহারকারীর ইনপুট কখনো
 * সরাসরি বসে না (metacharacter পরিষ্কার করা হয়)।
 */
export async function searchQuestionBank(
  queryText: string,
  topic?: string,
  subject?: string,
  sortRecent: boolean = false,
  page: number = 1,
  pageSize: number = 100
): Promise<{ questions: any[]; total: number; page: number; pageSize: number; totalPages: number }> {
  try {
    await requireTeacher();

    const safePage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.floor(Number(page)) : 1;
    const requestedSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Math.floor(Number(pageSize)) : 100;
    const safeSize = Math.min(100, Math.max(1, requestedSize));
    const from = (safePage - 1) * safeSize;
    const to = from + safeSize - 1;

    const build = (withOrder: boolean) => {
      let builder = supabase.from("question_bank").select("*", { count: "exact" });
      if (queryText) {
        builder = builder.ilike("q", `%${queryText}%`);
      }
      if (topic && topic !== "ALL") {
        // "সাধারণ" is the fallback topic — also match questions with no topic assigned
        //
        // ⚠️ SECURITY: never interpolate raw caller input into PostgREST filter
        // grammar (.or()/.like()). Strip the grammar metacharacters (comma, parens,
        // ;, *, and the LIKE wildcards) so a crafted topic cannot inject extra
        // filter conditions.
        //
        // 🎯 উপ-টপিকসহ ম্যাচ: "বাংলা" বাছলে শুধু হুবহু "বাংলা" নয়, তার সব উপ-টপিকও
        // ("বাংলা > প্রাচীন যুগ > চর্যাপদ") আসবে — অ্যাডমিনে টপিক বেছে প্রশ্ন
        // খোঁজার সময় এটাই স্বাভাবিক প্রত্যাশা। প্যাটার্ন: `topic = 'বাংলা'` অথবা
        // `topic LIKE 'বাংলা > %'` (টপিক-পাথের বিভাজক সর্বদা " > ", তাই নিরাপদ)।
        const safeTopic = String(topic).replace(/[(),;*\\%_]/g, "").trim();
        if (safeTopic) {
          builder = safeTopic === "সাধারণ"
            ? builder.or(`topic.eq.${safeTopic},topic.is.null`)
            : builder.or(`topic.eq.${safeTopic},topic.like.${safeTopic} > %`);
        }
      }
      if (subject && subject !== "ALL") {
        builder = builder.eq("subject", subject);
      }
      // id tiebreaker always: একই created_at-এর সারি থাকলে পেজিনেশন স্থির থাকে।
      // (আগে order ছাড়াই limit ছিল — পেজ বদলালে সারি হারাত/দুইবার আসত।)
      builder = withOrder
        ? builder.order("created_at", { ascending: false }).order("id", { ascending: true })
        : builder.order("id", { ascending: true });
      return builder.range(from, to);
    };

    let data: any[] | null = null;
    let count: number | null = null;
    try {
      const res = await build(sortRecent);
      if (res.error) throw res.error;
      data = res.data;
      count = res.count;
    } catch (err) {
      // created_at কলাম না থাকলে (পুরনো DB) — সর্ট ছাড়াই আবার চেষ্টা
      if (sortRecent) {
        const res = await build(false);
        if (!res.error) {
          data = res.data;
          count = res.count;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    const total = Number(count || 0);
    return {
      questions: data || [],
      total,
      page: safePage,
      pageSize: safeSize,
      totalPages: Math.max(1, Math.ceil(total / safeSize))
    };
  } catch (err) {
    console.error("Search question bank error:", err);
    return { questions: [], total: 0, page: 1, pageSize: 100, totalPages: 1 };
  }
}

export async function updateQuestionInExam(
  examKey: string,
  index: number,
  question: QuestionItem,
  solution: QuestionSolution
): Promise<boolean> {
  try {
    await requireTeacher();
    const { data: examData, error: examError } = await supabase
      .from("exams")
      .select("title, course, subject")
      .eq("id", examKey)
      .single();

    if (examError) throw examError;

    const { data: links, error: fetchError } = await supabase
      .from("exam_questions_link")
      .select("question_id")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (fetchError) throw fetchError;

    const targetLink = links?.[index];
    if (!targetLink) return false;

    // Fetch old question text to match in topic_questions in case question text changed
    const { data: oldQData } = await supabase
      .from("question_bank")
      .select("q")
      .eq("id", targetLink.question_id)
      .single();

    const oldQText = oldQData?.q || "";
    const targetTopic = question.topic?.trim() || "সাধারণ";

    const { error: updateError } = await supabase
      .from("question_bank")
      .update({
        q: question.q.trim(),
        opts: question.opts.map((o) => o.trim()),
        topic: targetTopic,
        correct: Number(solution.correct),
        exp: solution.exp.trim()
      })
      .eq("id", targetLink.question_id);

    if (updateError) throw updateError;

    const lookupText = oldQText || question.q.trim();
    const { data: existingTq } = await supabase
      .from("topic_questions")
      .select("id")
      .eq("exam_key", examKey)
      .eq("q", lookupText)
      .maybeSingle();

    if (existingTq) {
      await supabase
        .from("topic_questions")
        .update({
          topic: targetTopic,
          q: question.q.trim(),
          opts: question.opts.map((o) => o.trim()),
          correct: Number(solution.correct),
          exp: solution.exp.trim()
        })
        .eq("id", existingTq.id);
    } else {
      await supabase.from("topic_questions").insert({
        id: `tq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        topic: targetTopic,
        q: question.q.trim(),
        opts: question.opts.map((o) => o.trim()),
        correct: Number(solution.correct),
        exp: solution.exp.trim(),
        original_exam_title: examData.title,
        original_course: examData.course,
        original_subject: examData.subject,
        exam_key: examKey
      });
    }

    // Mark all submissions as pending so they recalculate the score for everyone
    await supabase.from("submissions").update({ is_pending_evaluation: true }).eq("exam_key", examKey);

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Update question error:", err);
    return false;
  }
}

// ─── Archive Functions (Soft Delete / Trash Bin) ─────────────────────────

async function addQuestionsToArchive(questions: ArchivedQuestion[]): Promise<boolean> {
  try {
    const { data: settings } = await supabase
      .from("app_settings")
      .select("archived_questions")
      .eq("id", "main")
      .maybeSingle();

    const existingArchive: ArchivedQuestion[] = settings?.archived_questions || [];
    const updatedArchive = [...questions, ...existingArchive];

    await supabase
      .from("app_settings")
      .upsert({ id: "main", archived_questions: updatedArchive });

    return true;
  } catch (err) {
    console.error("Add questions to archive error:", err);
    return false;
  }
}

export async function getArchivedQuestions(): Promise<ArchivedQuestion[]> {
  try {
    await requireTeacher();
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("archived_questions")
      .eq("id", "main")
      .maybeSingle();

    if (error) throw error;
    return settings?.archived_questions || [];
  } catch (err) {
    console.error("Get archived questions error:", err);
    return [];
  }
}

/**
 * আর্কাইভ থেকে চিরতরে মুছে ফেলা।
 *
 * ⚠️ আগে এই ফাংশন **সবসময় `true` ফেরাত** — ভেতরের upsert/delete ব্যর্থ হলেও
 * এরর চেপে যেত আর UI "সফলভাবে মুছে ফেলা হয়েছে" দেখাত, অথচ প্রশ্নটা ওখানেই
 * থাকত। এখন প্রতিটি ধাপের ফল পরীক্ষা করা হয়, কারণ ফেরত দেওয়া হয়, আর
 * সার্ভার-লগে সারসংক্ষেপ লেখা হয় (কোনোদিন আটকালে লগ থেকেই ধরা পড়বে)।
 */
export async function permanentDeleteArchivedQuestions(
  ids: string[]
): Promise<{ success: boolean; removed: number; message?: string }> {
  try {
    await requireTeacher();

    if (!Array.isArray(ids) || ids.length === 0) {
      return { success: false, removed: 0, message: "মুছে ফেলার জন্য কোনো প্রশ্ন নির্বাচন করা হয়নি।" };
    }

    const { data: settings, error: selErr } = await supabase
      .from("app_settings")
      .select("archived_questions")
      .eq("id", "main")
      .maybeSingle();
    if (selErr) {
      return { success: false, removed: 0, message: `আর্কাইভ পড়া যায়নি: ${selErr.message}` };
    }

    const existingArchive: ArchivedQuestion[] = settings?.archived_questions || [];
    const idSet = new Set(ids);
    const updatedArchive = existingArchive.filter((q) => !idSet.has(q.id));
    const removed = existingArchive.length - updatedArchive.length;

    if (removed > 0) {
      const { error: upErr } = await supabase
        .from("app_settings")
        .upsert({ id: "main", archived_questions: updatedArchive });
      if (upErr) {
        return { success: false, removed: 0, message: `আর্কাইভ হালনাগাদ করা যায়নি: ${upErr.message}` };
      }
    }

    // প্রশ্নব্যাংকে ঢুকে থাকলে সেটাও চিরতরে মুছে দেওয়া হয়
    const { error: qbErr } = await supabase.from("question_bank").delete().in("id", ids);
    if (qbErr) {
      console.error("[archive-delete] question_bank ডিলিট ব্যর্থ:", qbErr.message);
    }

    console.log(
      `[archive-delete] পাঠানো id=${ids.length} | আর্কাইভে আগে=${existingArchive.length} পরে=${updatedArchive.length} | সরানো=${removed} | question_bank=${qbErr ? "ERR" : "OK"}`
    );

    invalidateConfigCache();

    if (removed === 0) {
      // id না মিললে কখনোই নীরব সফলতা দেখানো উচিত নয়
      return {
        success: false,
        removed: 0,
        message: "আর্কাইভে এই প্রশ্নটি খুঁজে পাওয়া যায়নি — তালিকা রিফ্রেশ করে আবার চেষ্টা করুন।",
      };
    }

    return { success: true, removed };
  } catch (err: any) {
    console.error("Permanent delete archived questions error:", err);
    return { success: false, removed: 0, message: err?.message || "মুছে ফেলতে সমস্যা হয়েছে।" };
  }
}

export async function restoreArchivedQuestions(
  ids: string[],
  targetExamKey?: string
): Promise<boolean> {
  try {
    await requireTeacher();
    const { data: settings } = await supabase
      .from("app_settings")
      .select("archived_questions")
      .eq("id", "main")
      .maybeSingle();

    const existingArchive: ArchivedQuestion[] = settings?.archived_questions || [];
    const idSet = new Set(ids);
    const toRestore = existingArchive.filter((q) => idSet.has(q.id));
    const remainingArchive = existingArchive.filter((q) => !idSet.has(q.id));

    if (toRestore.length === 0) return true;

    // Restore to question_bank and/or exam
    for (const item of toRestore) {
      // 1. Re-insert or ensure in question_bank
      const { data: insertedQ } = await supabase
        .from("question_bank")
        .insert({
          id: item.id.startsWith("arch_") ? undefined : item.id,
          q: item.q,
          opts: item.opts,
          correct: item.correct,
          exp: item.exp || "",
          topic: item.topic || "সাধারণ"
        })
        .select("id")
        .single();

      const qId = insertedQ?.id || item.id;

      // 2. If target exam or original exam specified, link it back
      const examId = targetExamKey || (item.sourceType === "exam" ? item.sourceExamKey : undefined);
      if (examId) {
        const { data: links } = await supabase
          .from("exam_questions_link")
          .select("order_index")
          .eq("exam_id", examId)
          .order("order_index", { ascending: false })
          .limit(1);

        const nextOrder = (links?.[0]?.order_index ?? -1) + 1;

        await supabase.from("exam_questions_link").insert({
          exam_id: examId,
          question_id: qId,
          order_index: nextOrder
        });
      }
    }

    // Update archive state
    await supabase
      .from("app_settings")
      .upsert({ id: "main", archived_questions: remainingArchive });

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Restore archived questions error:", err);
    return false;
  }
}

export async function reorderExamQuestion(
  examKey: string,
  index: number,
  direction: "up" | "down"
): Promise<boolean> {
  try {
    await requireTeacher();

    const { data: links, error: fetchError } = await supabase
      .from("exam_questions_link")
      .select("question_id, order_index")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (fetchError) throw fetchError;
    if (!links || links.length === 0) return false;

    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= links.length) return false;

    const linkA = links[index];
    const linkB = links[swapIndex];

    // Swap their order_index values
    const [resA, resB] = await Promise.all([
      supabase
        .from("exam_questions_link")
        .update({ order_index: Number(linkB.order_index) })
        .eq("exam_id", examKey)
        .eq("question_id", linkA.question_id),
      supabase
        .from("exam_questions_link")
        .update({ order_index: Number(linkA.order_index) })
        .eq("exam_id", examKey)
        .eq("question_id", linkB.question_id),
    ]);

    if (resA.error) throw resA.error;
    if (resB.error) throw resB.error;

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Reorder exam question error:", err);
    return false;
  }
}

export async function deleteQuestionFromExam(examKey: string, index: number): Promise<boolean> {
  try {
    await requireTeacher();
    const { data: examData } = await supabase
      .from("exams")
      .select("title")
      .eq("id", examKey)
      .single();

    const { data: links, error: fetchError } = await supabase
      .from("exam_questions_link")
      .select("question_id, order_index, question_bank(id, q, opts, correct, exp, topic)")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (fetchError) throw fetchError;

    const targetLink = links?.[index];
    if (!targetLink) return false;

    // Archive the question before unlinking
    const qData: any = targetLink.question_bank;
    if (qData) {
      await addQuestionsToArchive([
        {
          id: qData.id || `arch_${Date.now()}`,
          q: qData.q,
          opts: qData.opts || [],
          correct: Number(qData.correct ?? 0),
          exp: qData.exp || "",
          topic: qData.topic || "",
          sourceType: "exam",
          sourceExamKey: examKey,
          sourceExamTitle: examData?.title || "এক্সাম",
          deletedAt: new Date().toISOString()
        }
      ]);
    }

    // 1. Delete the link
    const { error: deleteLinkError } = await supabase
      .from("exam_questions_link")
      .delete()
      .eq("exam_id", examKey)
      .eq("question_id", targetLink.question_id);

    if (deleteLinkError) throw deleteLinkError;

    // 2. Shift other questions
    const remaining = links.filter((_, i) => i !== index);
    const batchUpdates = remaining.map((link, newIdx) =>
      supabase
        .from("exam_questions_link")
        .update({ order_index: newIdx })
        .eq("exam_id", examKey)
        .eq("question_id", link.question_id)
    );

    await Promise.all(batchUpdates);

    // Mark all submissions as pending so they recalculate the score for everyone
    await supabase.from("submissions").update({ is_pending_evaluation: true }).eq("exam_key", examKey);

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Delete question error:", err);
    return false;
  }
}

export async function bulkDeleteQuestionsFromExam(
  examKey: string,
  indices: number[]
): Promise<boolean> {
  try {
    await requireTeacher();
    if (!indices || indices.length === 0) return true;

    const { data: examData } = await supabase
      .from("exams")
      .select("title")
      .eq("id", examKey)
      .single();

    const { data: links, error: fetchError } = await supabase
      .from("exam_questions_link")
      .select("question_id, order_index, question_bank(id, q, opts, correct, exp, topic)")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (fetchError) throw fetchError;
    if (!links || links.length === 0) return true;

    const indexSet = new Set(indices);
    const targetLinks = links.filter((_, i) => indexSet.has(i));
    const targetQIds = targetLinks.map((l) => l.question_id);

    // Archive all target questions
    const toArchive: ArchivedQuestion[] = targetLinks
      .map((l: any) => {
        const qData = l.question_bank;
        if (!qData) return null;
        return {
          id: qData.id || `arch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          q: qData.q,
          opts: qData.opts || [],
          correct: Number(qData.correct ?? 0),
          exp: qData.exp || "",
          topic: qData.topic || "",
          sourceType: "exam" as const,
          sourceExamKey: examKey,
          sourceExamTitle: examData?.title || "এক্সাম",
          deletedAt: new Date().toISOString()
        };
      })
      .filter(Boolean) as ArchivedQuestion[];

    if (toArchive.length > 0) {
      await addQuestionsToArchive(toArchive);
    }

    // Delete links
    await supabase
      .from("exam_questions_link")
      .delete()
      .eq("exam_id", examKey)
      .in("question_id", targetQIds);

    // Re-index remaining links
    const remainingLinks = links.filter((_, i) => !indexSet.has(i));
    const batchUpdates = remainingLinks.map((link, newIdx) =>
      supabase
        .from("exam_questions_link")
        .update({ order_index: newIdx })
        .eq("exam_id", examKey)
        .eq("question_id", link.question_id)
    );

    await Promise.all(batchUpdates);

    // Mark all submissions as pending so they recalculate the score for everyone
    await supabase.from("submissions").update({ is_pending_evaluation: true }).eq("exam_key", examKey);

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Bulk delete questions from exam error:", err);
    return false;
  }
}

export async function toggleExamResultPublish(examKey: string, publish: boolean): Promise<boolean> {
  try {
    await requireTeacher();
    const { error: examUpdateError } = await supabase
      .from("exams")
      .update({ is_result_published: publish })
      .eq("id", examKey);

    if (examUpdateError) throw examUpdateError;

    const { data: subs, error: subsError } = await supabase
      .from("submissions")
      .select("*")
      .eq("exam_key", examKey);

    if (subsError) throw subsError;

    const solutions = publish ? await getExamSolutions(examKey) : null;
    const batchUpdates: Promise<any>[] = [];

    (subs || []).forEach((row) => {
      if (publish && solutions && Array.isArray(row.answers)) {
        let correct = 0;
        let incorrect = 0;
        row.answers.forEach((ans: number | null, idx: number) => {
          const sol = solutions[idx];
          if (ans !== null && ans !== -1 && sol) {
            if (ans === sol.correct) correct++;
            else incorrect++;
          }
        });
        const score = Math.max(0, correct - incorrect * 0.5);
        batchUpdates.push(
          (async () => {
            const { error } = await supabase
              .from("submissions")
              .update({
                score,
                correct,
                incorrect,
                is_pending_evaluation: false
              })
              .eq("id", row.id);
            if (error) throw error;
          })()
        );
      } else if (!publish) {
        batchUpdates.push(
          (async () => {
            const { error } = await supabase
              .from("submissions")
              .update({ is_pending_evaluation: true })
              .eq("id", row.id);
            if (error) throw error;
          })()
        );
      }
    });

    await Promise.all(batchUpdates);
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Toggle exam result publish error:", err);
    return false;
  }
}

export async function deleteTopicQuestion(topicQuestionId: string): Promise<boolean> {
  try {
    await requireTeacher();
    const { error } = await supabase.from("topic_questions").delete().eq("id", topicQuestionId);
    if (error) throw error;

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Delete topic question error:", err);
    return false;
  }
}

export async function clearAllSubmissions(): Promise<boolean> {
  try {
    await requireTeacher();
    const { error } = await supabase
      .from("submissions")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000"); // Deletes all

    if (error) throw error;
    return true;
  } catch (err) {
    console.error("Clear submissions error:", err);
    return false;
  }
}

export async function getAllSubmissions(): Promise<Submission[]> {
  try {
    await requireTeacher();
    const { data, error } = await supabase
      .from("submissions")
      .select("*")
      .order("submitted_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    const subs = (data || []).map((row) => ({
      id: row.id,
      studentName: row.student_name,
      studentId: row.student_id,
      examKey: row.exam_key,
      examTitle: row.exam_title,
      score: Number(row.score ?? 0),
      correct: Number(row.correct ?? 0),
      incorrect: Number(row.incorrect ?? 0),
      totalQuestions: Number(row.total_questions ?? 0),
      timeSpent: row.time_spent,
      answers: Array.isArray(row.answers)
        ? row.answers.map((v: any) => {
            if (typeof v === 'object' && v !== null && 'qid' in v) {
               return v;
            }
            return (v === -1 || v === null ? null : Number(v));
          })
        : [],
      isPendingEvaluation: row.is_pending_evaluation,
      isLiveSubmission: row.is_live_submission,
      submittedAtISO: row.submitted_at
    }));

    const solutionsCache = new Map();
    const evaluateJobs: Promise<any>[] = [];

    for (const s of subs) {
      if (s.isPendingEvaluation) {
        let solutionsPromise = solutionsCache.get(s.examKey);
        if (!solutionsPromise) {
          solutionsPromise = getExamSolutions(s.examKey);
          solutionsCache.set(s.examKey, solutionsPromise);
        }
        const solutions = await solutionsPromise;
        if (solutions && s.answers) {
          let cor = 0;
          let incor = 0;
          const isNewFormat = s.answers.length > 0 && typeof s.answers[0] === "object" && s.answers[0] !== null && "qid" in s.answers[0];
          if (isNewFormat) {
             const answerMap = new Map();
             s.answers.forEach((a: any) => { if (a && typeof a === 'object' && 'qid' in a) answerMap.set(a.qid, Number(a.ans)); });
             solutions.forEach((sol: any) => {
               const ans = sol.id != null && answerMap.has(sol.id) ? answerMap.get(sol.id) : -1;
               if (ans !== undefined && ans !== -1 && sol) {
                  if (ans === sol.correct) cor++;
                  else incor++;
               }
             });
          } else {
             s.answers.forEach((ans: any, idx: number) => {
               const sol = solutions[idx];
               if (ans !== null && sol) {
                 if (Number(ans) === sol.correct) cor++;
                 else incor++;
               }
             });
          }
          const newScore = Math.max(0, cor - incor * 0.5);
          s.correct = cor;
          s.incorrect = incor;
          s.score = newScore;
          s.isPendingEvaluation = false;
          evaluateJobs.push(
            (async () => {
              const { error } = await supabase.from("submissions").update({
                score: newScore,
                correct: cor,
                incorrect: incor,
                is_pending_evaluation: false
              }).eq("id", s.id);
              if (error) throw error;
            })()
          );
        }
      }
    }
    if (evaluateJobs.length > 0) {
      await Promise.all(evaluateJobs);
    }

    return subs;
  } catch (err) {
    console.error("Fetch all submissions error:", err);
    return [];
  }
}

export async function addBulkQuestionsToExam(
  examKey: string,
  newQuestions: QuestionItem[],
  newSolutions: QuestionSolution[]
): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    await requireTeacher();
    if (!newQuestions.length) return { success: false, count: 0 };

    const { data: examData, error: examError } = await supabase
      .from("exams")
      .select("title, course, subject")
      .eq("id", examKey)
      .single();

    if (examError) throw examError;

    // Deduplicate: (a) within this batch, (b) against questions already in the exam
    const existingSet = new Set<string>();
    const { data: existingLinks } = await supabase
      .from("exam_questions_link")
      .select("question_bank(q)")
      .eq("exam_id", examKey);
    (existingLinks || []).forEach((l: any) => {
      const qb = Array.isArray(l.question_bank) ? l.question_bank[0] : l.question_bank;
      if (qb?.q) existingSet.add(String(qb.q).trim().toLowerCase());
    });

    const seen = new Set<string>();
    const filteredQuestions: QuestionItem[] = [];
    const filteredSolutions: QuestionSolution[] = [];
    newQuestions.forEach((qItem, idx) => {
      const key = String(qItem.q || "").trim().toLowerCase();
      if (!key) return;
      if (seen.has(key) || existingSet.has(key)) return;
      seen.add(key);
      filteredQuestions.push(qItem);
      filteredSolutions.push(newSolutions[idx] || { correct: 0, exp: "" });
    });

    if (filteredQuestions.length === 0) return { success: true, count: 0 };

    const questionsInsert = filteredQuestions.map((qItem, idx) => {
      const sol = filteredSolutions[idx];
      const rawTopic = qItem.topic?.trim() || "সাধারণ";
      const fullTopic = qItem.subtopic ? `${rawTopic} > ${qItem.subtopic.trim()}` : rawTopic;
      return {
        q: qItem.q.trim(),
        opts: qItem.opts.map((o) => o.trim()),
        topic: fullTopic,
        correct: Number(sol.correct),
        exp: (sol.exp || "").trim(),
        course: examData.course,
        subject: examData.subject
      };
    });

    const { data: createdQs, error: insertError } = await supabase
      .from("question_bank")
      .insert(questionsInsert)
      .select("id");

    if (insertError) throw insertError;

    const { data: currentLinks } = await supabase
      .from("exam_questions_link")
      .select("order_index")
      .eq("exam_id", examKey);

    const maxIndex = (currentLinks || []).reduce((max, link) => Math.max(max, Number(link.order_index)), -1);
    const nextIndex = maxIndex + 1;

    const linksInsert = (createdQs || []).map((q, idx) => ({
      exam_id: examKey,
      question_id: q.id,
      order_index: nextIndex + idx
    }));

    const { error: linkError } = await supabase.from("exam_questions_link").insert(linksInsert);
    if (linkError) throw linkError;

    const topicQuestionsInsert = filteredQuestions
      .map((qItem, idx) => {
        const sol = filteredSolutions[idx];
        const rawTopic = qItem.topic?.trim() || "সাধারণ";
        const fullTopic = qItem.subtopic ? `${rawTopic} > ${qItem.subtopic.trim()}` : rawTopic;
        return {
          id: `tq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${idx}`,
          topic: fullTopic,
          q: qItem.q.trim(),
          opts: qItem.opts.map((o) => o.trim()),
          correct: Number(sol.correct),
          exp: (sol.exp || "").trim(),
          original_exam_title: examData.title,
          original_course: examData.course,
          original_subject: examData.subject,
          exam_key: examKey
        };
      });

    if (topicQuestionsInsert.length > 0) {
      const { error: tqError } = await supabase.from("topic_questions").insert(topicQuestionsInsert);
      if (tqError) throw tqError;
    }

    invalidateConfigCache();
    return { success: true, count: filteredQuestions.length };
  } catch (err) {
    console.error("Add bulk questions error:", err);
    return { success: false, count: 0, error: describeError(err) };
  }
}

export async function addBulkTopicQuestions(
  topic: string,
  newQuestions: QuestionItem[],
  newSolutions: QuestionSolution[]
): Promise<{ success: boolean; count: number }> {
  try {
    await requireTeacher();
    if (!newQuestions.length) return { success: false, count: 0 };

    const resolvedTopic = (topic || "").trim() || "সাধারণ";

    const topicQuestionsInsert = newQuestions.map((qItem, idx) => {
      const sol = newSolutions[idx] || { correct: 0, exp: "" };
      const rawTopic = qItem.topic?.trim() || resolvedTopic;
      const fullTopic = qItem.subtopic ? `${rawTopic} > ${qItem.subtopic.trim()}` : rawTopic;
      return {
        id: `tq_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${idx}`,
        topic: fullTopic,
        q: qItem.q.trim(),
        opts: qItem.opts.map((o) => o.trim()),
        correct: Number(sol.correct),
        exp: (sol.exp || "").trim(),
        original_exam_title: "সরাসরি টপিকে যুক্ত",
        original_course: "সাধারণ কোর্স",
        original_subject: "সাধারণ জ্ঞান",
        exam_key: null
      };
    });

    const { error: tqError } = await supabase.from("topic_questions").insert(topicQuestionsInsert);
    if (tqError) throw tqError;

    const questionsInsert = newQuestions.map((qItem, idx) => {
      const sol = newSolutions[idx] || { correct: 0, exp: "" };
      const rawTopic = qItem.topic?.trim() || resolvedTopic;
      const fullTopic = qItem.subtopic ? `${rawTopic} > ${qItem.subtopic.trim()}` : rawTopic;
      return {
        q: qItem.q.trim(),
        opts: qItem.opts.map((o) => o.trim()),
        topic: fullTopic,
        correct: Number(sol.correct),
        exp: (sol.exp || "").trim(),
        course: "সাধারণ কোর্স",
        subject: "সাধারণ জ্ঞান"
      };
    });
    
    await supabase.from("question_bank").insert(questionsInsert);

    invalidateConfigCache();
    return { success: true, count: newQuestions.length };
  } catch (err) {
    console.error("Add bulk topic questions error:", err);
    return { success: false, count: 0 };
  }
}

export async function addQuestionToBank(
  question: Omit<QuestionItem, "id">,
  solution: QuestionSolution
): Promise<boolean> {
  try {
    await requireTeacher();
    const rawTopic = question.topic?.trim() || null;
    const fullTopic = rawTopic && question.subtopic ? `${rawTopic} > ${question.subtopic.trim()}` : rawTopic;

    const { error } = await supabase.from("question_bank").insert({
      q: question.q.trim(),
      opts: question.opts.map((o) => o.trim()),
      topic: fullTopic,
      correct: Number(solution.correct),
      exp: solution.exp.trim()
    });
    if (error) throw error;
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Add question to bank error:", err);
    return false;
  }
}

export async function updateQuestionInBank(
  id: string,
  question: QuestionItem,
  solution: QuestionSolution
): Promise<boolean> {
  try {
    await requireTeacher();
    const rawTopic = question.topic?.trim() || null;
    const fullTopic = rawTopic && question.subtopic ? `${rawTopic} > ${question.subtopic.trim()}` : rawTopic;

    const { error } = await supabase.from("question_bank").update({
      q: question.q.trim(),
      opts: question.opts.map((o) => o.trim()),
      topic: fullTopic,
      correct: Number(solution.correct),
      exp: solution.exp.trim()
    }).eq("id", id);
    if (error) throw error;
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Update question in bank error:", err);
    return false;
  }
}

export async function deleteQuestionFromBank(id: string): Promise<boolean> {
  try {
    await requireTeacher();
    const { data: qData } = await supabase
      .from("question_bank")
      .select("*")
      .eq("id", id)
      .single();

    if (qData) {
      await addQuestionsToArchive([
        {
          id: qData.id,
          q: qData.q,
          opts: qData.opts || [],
          correct: Number(qData.correct ?? 0),
          exp: qData.exp || "",
          topic: qData.topic || "",
          sourceType: "bank",
          deletedAt: new Date().toISOString()
        }
      ]);
    }

    const { error } = await supabase.from("question_bank").delete().eq("id", id);
    if (error) throw error;
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Delete question from bank error:", err);
    return false;
  }
}

export async function bulkDeleteQuestionsFromBank(ids: string[]): Promise<boolean> {
  try {
    await requireTeacher();
    if (!ids || ids.length === 0) return true;

    const { data: questions } = await supabase
      .from("question_bank")
      .select("*")
      .in("id", ids);

    if (questions && questions.length > 0) {
      const toArchive: ArchivedQuestion[] = questions.map((qData) => ({
        id: qData.id,
        q: qData.q,
        opts: qData.opts || [],
        correct: Number(qData.correct ?? 0),
        exp: qData.exp || "",
        topic: qData.topic || "",
        sourceType: "bank" as const,
        deletedAt: new Date().toISOString()
      }));

      await addQuestionsToArchive(toArchive);
    }

    const { error } = await supabase.from("question_bank").delete().in("id", ids);
    if (error) throw error;
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Bulk delete questions from bank error:", err);
    return false;
  }
}

export async function bulkMoveQuestionsToTopic(
  questionIds: string[],
  newTopic: string,
  newSubtopic?: string
): Promise<boolean> {
  try {
    await requireTeacher();
    if (!questionIds.length) return true;
    const targetTopic = newSubtopic?.trim()
      ? `${newTopic.trim()} > ${newSubtopic.trim()}`
      : newTopic.trim();

    const { error } = await supabase
      .from("question_bank")
      .update({ topic: targetTopic })
      .in("id", questionIds);

    if (error) throw error;
    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Bulk move questions error:", err);
    return false;
  }
}

export async function addBulkQuestionsToBank(
  newQuestions: QuestionItem[],
  newSolutions: QuestionSolution[],
  fallbackTopic?: string,
  fallbackSubtopic?: string
): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    await requireTeacher();
    if (!newQuestions.length) return { success: false, count: 0 };
    const questionsInsert = newQuestions.map((qItem, idx) => {
      const sol = newSolutions[idx] || { correct: 0, exp: "" };
      const rawTopic = (qItem.topic || fallbackTopic || "").trim();
      const rawSubtopic = (qItem.subtopic || fallbackSubtopic || "").trim();
      const fullTopic = rawTopic && rawSubtopic ? `${rawTopic} > ${rawSubtopic}` : (rawTopic || null);

      return {
        q: qItem.q.trim(),
        opts: qItem.opts.map((o) => o.trim()),
        topic: fullTopic,
        correct: Number(sol.correct),
        exp: (sol.exp || "").trim(),
        course: "সাধারণ কোর্স",
        subject: "সাধারণ জ্ঞান"
      };
    });
    const { error } = await supabase.from("question_bank").insert(questionsInsert);
    if (error) throw error;
    invalidateConfigCache();
    return { success: true, count: newQuestions.length };
  } catch (err) {
    console.error("Add bulk questions to bank error:", err);
    return { success: false, count: 0, error: describeError(err) };
  }
}

// ─── Teacher session verification (server-side) ────────────────────────────
export async function verifyTeacherSession(accessToken?: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const teacher = await getTeacherUser(accessToken);
    if (!teacher) {
      return { ok: false, error: "Unauthorized: teacher access required" };
    }
    return { ok: true, email: teacher.email };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Session verification failed" };
  }
}

// ─── Targeted exam fetch (exam page / result page — no full config needed) ───
export async function fetchExamWithQuestions(examKey: string): Promise<Exam | null> {
  const timeoutPromise = new Promise<null>((_, reject) =>
    setTimeout(() => reject(new Error("Exam fetch timeout")), 4000)
  );
  const work = (async () => {
    // SECURITY: question content (q + options) of any exam — including paid and
    // upcoming live papers — must not be readable by anonymous callers. Require
    // a verified session, and for paid exams a verified enrollment in the
    // exam's course. (correct/exp keys are never part of this payload.)
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const sessionUser = await getSessionUserFromCookies();
    if (!sessionUser) return null;

    const { data: ex, error } = await supabase
      .from("exams")
      .select("*")
      .eq("id", examKey)
      .maybeSingle();
    if (error || !ex) return null;

    if (ex.is_free !== true) {
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const access = await verifyStudentAccess(sessionUser.id, ex.course || "", sessionUser.email);
      if (!access.allowed) return null;
    }

    // SECURITY: the exam hall must not hand out the paper before the exam opens.
    // That stop used to live only in the client (`exam/[examId]/page.tsx` checked
    // the start time *after* this action had already resolved), so simply opening
    // /exam/<upcomingExamId> -- or replaying this action id -- returned the whole
    // paper with its options before the window began. Teachers keep access so
    // they can preview their own papers.
    if (ex.start_time) {
      const { parseBangladeshDateTime, getTrueDate } = await import("@/lib/bangladesh-time");
      const examStart = parseBangladeshDateTime(ex.start_time);
      if (examStart && getTrueDate().getTime() < examStart.getTime()) {
        const { isTeacherSession } = await import("@/lib/teacher-auth");
        if (!(await isTeacherSession())) return null;
      }
    }

    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("order_index, question_bank(id, q, opts, topic)")
      .eq("exam_id", examKey);

    const sortedQs = (links || [])
      .sort((a: any, b: any) => Number(a.order_index) - Number(b.order_index))
      .map((l: any) => ({
        id: l.question_bank?.id,
        q: l.question_bank?.q || "",
        opts: l.question_bank?.opts || [],
        topic: l.question_bank?.topic || undefined
      }));

    return {
      id: ex.id,
      course: ex.course,
      subject: ex.subject,
      title: ex.title,
      timerMinutes: ex.timer_minutes,
      isFree: ex.is_free,
      passMark: Number(ex.pass_mark),
      startTime: ex.start_time,
      endTime: ex.end_time,
      isResultPublished: ex.is_result_published,
      leaderboardStartTime: ex.leaderboard_start_time,
      leaderboardEndTime: ex.leaderboard_end_time,
      questions: sortedQs
    };
  })();
  try {
    return await Promise.race([
      work,
      timeoutPromise.then(() => { throw new Error("Exam fetch timeout"); })
    ]);
  } catch (err) {
    console.error("Fetch exam with questions error:", err);
    return null;
  }
}

// ─── Teacher demo: exam attempt যেন সেভ না হয় — শুধু শিক্ষকের টেস্ট-অ্যাটেম্পট ───
// (প্রিভিউ/ডেমোর জন্য প্রশ্নের সঠিক-উত্তরও ফেরত আসে; শুধু requireTeacher-গেটেড)
export async function fetchExamForDemo(examKey: string): Promise<Exam | null> {
  try {
    await requireTeacher();

    const { data: ex, error } = await supabase
      .from("exams")
      .select("*")
      .eq("id", examKey)
      .maybeSingle();
    if (error || !ex) return null;

    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("order_index, question_bank(id, q, opts, correct, exp, topic)")
      .eq("exam_id", examKey);

    const sortedQs = (links || [])
      .sort((a: any, b: any) => Number(a.order_index) - Number(b.order_index))
      .map((l: any) => ({
        id: l.question_bank?.id,
        q: l.question_bank?.q || "",
        opts: l.question_bank?.opts || [],
        correct: Number(l.question_bank?.correct ?? 0),
        exp: l.question_bank?.exp || "",
        topic: l.question_bank?.topic || undefined
      }));

    return {
      id: ex.id,
      course: ex.course,
      subject: ex.subject,
      title: ex.title,
      timerMinutes: ex.timer_minutes,
      isFree: ex.is_free,
      passMark: Number(ex.pass_mark ?? 0),
      startTime: ex.start_time,
      endTime: ex.end_time,
      isResultPublished: ex.is_result_published,
      leaderboardStartTime: ex.leaderboard_start_time,
      leaderboardEndTime: ex.leaderboard_end_time,
      questions: sortedQs
    };
  } catch (err) {
    console.error("fetchExamForDemo error:", err);
    return null;
  }
}

// ─── Targeted lightweight fetches — শুধু যা দরকার, পুরো কনফিগ নয় ──────────────

function mapExamMetaRow(ex: any): Exam {
  return {
    id: ex.id,
    course: ex.course,
    subject: ex.subject,
    title: ex.title,
    timerMinutes: ex.timer_minutes,
    isFree: ex.is_free,
    passMark: Number(ex.pass_mark ?? 0),
    startTime: ex.start_time,
    endTime: ex.end_time,
    isResultPublished: ex.is_result_published,
    leaderboardStartTime: ex.leaderboard_start_time,
    leaderboardEndTime: ex.leaderboard_end_time,
    questions: []
  };
}

const EXAM_META_COLS = "id, course, subject, title, timer_minutes, is_free, pass_mark, start_time, end_time, is_result_published, leaderboard_start_time, leaderboard_end_time";

/** একটি মাত্র পরীক্ষার মেটা (প্রশ্ন ছাড়া) — টাইটেল/লিডারবোর্ড/স্ট্যাটাস দেখানোর জন্য। */
export async function fetchExamMeta(examKey: string): Promise<Exam | null> {
  try {
    const { data, error } = await supabase
      .from("exams")
      .select(EXAM_META_COLS)
      .eq("id", examKey)
      .maybeSingle();
    if (error || !data) return null;
    return mapExamMetaRow(data);
  } catch {
    return null;
  }
}

/** সব পরীক্ষার হালকা তালিকা (প্রশ্ন ছাড়া) — লিডারবোর্ড সার্চ/ড্রপডাউনের জন্য। */
export async function fetchExamMetaList(): Promise<Record<string, Exam>> {
  try {
    // শুরুর সময় অনুযায়ী (আগে → পরে) — ORDER BY ছাড়া Postgres যেকোনো ক্রমে সারি
    // দিতে পারে, তাই তালিকা এলোমেলো দেখাত।
    const { data, error } = await supabase
      .from("exams")
      .select(EXAM_META_COLS)
      .order("start_time", { ascending: true });
    if (error) return {};
    const map: Record<string, Exam> = {};
    (data || []).forEach((ex) => {
      map[ex.id] = mapExamMetaRow(ex);
    });
    return map;
  } catch {
    return {};
  }
}

/** কোর্সের নামের তালিকা (app_settings থেকে) — মেটাডেটা/যাচাইয়ের জন্য (পুরো কনফিগ নয়)। */
export async function fetchCourseNameList(): Promise<string[]> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("courses")
      .eq("id", "main")
      .maybeSingle();
    return Array.isArray(data?.courses) ? (data.courses as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * শুধু drive লিংক (routine/syllabus) — app_settings-এর এক সারি পড়া।
 * পোর্টালে exam-তালিকা আসে শিক্ষার্থীর নিজের exam-মেটা থেকে (getStudentExamMeta),
 * তাই এখানে কোনো exam প্রশ্ন/JOIN লাগে না।
 */
export async function fetchDriveLinks(): Promise<{ driveRoutineUrl: string; driveSyllabusUrl: string }> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("drive_routine_url, drive_syllabus_url")
      .eq("id", "main")
      .maybeSingle();
    return {
      driveRoutineUrl: data?.drive_routine_url || DEFAULT_DATA.driveRoutineUrl,
      driveSyllabusUrl: data?.drive_syllabus_url || DEFAULT_DATA.driveSyllabusUrl
    };
  } catch {
    return { driveRoutineUrl: "", driveSyllabusUrl: "" };
  }
}

/**
 * পোর্টাল/ফলাফল পেজের জন্য হালকা ডেটা — শুধু exam-মেটা + drive লিংক।
 * `fetchAppConfigLite` ভারী (exam_questions_link JOIN + topic_questions টানে);
 * পোর্টালে প্রশ্ন/Topic লাগে না, তাই এতে স্ক্যান অনেক কমে।
 */
export async function fetchPortalLite(): Promise<{
  exams: Record<string, Exam>;
  driveRoutineUrl: string;
  driveSyllabusUrl: string;
}> {
  try {
    const [exams, settingsRes] = await Promise.all([
      fetchExamMetaList(),
      supabase
        .from("app_settings")
        .select("drive_routine_url, drive_syllabus_url")
        .eq("id", "main")
        .maybeSingle()
    ]);
    return {
      exams,
      driveRoutineUrl: settingsRes?.data?.drive_routine_url || DEFAULT_DATA.driveRoutineUrl,
      driveSyllabusUrl: settingsRes?.data?.drive_syllabus_url || DEFAULT_DATA.driveSyllabusUrl
    };
  } catch {
    return { exams: {}, driveRoutineUrl: "", driveSyllabusUrl: "" };
  }
}

// ─── Topic hierarchy management ─────────────────────────────────────────────
const TOPIC_PATH_SEP = " > ";

/** Split any topic path into segments regardless of separator/spacing (">", "›", "/", "|"). */
const splitTopicPath = (t: string | null | undefined) =>
  String(t || "")
    .split(/\s*[>›/|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Normalize a topic path to the canonical "A > B" form. */
const normalizeTopicPath = (t: string | null | undefined) => splitTopicPath(t).join(TOPIC_PATH_SEP);

/**
 * একটা টেবিলের সব সারির `id, topic` আনা — **পৃষ্ঠা পৃষ্ঠা**।
 *
 * ⚠️ কেন `fetchAllRows` লাগে: PostgREST এক অনুরোধে সর্বোচ্চ ১০০০ সারি দেয়, আর
 * বাকিগুলো **নীরবে বাদ পড়ে** (কোনো এরর নেই, status 200)। টপিক-ডিলিট/রিনেম
 * আগে সরাসরি `.select("id, topic")` করত — তাই ১০০০-এর পরের প্রশ্নগুলো খুঁজে
 * না পেয়ে কিছুই সরাত না, অথচ "✅ ডিলিট সম্পন্ন" দেখাত। বাগটা লাইভ ডেটায়
 * ধরা পড়েছে: `topic_questions`-এ ১৪৩০ সারি, কিন্তু কোয়েরি ফেরাত মাত্র ১০০০।
 */
async function fetchTopicRows(table: "topic_questions" | "question_bank") {
  return fetchAllRows<{ id: string; topic: string | null }>(
    (from, to) =>
      supabase
        .from(table)
        .select("id, topic")
        .order("id", { ascending: true })
        .range(from, to),
    (err) => console.error(`টপিক-সারি আনা যায়নি (${table}):`, err)
  );
}

/**
 * অনেক প্রশ্নের টপিক একবারে বদলানো — ভাগে ভাগে, আর **এরর চেপে না রাখা**।
 * (আগে `.in("id", ids)`-এর এরর নীরবে উপেক্ষা করা হতো, তাই ব্যর্থ হলেও
 * সফল বলে দেখানো হতো।)
 */
async function updateTopicByIds(
  table: "topic_questions" | "question_bank",
  ids: string[],
  topic: string
): Promise<{ moved: number; error?: string }> {
  const CHUNK = 150; // খুব লম্বা `.in(...)` URL-সীমায় আটকে যেতে পারে
  let moved = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { error } = await supabase.from(table).update({ topic }).in("id", batch);
    if (error) return { moved, error: error.message };
    moved += batch.length;
  }
  return { moved };
}

/**
 * Delete a topic (or subtopic) node. The questions under it (and its
 * descendants) are NOT deleted — they move to the "সাধারণ" (General) topic,
 * from where they can be re-allocated later.
 */
export async function deleteTopicNode(
  topicPath: string
): Promise<{ success: boolean; moved?: number; message?: string }> {
  try {
    await requireTeacher();
    const path = normalizeTopicPath(topicPath);
    if (!path) return { success: false, message: "টপিক পাথ খালি।" };
    if (path === "সাধারণ") return { success: false, message: "সাধারণ টপিক ডিলিট করা যাবে না।" };

    // Separator-agnostic match (handles "A>B", "A › B", "A > B" etc.)
    const isMatch = (t: string) => {
      const norm = normalizeTopicPath(t);
      return norm === path || norm.startsWith(path + TOPIC_PATH_SEP);
    };

    // 1. Move matching topic_questions to "সাধারণ" (পৃষ্ঠা পৃষ্ঠা, নইলে ১০০০-এর
    //    পরের প্রশ্নগুলো নীরবে বাদ পড়ে — এটাই ছিল "ডিলিট হয় না" বাগের কারণ)
    const tqRows = await fetchTopicRows("topic_questions");
    const tqIds = tqRows.filter((r) => isMatch(String(r.topic ?? ""))).map((r) => r.id);
    if (tqIds.length > 0) {
      const res = await updateTopicByIds("topic_questions", tqIds, "সাধারণ");
      if (res.error) return { success: false, message: `প্রশ্নগুলো সরানো যায়নি: ${res.error}` };
    }

    // 2. Same for question_bank
    const qbRows = await fetchTopicRows("question_bank");
    const qbIds = qbRows.filter((r) => isMatch(String(r.topic ?? ""))).map((r) => r.id);
    if (qbIds.length > 0) {
      const res = await updateTopicByIds("question_bank", qbIds, "সাধারণ");
      if (res.error) return { success: false, message: `প্রশ্নগুলো সরানো যায়নি: ${res.error}` };
    }

    // 3. Remove the node (and descendants) from the registered topics list
    const { data: settings } = await supabase
      .from("app_settings")
      .select("topics")
      .eq("id", "main")
      .maybeSingle();
    const currentTopics: string[] = settings?.topics || [];
    const kept = currentTopics.filter((t) => {
      const norm = normalizeTopicPath(t);
      return norm !== path && !norm.startsWith(path + TOPIC_PATH_SEP);
    });
    if (kept.length !== currentTopics.length) {
      const { error: upErr } = await supabase.from("app_settings").upsert({ id: "main", topics: kept });
      if (upErr) return { success: false, message: `টপিক-তালিকা থেকে বাদ দেওয়া যায়নি: ${upErr.message}` };
    }

    invalidateConfigCache();
    return { success: true, moved: tqIds.length + qbIds.length };
  } catch (err) {
    console.error("Delete topic node error:", err);
    return { success: false, message: "টপিক ডিলিট করতে সমস্যা হয়েছে।" };
  }
}

/**
 * Rename a topic (or subtopic) node. Descendant questions keep their
 * relative depth: renaming "A > B" to "X > Y" moves "A > B > C" to "X > Y > C".
 */
export async function renameTopicNode(
  oldPath: string,
  newPath: string
): Promise<{ success: boolean; renamed?: number; message?: string }> {
  try {
    await requireTeacher();
    const oldP = normalizeTopicPath(oldPath);
    const newP = normalizeTopicPath(newPath);
    if (!oldP || !newP) return { success: false, message: "পুরনো ও নতুন টপিক পাথ প্রয়োজন।" };
    if (oldP === "সাধারণ") return { success: false, message: "সাধারণ টপিক রিনেম করা যাবে না।" };
    if (oldP === newP) return { success: true, renamed: 0 };

    const buildUpdates = (rows: { id: string; topic?: string | null }[]) => {
      const grouped: { topic: string; ids: string[] }[] = [];
      const index = new Map<string, number>();
      rows.forEach((r) => {
        const t = normalizeTopicPath(r.topic);
        let next: string | null = null;
        if (t === oldP) next = newP;
        else if (t.startsWith(oldP + TOPIC_PATH_SEP)) next = newP + t.slice(oldP.length);
        if (next) {
          let idx = index.get(next);
          if (idx === undefined) {
            idx = grouped.length;
            index.set(next, idx);
            grouped.push({ topic: next, ids: [] });
          }
          grouped[idx].ids.push(r.id);
        }
      });
      return grouped;
    };

    let renamed = 0;

    // পৃষ্ঠা পৃষ্ঠা আনা হয় — ১০০০-সারির সীমায় পড়ে টপিক হারানো যাবে না
    const tqRows = await fetchTopicRows("topic_questions");
    for (const g of buildUpdates(tqRows)) {
      const res = await updateTopicByIds("topic_questions", g.ids, g.topic);
      if (res.error) return { success: false, message: `রিনেম করা যায়নি: ${res.error}` };
      renamed += g.ids.length;
    }

    const qbRows = await fetchTopicRows("question_bank");
    for (const g of buildUpdates(qbRows)) {
      const res = await updateTopicByIds("question_bank", g.ids, g.topic);
      if (res.error) return { success: false, message: `রিনেম করা যায়নি: ${res.error}` };
      renamed += g.ids.length;
    }

    // Update the registered topics list too
    const { data: settings } = await supabase
      .from("app_settings")
      .select("topics")
      .eq("id", "main")
      .maybeSingle();
    const currentTopics: string[] = settings?.topics || [];
    const updated = currentTopics.map((t) => {
      const norm = normalizeTopicPath(t);
      if (norm === oldP) return newP;
      if (norm.startsWith(oldP + TOPIC_PATH_SEP)) return newP + norm.slice(oldP.length);
      return t;
    });
    if (JSON.stringify(updated) !== JSON.stringify(currentTopics)) {
      const { error: upErr } = await supabase.from("app_settings").upsert({ id: "main", topics: updated });
      if (upErr) return { success: false, message: `টপিক-তালিকা হালনাগাদ করা যায়নি: ${upErr.message}` };
    }

    invalidateConfigCache();
    return { success: true, renamed };
  } catch (err) {
    console.error("Rename topic node error:", err);
    return { success: false, message: "টপিক রিনেম করতে সমস্যা হয়েছে।" };
  }
}

/**
 * Unique topic paths from EVERY source (registered topics + topic_questions +
 * question_bank), so the admin tree shows the complete structure no matter
 * where questions were added from.
 */
export async function getTopicTreeData(): Promise<{ topics: string[] }> {
  try {
    await requireTeacher();

    const now = Date.now();
    if (cachedTopicPaths && now - cachedTopicPaths.at < TOPIC_PATHS_TTL_MS) {
      return { topics: cachedTopicPaths.data };
    }

    const set = new Set<string>();

    // ১. রেজিস্টার্ড টপিক-তালিকা (app_settings) — সবসময় পাওয়া যায়
    const { data: settings } = await supabase
      .from("app_settings")
      .select("topics")
      .eq("id", "main")
      .maybeSingle();
    (settings?.topics || []).forEach((t: string) => {
      const tt = normalizeTopicPath(t);
      if (tt) set.add(tt);
    });

    // ২. প্রশ্ন থেকে টপিক-পাথ — শুধু `topic` কলাম (পুরো সারি নয়), পৃষ্ঠা পৃষ্ঠা,
    //    যাতে PostgREST-এর ১০০০-সারির সীমায় কোনো টপিক নীরবে বাদ না পড়ে।
    //    (আগে এই ফাংশন প্রতি সারি এনে JS-এ আলাদা করত — তখন সীমার পরের টপিক হারাত।)
    const [tqRows, qbRows] = await Promise.all([
      fetchAllRows<{ topic: string | null }>((from, to) =>
        supabase.from("topic_questions").select("topic").order("id", { ascending: true }).range(from, to)
      ),
      fetchAllRows<{ topic: string | null }>((from, to) =>
        supabase.from("question_bank").select("topic").order("id", { ascending: true }).range(from, to)
      )
    ]);
    [...tqRows, ...qbRows].forEach((r) => {
      const tt = normalizeTopicPath(String(r?.topic ?? ""));
      if (tt) set.add(tt);
    });

    const topics = Array.from(set).sort((a, b) => a.localeCompare(b, "bn"));
    cachedTopicPaths = { at: Date.now(), data: topics };
    return { topics };
  } catch (err) {
    console.error("Get topic tree data error:", err);
    return { topics: [] };
  }
}
