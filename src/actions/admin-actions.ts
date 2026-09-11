"use server";

import { revalidatePath } from "next/cache";
import { supabase } from "@/lib/supabase";
import { requireTeacher, getTeacherUser } from "@/lib/teacher-auth";
import { AppConfigData, Exam, QuestionItem, QuestionSolution, TopicQuestion, ArchivedQuestion } from "@/types/exam";
import { getExamSolutions } from "@/actions/exam-actions";
import { Submission } from "@/types/submission";

let cachedConfig: AppConfigData | null = null;
let lastFetchTime = 0;
let inflightFetch: Promise<AppConfigData> | null = null;
const CACHE_TTL_MS = 60000; // 60 seconds cache (questions change only via admin edits, which invalidate the cache)

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
        supabase.from("exams").select("*"),
        supabase.from("exam_questions_link").select("exam_id, order_index, question_bank(id, q, opts, topic)"),
        supabase.from("topic_questions").select("*").order("created_at", { ascending: true })
      ]);

      const results = await Promise.race([
        fetchPromise,
        timeoutPromise.then(() => { throw new Error("Timeout"); })
      ]);

      if (results) {
        const [settingsRes, subjectsRes, examsRes, linksRes, topicQuestionsRes] = results;

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
        supabase.from("exams").select("*"),
        supabase.from("exam_questions_link").select("exam_id, question_bank(topic)"),
        supabase.from("topic_questions").select("topic, original_subject"),
      ]);
      const timeoutPromiseLite = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Lite fetch timeout")), 4000)
      );
      // Fail fast instead of hanging the page when Supabase is slow/unreachable
      const [settingsRes, subjectsRes, examsRes, linksRes, topicsRes] = await Promise.race([
        fetchPromiseLite,
        timeoutPromiseLite.then(() => { throw new Error("Lite fetch timeout"); })
      ]);

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
): Promise<boolean> {
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
      if (exists) return true; // already added — skip silently
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

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Add question error:", err);
    return false;
  }
}

export async function linkQuestionToExam(examKey: string, questionId: string): Promise<boolean> {
  try {
    await requireTeacher();
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

    if (linkError) throw linkError;

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Link question error:", err);
    return false;
  }
}

