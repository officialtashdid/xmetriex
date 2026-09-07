"use server";

import { supabase } from "@/lib/supabase";
import { AppConfigData } from "@/types/exam";
import { requireTeacher } from "@/lib/teacher-auth";

export interface AdminAnalyticsData {
  totalStudents: number;
  totalEnrollments: number;
  courseEnrollmentMap: Record<string, number>;
  totalSubmissions: number;
  examSubmissionMap: Record<string, { title: string; count: number; course: string }>;
  teacherQuestionStats: Record<string, { total: number; examQuestions: number; topicQuestions: number }>;
  totalQuestionBankCount: number;
  totalExamsCount: number;
}

export async function getAdminAnalytics(): Promise<AdminAnalyticsData> {
  try {
    // SECURITY: admin analytics are teacher-only
    await requireTeacher();

    // 1. Fetch Students
    const { data: studentsData } = await supabase.from("allowed_students").select("id, courses");
    const students = studentsData || [];
    const totalStudents = students.length;

    let totalEnrollments = 0;
    const courseEnrollmentMap: Record<string, number> = {};

    students.forEach((st) => {
      const courses = Array.isArray(st.courses) ? st.courses : [];
      totalEnrollments += courses.length;
      courses.forEach((c: string) => {
        const cName = (c || "").trim();
        if (cName) {
          courseEnrollmentMap[cName] = (courseEnrollmentMap[cName] || 0) + 1;
        }
      });
    });

    // 2. Fetch Submissions
    const { data: submissionsData } = await supabase.from("submissions").select("id, exam_key, exam_title");
    const submissions = submissionsData || [];
    const totalSubmissions = submissions.length;

    const examSubmissionMap: Record<string, { title: string; count: number; course: string }> = {};
    submissions.forEach((sub) => {
      const eKey = sub.exam_key || "unknown";
      if (!examSubmissionMap[eKey]) {
        examSubmissionMap[eKey] = {
          title: sub.exam_title || eKey,
          count: 0,
          course: "সাধারণ"
        };
      }
      examSubmissionMap[eKey].count += 1;
    });

    // Fetch exams to attach course names to submissions
    const { data: examsData } = await supabase.from("exams").select("id, title, course");
    const totalExamsCount = (examsData || []).length;
    (examsData || []).forEach((ex) => {
      if (examSubmissionMap[ex.id]) {
        examSubmissionMap[ex.id].title = ex.title || examSubmissionMap[ex.id].title;
        examSubmissionMap[ex.id].course = ex.course || "সাধারণ";
      }
    });

    // 3. Question stats (count-based so the 1000-row default never undercounts)
    const { count: questionBankCount } = await supabase
      .from("question_bank")
      .select("*", { count: "exact", head: true });
    const totalQuestionBankCount = questionBankCount || 0;

    const { count: topicQuestionsCount } = await supabase
      .from("topic_questions")
      .select("*", { count: "exact", head: true });
    const totalTopicQuestions = topicQuestionsCount || 0;

    // Question stats: total bank size, and how many are mirrored in the topic
    // pool. NOT a per-teacher breakdown — no creator column exists yet.
    const teacherQuestionStats: Record<string, { total: number; examQuestions: number; topicQuestions: number }> = {
      "সর্বমোট (Total)": {
        total: totalQuestionBankCount,
        examQuestions: Math.max(0, totalQuestionBankCount - totalTopicQuestions),
        topicQuestions: totalTopicQuestions
      }
    };

    return {
      totalStudents,
      totalEnrollments,
      courseEnrollmentMap,
      totalSubmissions,
      examSubmissionMap,
      teacherQuestionStats,
      totalQuestionBankCount,
      totalExamsCount
    };
  } catch (err) {
    console.error("Error generating admin analytics:", err);
    return {
      totalStudents: 0,
      totalEnrollments: 0,
      courseEnrollmentMap: {},
      totalSubmissions: 0,
      examSubmissionMap: {},
      teacherQuestionStats: {},
      totalQuestionBankCount: 0,
      totalExamsCount: 0
    };
  }
}