export async function searchQuestionBank(
  queryText: string,
  topic?: string,
  subject?: string,
  sortRecent: boolean = false
): Promise<{ questions: any[]; total: number }> {
  try {
    await requireTeacher();
    const build = (withOrder: boolean) => {
      let builder = supabase.from("question_bank").select("*", { count: "exact" });
      if (queryText) {
        builder = builder.ilike("q", `%${queryText}%`);
      }
      if (topic && topic !== "ALL") {
        // "সাধারণ" is the fallback topic — also match questions with no topic assigned
        builder = topic === "সাধারণ"
          ? builder.or(`topic.eq.${topic},topic.is.null`)
          : builder.eq("topic", topic);
      }
      if (subject && subject !== "ALL") {
        builder = builder.eq("subject", subject);
      }
      if (withOrder) {
        builder = builder.order("created_at", { ascending: false });
      }
      return builder.limit(100);
    };
    try {
      const { data, error, count } = await build(sortRecent);
      if (error) throw error;
      return { questions: data || [], total: count || 0 };
    } catch (err) {
      // created_at কলাম না থাকলে (পুরনো DB) — সর্ট ছাড়াই আবার চেষ্টা
      if (sortRecent) {
        const { data, error, count } = await build(false);
        if (!error) return { questions: data || [], total: count || 0 };
      }
      throw err;
    }
  } catch (err) {
    console.error("Search question bank error:", err);
    return { questions: [], total: 0 };
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

export async function permanentDeleteArchivedQuestions(ids: string[]): Promise<boolean> {
  try {
    await requireTeacher();
    const { data: settings } = await supabase
      .from("app_settings")
      .select("archived_questions")
      .eq("id", "main")
      .maybeSingle();

    const existingArchive: ArchivedQuestion[] = settings?.archived_questions || [];
    const idSet = new Set(ids);
    const updatedArchive = existingArchive.filter((q) => !idSet.has(q.id));

    await supabase
      .from("app_settings")
      .upsert({ id: "main", archived_questions: updatedArchive });

    // Also remove from question_bank permanently if still present
    await supabase.from("question_bank").delete().in("id", ids);

    invalidateConfigCache();
    return true;
  } catch (err) {
    console.error("Permanent delete archived questions error:", err);
    return false;
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

    return (data || []).map((row) => ({
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
        ? row.answers.map((v: any) => (v === -1 || v === null ? null : Number(v)))
        : [],
      isPendingEvaluation: row.is_pending_evaluation,
      isLiveSubmission: row.is_live_submission,
      submittedAtISO: row.submitted_at
    }));
  } catch (err) {
    console.error("Fetch all submissions error:", err);
    return [];
  }
}

export async function addBulkQuestionsToExam(
  examKey: string,
  newQuestions: QuestionItem[],
  newSolutions: QuestionSolution[]
): Promise<{ success: boolean; count: number }> {
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
    return { success: false, count: 0 };
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
): Promise<{ success: boolean; count: number }> {
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
    return { success: false, count: 0 };
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
    const { data, error } = await supabase.from("exams").select(EXAM_META_COLS);
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

    // 1. Move matching topic_questions to "সাধারণ"
    const { data: tqRows } = await supabase.from("topic_questions").select("id, topic");
    const tqIds: string[] = [];
    (tqRows || []).forEach((r: any) => {
      if (isMatch(r.topic)) tqIds.push(r.id);
    });
    if (tqIds.length > 0) {
      await supabase.from("topic_questions").update({ topic: "সাধারণ" }).in("id", tqIds);
    }

    // 2. Same for question_bank
    const { data: qbRows } = await supabase.from("question_bank").select("id, topic");
    const qbIds: string[] = [];
    (qbRows || []).forEach((r: any) => {
      if (isMatch(r.topic)) qbIds.push(r.id);
    });
    if (qbIds.length > 0) {
      await supabase.from("question_bank").update({ topic: "সাধারণ" }).in("id", qbIds);
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
      await supabase.from("app_settings").upsert({ id: "main", topics: kept });
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

    const { data: tqRows } = await supabase.from("topic_questions").select("id, topic");
    for (const g of buildUpdates(tqRows || [])) {
      await supabase.from("topic_questions").update({ topic: g.topic }).in("id", g.ids);
      renamed += g.ids.length;
    }

    const { data: qbRows } = await supabase.from("question_bank").select("id, topic");
    for (const g of buildUpdates(qbRows || [])) {
      await supabase.from("question_bank").update({ topic: g.topic }).in("id", g.ids);
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
      await supabase.from("app_settings").upsert({ id: "main", topics: updated });
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
    const set = new Set<string>();

    const { data: settings } = await supabase
      .from("app_settings")
      .select("topics")
      .eq("id", "main")
      .maybeSingle();
    (settings?.topics || []).forEach((t: string) => {
      const tt = normalizeTopicPath(t);
      if (tt) set.add(tt);
    });

    const { data: tq } = await supabase.from("topic_questions").select("topic");
    (tq || []).forEach((r: any) => {
      const tt = normalizeTopicPath(r.topic);
      if (tt) set.add(tt);
    });

    const { data: qb } = await supabase.from("question_bank").select("topic");
    (qb || []).forEach((r: any) => {
      const tt = normalizeTopicPath(r.topic);
      if (tt) set.add(tt);
    });

    return { topics: Array.from(set).sort((a, b) => a.localeCompare(b, "bn")) };
  } catch (err) {
    console.error("Get topic tree data error:", err);
    return { topics: [] };
  }
}