export interface LiveExamRow {
  examKey: string;
  title: string;
  course: string;
  subject: string;
  /** এ পর্যন্ত কতজন (distinct) শিক্ষার্থী এই পরীক্ষার লাইভ সংস্করণ দিয়েছে */
  liveCount: number;
}

/**
 * শিক্ষক প্যানেলের রিপোর্ট: কোন কোর্স → কোন সাবজেক্ট → কোন পরীক্ষায় এ পর্যন্ত
 * কতজন লাইভ পরীক্ষা দিয়েছে। শুধু লাইভ (is_live_submission) সাবমিশন গোনা হয়।
 */
export async function getLiveExamParticipation(): Promise<LiveExamRow[]> {
  try {
    // SECURITY: teacher-only
    await requireTeacher();

    // পরীক্ষার মেটাডেটা (কোর্স + সাবজেক্ট) exams টেবিল থেকে
    const { data: examsData, error: examsErr } = await supabase
      .from("exams")
      .select("id, title, course, subject");
    if (examsErr) throw examsErr;
    const meta = new Map<string, { title: string; course: string; subject: string }>();
    (examsData || []).forEach((ex) => {
      if (!ex.id) return;
      meta.set(ex.id, {
        title: ex.title || String(ex.id),
        course: ex.course || "সাধারণ",
        subject: ex.subject || "সাধারণ"
      });
    });

    // লাইভ সাবমিশন — প্রতি (exam_key, student_id) আলাদা করে ধরে student গুনি
    const { data: subs, error: subsErr } = await supabase
      .from("submissions")
      .select("exam_key, student_id")
      .eq("is_live_submission", true);
    if (subsErr) throw subsErr;

    const byExam = new Map<string, Set<string>>();
    (subs || []).forEach((s) => {
      const k = s.exam_key || "unknown";
      if (!byExam.has(k)) byExam.set(k, new Set<string>());
      if (s.student_id) byExam.get(k)!.add(String(s.student_id));
    });

    const rows: LiveExamRow[] = [];
    byExam.forEach((students, examKey) => {
      const m = meta.get(examKey) || { title: examKey, course: "সাধারণ", subject: "সাধারণ" };
      rows.push({
        examKey,
        title: m.title,
        course: m.course,
        subject: m.subject,
        liveCount: students.size
      });
    });

    // কোর্স → সাবজেক্ট → পরীক্ষার নাম ক্রমে
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort(
      (a, b) =>
        cmp(a.course, b.course) || cmp(a.subject, b.subject) || cmp(a.title, b.title)
    );
    return rows;
  } catch (err) {
    console.error("Error generating live exam participation report:", err);
    return [];
  }
}

export interface LiveParticipantNames {
  examKey: string;
  count: number;
  /** যে সব শিক্ষার্থী (শুধু নাম) এই পরীক্ষার লাইভ সংস্করণ দিয়েছে */
  names: string[];
}

/**
 * একটি নির্দিষ্ট পরীক্ষার লাইভ অংশগ্রহণকারী শিক্ষার্থীদের নাম (শুধু নাম) দেয়।
 */
export async function getLiveExamParticipants(examKey: string): Promise<LiveParticipantNames> {
  try {
    // SECURITY: teacher-only
    await requireTeacher();
    const { data, error } = await supabase
      .from("submissions")
      .select("student_id, student_name")
      .eq("exam_key", examKey)
      .eq("is_live_submission", true);
    if (error) throw error;

    // (exam, student) লাইভে একবারই, তবুও defensiveভাবে distinct
    const map = new Map<string, string>();
    (data || []).forEach((s) => {
      const id = s.student_id ? String(s.student_id) : "";
      const rawName = s.student_name ? String(s.student_name).trim() : "";
      const key = id || rawName || "";
      if (!key) return;
      if (!map.has(key)) map.set(key, rawName || id || key);
    });

    const names = Array.from(map.values()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { examKey, count: names.length, names };
  } catch (err) {
    console.error("Error fetching live exam participants:", err);
    return { examKey, count: 0, names: [] };
  }
}
