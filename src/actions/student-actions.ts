"use server";

import { supabase } from "@/lib/supabase";
import { AllowedStudent } from "@/types/student";
import { Submission } from "@/types/submission";
import { Exam, QuestionSolution } from "@/types/exam";
import { parseBengaliDigits } from "@/lib/utils";
import { getExamSolutions } from "@/actions/exam-actions";
import { getTrueDate } from "@/lib/bangladesh-time";
import { requireTeacher, sessionOwnsStudent } from "@/lib/teacher-auth";

export async function verifyStudentAccess(
  rawStudentId: string,
  examCourse: string,
  email?: string
): Promise<{ allowed: boolean; studentName?: string; normalizedId?: string; courses?: string[]; message?: string }> {
  const cleanId = String(rawStudentId).trim();
  const normalizedId = parseBengaliDigits(cleanId).trim();
  const cleanEmail = String(email || "").trim().toLowerCase();

  // Strip PostgREST filter metacharacters — never interpolate raw caller input
  // into a filter expression.
  const sanitize = (s: string) => String(s || "").replace(/[(),;*]/g, "");
  const safeId = sanitize(cleanId);
  const safeNormId = sanitize(normalizedId);
  const safeEmail = sanitize(cleanEmail);

  if (!cleanId) {
    return { allowed: false, message: "দয়া করে স্টুডেন্ট আইডি প্রদান করুন।" };
  }

  try {
    let matchedStudent: AllowedStudent | null = null;

    // 1. Direct match by raw ID, normalized ID or email (Google users are keyed by email too)
    //    ডুপ্লিকেট-সহনশীল: একাধিক রো মিললে maybeSingle() ব্যর্থ হয়ে "এনরোল নেই"
    //    দেখাত — তাই তালিকা এনে এমন রো বাছি যাতে অন্তত একটি কোর্স আছে (থাকলে)।
    const emailFilter = safeEmail ? `,email.eq.${safeEmail}` : "";
    const { data: directRows } = await supabase
      .from("allowed_students")
      .select("id, name, courses")
      .or(`id.eq.${safeId},id.eq.${safeNormId}${emailFilter}`)
      .limit(5);

    // সবচেয়ে ভালো (কোর্সসহ) সরাসরি-মিল ধরিয়ে রাখি; খালি-কোর্স রো হলে সেটাও
    // রাখি যাতে fallback-এ এনরোল্ড রেকর্ড না পেলে অন্তত সঠিক বার্তা দেখানো যায়।
    let directCandidate: AllowedStudent | null = null;
    if (directRows && directRows.length > 0) {
      const withCourses = directRows.find(
        (r: any) => Array.isArray(r.courses) && r.courses.length > 0
      );
      const pick = withCourses || directRows[0];
      directCandidate = { id: pick.id, name: pick.name, courses: pick.courses };
      if (withCourses) matchedStudent = directCandidate;
    }

    // 2. Collection search fallback for endsWith matching — deterministic:
    //    exact matches win; a suffix match is only accepted when unique.
    //    ALSO: সরাসরি-মিল খালি-কোর্স হলে (এনরোল করা শিক্ষার্থী অন্য আইডি/ইমেইলে
    //    থাকতে পারে) এখানেও এনরোল্ড রেকর্ড খুঁজি — নাহলে ভুলে "এনরোল নেই" দেখাত।
    if (!matchedStudent) {
      // PERF: শুধু দরকারি কলাম (পুরো রো নয়)
      const { data: allStudents } = await supabase
        .from("allowed_students")
        .select("id, name, courses, email");

      const suffixMatches: AllowedStudent[] = [];
      (allStudents || []).forEach((d) => {
        const docSid = String(d.id).trim();
        const docNormSid = parseBengaliDigits(docSid).trim();
        const docEmail = String(d.email || "").trim().toLowerCase();
        const emailMatches = safeEmail ? docEmail === safeEmail : false;

        if (
          docSid === safeId ||
          docNormSid === safeNormId ||
          emailMatches
        ) {
          // হুবহু মিল — তবে কোর্সসহ রেকর্ড থাকলে সেটাই আগে নিই (খালি-কোর্স
          // auto-registered রো যেন এনরোল্ড রেকর্ডকে ঢেকে না ফেলে)
          const asStudent = { id: d.id, name: d.name, courses: d.courses };
          if (Array.isArray(d.courses) && d.courses.length > 0) {
            matchedStudent = asStudent;
            return;
          }
          if (!matchedStudent) matchedStudent = asStudent;
          return;
        }

        if (
          (safeNormId.length >= 10 && docNormSid.endsWith(safeNormId.slice(-10))) ||
          (docNormSid.length >= 10 && safeNormId.endsWith(docNormSid.slice(-10)))
        ) {
          suffixMatches.push({
            id: d.id,
            name: d.name,
            courses: d.courses
          });
        }
      });

      if (!matchedStudent && suffixMatches.length === 1) {
        matchedStudent = suffixMatches[0];
      }
    }

    // কোনো এনরোল্ড রেকর্ড না মিললে সরাসরি-মিলিত (খালি-কোর্স) রো-ই ব্যবহার করি —
    // তখন "কোনো কোর্সে এনরোল করেননি" বার্তাটাই সঠিক হয়।
    if (!matchedStudent && directCandidate) {
      matchedStudent = directCandidate;
    }

    if (!matchedStudent) {
      return {
        allowed: false,
        message: "আপনার স্টুডেন্ট আইডিটি অনুমোদিত নয়। কোর্সে এনরোল করার পর শিক্ষকের অনুমোদন পেলে পরীক্ষা দিতে পারবেন।"
      };
    }

    const studentCourses = matchedStudent.courses || [];
    const normalizedCourses = (Array.isArray(studentCourses) ? studentCourses : [studentCourses])
      .map((c) => String(c || "").trim())
      .filter(Boolean);

    // If student has NO courses enrolled in database, they are strictly NOT allowed to access paid study hub or exams
    if (normalizedCourses.length === 0) {
      return {
        allowed: false,
        message: "আপনি কোনো কোর্সে এনরোল করেননি। অনুগ্রহ করে একটি কোর্সে এনরোল করে শিক্ষকের অনুমোদন নিন।"
      };
    }

    const targetCourse = (examCourse || "").trim();

    // If verifying general enrollment access ("ALL")
    if (!targetCourse || targetCourse === "ALL") {
      return {
        allowed: true,
        studentName: matchedStudent.name || "শিক্ষার্থী",
        normalizedId: matchedStudent.id || normalizedId || cleanId,
        courses: matchedStudent.courses || []
      };
    }

    const hasCourseAccess =
      targetCourse === "সাধারণ কোর্স" ||
      normalizedCourses.some((c) => {
        const sc = c.toLowerCase();
        return sc === "all" || sc === "সকল কোর্স" || sc === targetCourse.toLowerCase();
      });

    if (!hasCourseAccess) {
      return {
        allowed: false,
        message: `দুঃখিত! আপনার আইডিটি "${examCourse}" কোর্সের জন্য অনুমোদিত নয়।`
      };
    }

    return {
      allowed: true,
      studentName: matchedStudent.name || "শিক্ষার্থী",
      normalizedId: matchedStudent.id || normalizedId || cleanId,
        courses: matchedStudent.courses || []
    };
  } catch (err) {
    console.error("Student verification error:", err);
    return { allowed: false, message: "আইডি যাচাই করতে সমস্যা হয়েছে।" };
  }
}

export async function getStudentSubmissions(studentId: string): Promise<Submission[] | null> {
  const normId = parseBengaliDigits(studentId).trim();
  const cleanId = String(studentId).trim();

  // SECURITY: only the student themselves (verified via the Supabase session)
  // may read their submissions — closes the portal IDOR where any phone number
  // could be typed to view another student's records. Returns null when the
  // caller is not allowed (not logged in / not the owner), vs [] when the
  // caller is authorized but has no records.
  if (!(await sessionOwnsStudent(cleanId)) && !(await sessionOwnsStudent(normId))) {
    return null;
  }

  try {
    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);
    if (ids.length === 0) return [];

    // PERF: শুধু দরকারি কলাম + সর্বোচ্চ ২০০টি সাম্প্রতিক submission (পুরো টেবিল নয়)
    const { data, error } = await supabase
      .from("submissions")
      .select(
        "id, student_name, student_id, exam_key, exam_title, score, correct, incorrect, total_questions, time_spent, answers, is_pending_evaluation, is_live_submission, submitted_at"
      )
      .in("student_id", ids)
      .order("submitted_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    const subs: Submission[] = (data || []).map((row) => ({
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

    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");

    // PERF: সব exam `select("*")` না করে কেবল এই submission-গুলোর exam-গুলো,
    // আর শুধু দরকারি কলাম — পুরো exams টেবিল স্ক্যান বন্ধ।
    const examKeys = Array.from(new Set(subs.map((s) => s.examKey).filter(Boolean)));
    const examsMap: Record<string, any> = {};
    if (examKeys.length > 0) {
      const { data: examDataList } = await supabase
        .from("exams")
        .select(
          "id, course, subject, title, timer_minutes, is_free, pass_mark, start_time, end_time, is_result_published, leaderboard_start_time, leaderboard_end_time"
        )
        .in("id", examKeys);
      (examDataList || []).forEach((ex) => {
        examsMap[ex.id] = {
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
          leaderboardEndTime: ex.leaderboard_end_time
        };
      });
    }

    // PERF: pending মূল্যায়ন — per-exam solutions একবারই আনি (cache), আর সব
    // UPDATE একসাথে (Promise.all) চালাই — আগে ছিল ক্রমিক N×query + N×update।
    const solutionsCache = new Map<string, Promise<QuestionSolution[] | null>>();
    const evaluateJobs: Promise<unknown>[] = [];

    for (const s of subs) {
      const examObj = examsMap[s.examKey];
      const isReleased = examObj ? isAnswerTimeReached(examObj) : true;

      if (isReleased && (s.isPendingEvaluation || s.score === undefined)) {
        let solutionsPromise = solutionsCache.get(s.examKey);
        if (!solutionsPromise) {
          solutionsPromise = getExamSolutions(s.examKey);
          solutionsCache.set(s.examKey, solutionsPromise);
        }
        const solutions = await solutionsPromise;
        if (solutions && s.answers) {
          let cor = 0;
          let incor = 0;
          s.answers.forEach((ans, idx) => {
            const sol = solutions[idx];
            if (ans !== null && sol) {
              if (ans === sol.correct) cor++;
              else incor++;
            }
          });
          s.correct = cor;
          s.incorrect = incor;
          s.score = Math.max(0, cor - incor * 0.5);
          s.isPendingEvaluation = false;

          evaluateJobs.push(
            Promise.resolve(
              supabase
                .from("submissions")
                .update({
                  score: s.score,
                  correct: cor,
                  incorrect: incor,
                  is_pending_evaluation: false
                })
                .eq("id", s.id)
            )
          );
        }
      }
    }

    if (evaluateJobs.length > 0) {
      await Promise.allSettled(evaluateJobs);
    }

    return subs;
  } catch (err) {
    console.error("Fetch student submissions error:", err);
    return [];
  }
}

/**
 * পোর্টালের জন্য টার্গেটেড exam-মেটা — শুধু এই শিক্ষার্থীর যে পরীক্ষাগুলোতে
 * submission আছে সেগুলোর meta (কোনো প্রশ্ন/topicJOIN নয়)। পুরো exams টেবিল
 * টানার বদলে এতে ডেটা-ভলিউম অনেক কমে — পোর্টাল/ফলাফল দ্রুত খোলে।
 */
export async function getStudentExamMeta(rawStudentId: string): Promise<Record<string, Exam>> {
  const cleanId = String(rawStudentId || "").trim();
  const normId = parseBengaliDigits(cleanId).trim();
  if (!cleanId) return {};

  // SECURITY: নিজের রেকর্ড ছাড়া অন্য কারও exam-meta নয়
  if (!(await sessionOwnsStudent(cleanId)) && !(await sessionOwnsStudent(normId))) return {};

  try {
    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);
    const { data: subRows, error } = await supabase
      .from("submissions")
      .select("exam_key")
      .in("student_id", ids)
      .limit(500);
    if (error) throw error;

    const examKeys = Array.from(new Set((subRows || []).map((r) => r.exam_key).filter(Boolean)));
    if (examKeys.length === 0) return {};

    const { data, error: exErr } = await supabase
      .from("exams")
      .select(
        "id, course, subject, title, timer_minutes, is_free, pass_mark, start_time, end_time, is_result_published, leaderboard_start_time, leaderboard_end_time"
      )
      .in("id", examKeys);
    if (exErr) throw exErr;

    const map: Record<string, Exam> = {};
    (data || []).forEach((ex: any) => {
      map[ex.id] = {
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
        leaderboardEndTime: ex.leaderboard_end_time
      };
    });
    return map;
  } catch (err) {
    console.error("Get student exam meta error:", err);
    return {};
  }
}

export async function updateStudentName(uid: string, newName: string): Promise<boolean> {
  try {
    const cleanId = uid.trim();

    // SECURITY: only the logged-in student may rename their own record
    if (!(await sessionOwnsStudent(cleanId))) return false;

    const { error } = await supabase
      .from("allowed_students")
      .update({ name: newName })
      .eq("id", cleanId);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error("Update student name error:", err);
    return false;
  }
}

export async function syncStudentLogin(payload: {
  uid: string;
  name: string;
  email: string;
  photoURL?: string;
}): Promise<{ success: boolean }> {
  try {
    const cleanId = payload.uid.trim();
    if (!cleanId) return { success: false };

    // SECURITY: only the logged-in session user may sync their own profile
    if (!(await sessionOwnsStudent(cleanId))) return { success: false };

    const cleanEmail = payload.email.trim().toLowerCase();

    // গুরুত্বপূর্ণ: `.or(id,email).maybeSingle()` ব্যবহার করা যাবে না — একই
    // শিক্ষার্থীর একাধিক রো মিলে গেলে (যেমন ফোন-আইডি রো + Google uid রো) কুয়েরি
    // ambiguous হয়ে খালি ফেরে, আর তখন ভুল করে ডুপ্লিকেট রো তৈরি হয়ে
    // verifyStudentAccess-ও ambiguous হয়ে যায় (ফলে "এনরোল নেই" দেখায়)।
    // তাই id ও email আলাদা আলাদা দেখি; কোনোটা মিললেই নতুন রো তৈরি করি না।
    let existing: { id: string; name: string; email: string; courses: string[] } | null = null;

    const { data: byId } = await supabase
      .from("allowed_students")
      .select("id, name, email, courses")
      .eq("id", cleanId)
      .maybeSingle();
    if (byId) {
      existing = byId as { id: string; name: string; email: string; courses: string[] };
    } else if (cleanEmail) {
      const { data: byEmail } = await supabase
        .from("allowed_students")
        .select("id, name, email, courses")
        .eq("email", cleanEmail)
        .limit(1);
      if (byEmail && byEmail.length > 0) {
        existing = byEmail[0] as { id: string; name: string; email: string; courses: string[] };
      }
    }

    const now = getTrueDate().toISOString();

    // শিক্ষার্থী আগে থেকে নেই → Google-লগইনকারীকে "রেজিস্টার্ড" হিসেবে নতুন রেকর্ড
    // তৈরি করি (এনরোল ছাড়াই)। ফলে Admin-এর শিক্ষার্থী তালিকায় ওঠে এবং সেখান থেকে
    // পরবর্তীতে এক/একাধিক কোর্সে এনরোল করানো যায়। courses খালি রাখা হয় — যাতে
    // verifyStudentAccess (অন্তত একটি কোর্স চায়) তাকে এখনই কন্টেন্টে ঢুকতে না দেয়।
    if (!existing) {
      const { error: createErr } = await supabase.from("allowed_students").insert({
        id: cleanId,
        name: payload.name.trim() || "শিক্ষার্থী",
        email: payload.email.trim() || "",
        courses: [],
        approved_at: now,
        last_login_at: now,
        photo_url: payload.photoURL || ""
      });
      if (!createErr) return { success: true };
      // পুরনো schema-য় কিছু কলাম না থাকলে ছোট payload-এ চেষ্টা
      const { error: createErr2 } = await supabase.from("allowed_students").insert({
        id: cleanId,
        name: payload.name.trim() || "শিক্ষার্থী",
        email: payload.email.trim() || "",
        courses: []
      });
      if (!createErr2) return { success: true };
      // সত্যিকারের DB ত্রুটি হলে (RLS/constraint) নীরবে ব্যর্থ — লগইন আটকায় না
      console.error("Auto-register student error:", createErr2);
      return { success: false };
    }

    const existingCourses = existing?.courses || [];

    const { error } = await supabase.from("allowed_students").upsert({
      id: existing.id,
      name: payload.name.trim() || existing?.name || "শিক্ষার্থী",
      email: payload.email.trim() || existing?.email || "",
      courses: existingCourses,
      last_login_at: now,
      photo_url: payload.photoURL || ""
    });

    if (error) {
      // Fallback if photo_url or last_login_at columns are missing in older Supabase schema
      const { error: fallbackErr } = await supabase.from("allowed_students").upsert({
        id: existing.id,
        name: payload.name.trim() || existing?.name || "শিক্ষার্থী",
        email: payload.email.trim() || existing?.email || "",
        courses: existingCourses
      });
      if (fallbackErr) throw fallbackErr;
    }

    return { success: true };
  } catch (err) {
    console.error("Sync student login error:", err);
    return { success: false };
  }
}

export async function getAllAllowedStudents(): Promise<AllowedStudent[]> {
  try {
    // SECURITY: the full student roster (phone ids, names, emails) is teacher-only
    await requireTeacher();

    const { data, error } = await supabase
      .from("allowed_students")
      .select("*")
      .order("id", { ascending: true });

    if (error) throw error;

    return (data || []).map((row) => ({
      docId: row.id,
      id: row.id,
      name: row.name,
      email: row.email || "",
      courses: row.courses || [],
      lastLoginAt: row.last_login_at || row.approved_at || "",
      photoURL: row.photo_url || ""
    }));
  } catch (err) {
    console.error("Fetch all allowed students error:", err);
    return [];
  }
}

export async function batchEnrollStudents(
  studentIds: string[],
  courses: string[]
): Promise<{ success: boolean; message: string }> {
  try {
    // SECURITY: granting courses is a teacher-only operation
    await requireTeacher();

    if (!studentIds.length) {
      return { success: false, message: "কোনো শিক্ষার্থী নির্বাচন করা হয়নি।" };
    }

    const updatedCourses = courses.includes("ALL") ? ["ALL"] : Array.from(new Set(courses));

    for (const sid of studentIds) {
      await supabase
        .from("allowed_students")
        .update({ courses: updatedCourses })
        .eq("id", sid);
    }

    return { success: true, message: `${studentIds.length} জন শিক্ষার্থীর কোর্স সফলভাবে আপডেট করা হয়েছে।` };
  } catch (err) {
    console.error("Batch enroll error:", err);
    return { success: false, message: "কোর্স আপডেট করতে সমস্যা হয়েছে।" };
  }
}

export async function addAllowedStudentManual(
  id: string,
  name: string,
  course: string
): Promise<{ success: boolean; message: string }> {
  try {
    // SECURITY: adding approved students is a teacher-only operation
    await requireTeacher();

    const cleanId = parseBengaliDigits(id).trim();
    if (!cleanId || !name.trim()) {
      return { success: false, message: "আইডি এবং নাম প্রদান করা আবশ্যক।" };
    }

    const { data: existing } = await supabase
      .from("allowed_students")
      .select("courses")
      .eq("id", cleanId)
      .maybeSingle();

    const courses = existing ? Array.from(new Set([...(existing.courses || []), course])) : [course];

    const { error } = await supabase.from("allowed_students").upsert({
      id: cleanId,
      name: name.trim(),
      courses,
      approved_at: getTrueDate().toISOString()
    });

    if (error) throw error;
    return { success: true, message: "শিক্ষার্থী তালিকাভুক্ত হয়েছে।" };
  } catch (err) {
    console.error("Add student manual error:", err);
    return { success: false, message: "শিক্ষার্থী তালিকাভুক্ত করতে সমস্যা হয়েছে।" };
  }
}

export async function updateAllowedStudent(
  id: string,
  name: string,
  courses: string[]
): Promise<{ success: boolean; message: string }> {
  try {
    // SECURITY: modifying student records is a teacher-only operation
    await requireTeacher();

    const cleanId = id.trim();
    const { error } = await supabase
      .from("allowed_students")
      .update({
        name: name.trim(),
        courses: courses
      })
      .eq("id", cleanId);

    if (error) throw error;
    return { success: true, message: "শিক্ষার্থীর কোর্স ও তথ্য সফলভাবে আপডেট করা হয়েছে।" };
  } catch (err) {
    console.error("Update allowed student error:", err);
    return { success: false, message: "শিক্ষার্থীর তথ্য আপডেট করতে সমস্যা হয়েছে।" };
  }
}

export async function deleteAllowedStudent(id: string): Promise<boolean> {
  try {
    // SECURITY: deleting students is a teacher-only operation
    await requireTeacher();

    const { error } = await supabase.from("allowed_students").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("Delete allowed student error:", err);
    return false;
  }
}

/**
 * Secure Server Action: Fetch questions for a specific topic/chapter directly from DB.
 * Verifies student enrollment on the server before returning question content and solutions.
 */
export async function fetchTopicQuestionsForStudent(
  studentId: string,
  targetPath: string,
  email?: string
): Promise<{ success: boolean; questions: any[]; message?: string }> {
  const cleanId = String(studentId || "").trim();

  // 1. Verify enrollment on server (any course is enough)
  const access = await verifyStudentAccess(cleanId, "ALL", email);
  if (!access.allowed) {
    return {
      success: false,
      questions: [],
      message: "🔒 দুঃখিত! এই প্রশ্নগুলো পড়ার অনুমতি শুধুমাত্র অনুমোদিত ও এনরোল করা শিক্ষার্থীদের জন্য।"
    };
  }

  try {
    const cleanTarget = (targetPath || "").trim().toLowerCase();

    // SECURITY: only expose correct/exp for questions the student is allowed to
    // see — never for answer-locked scheduled exams (before release). যেকোনো
    // একটি কোর্সে এনরোল্ড থাকলেই সব কোর্সের প্রশ্ন পড়া যায় (কোর্স-স্কোপ নয়)।
    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    const { data: allExams } = await supabase
      .from("exams")
      .select("id, course, subject, start_time, end_time, leaderboard_end_time, is_result_published");

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
      if (isScheduled && !isAnswerTimeReached(examObj)) lockedExamIds.add(ex.id);
      accessibleExamIds.add(ex.id);
    });

    const { getTopicSegments } = await import("@/lib/topic-hierarchy");

    const isMatch = (rawTopic?: string, fallbackSubject?: string) => {
      if (!cleanTarget || cleanTarget === "all") return true;
      const segs = getTopicSegments(rawTopic, fallbackSubject);
      const full = segs.join(" > ").toLowerCase();
      return full === cleanTarget || full.startsWith(cleanTarget + " > ") || segs.some((s: string) => s.toLowerCase() === cleanTarget);
    };

    const pool: any[] = [];

    // Query 1: Fetch from topic_questions table in database
    const { data: dbTopicQs } = await supabase
      .from("topic_questions")
      .select("*")
      .order("created_at", { ascending: false });

    (dbTopicQs || []).forEach((tq, idx) => {
      if (tq.exam_key) {
        if (lockedExamIds.has(tq.exam_key)) return;
        if (!accessibleExamIds.has(tq.exam_key)) return;
      }
      if (isMatch(tq.topic, tq.original_subject) && tq.q && Array.isArray(tq.opts) && tq.opts.length >= 2) {
        pool.push({
          id: tq.id || `tq_${idx}`,
          q: tq.q,
          opts: tq.opts,
          correct: Number(tq.correct ?? 0),
          exp: tq.exp || "",
          subject: tq.original_subject || "পড়াশোনা",
          topic: tq.topic
        });
      }
    });

    // Query 2: Fetch from exams & question_bank links — released, accessible exams only
    const { data: dbLinks } = await supabase.from("exam_questions_link").select("exam_id, question_bank(*)");

    for (const link of (dbLinks || [])) {
      const rawQ = link.question_bank;
      const qData: any = Array.isArray(rawQ) ? rawQ[0] : rawQ;
      if (!qData || !qData.q) continue;

      const examId = link.exam_id;
      if (lockedExamIds.has(examId)) continue;
      if (!accessibleExamIds.has(examId)) continue;

      const ex = (allExams || []).find((e: any) => e.id === examId);
      const examSubject = ex?.subject || "পড়াশোনা";

      if (isMatch(qData.topic, examSubject)) {
        pool.push({
          id: qData.id,
          q: qData.q,
          opts: qData.opts,
          correct: Number(qData.correct ?? 0),
          exp: qData.exp || "",
          subject: examSubject,
          topic: qData.topic
        });
      }
    }

    // Deduplicate by question text
    const uniqueMap = new Map<string, any>();
    pool.forEach((item) => {
      const key = item.q.trim().toLowerCase();
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      }
    });

    const questionsArr = Array.from(uniqueMap.values());
    return {
      success: true,
      questions: questionsArr,
      message:
        questionsArr.length === 0
          ? "এই অংশে বর্তমানে দেখানোর মতো প্রশ্ন নেই — শুধু আপনার এনরোল্ড কোর্সের + প্রকাশিত (লাইভ-সমাপ্ত) প্রশ্নই দেখানো হয়। অন্য টপিক দেখুন; প্রয়োজনে শিক্ষককে জানান।"
          : undefined
    };
  } catch (err: any) {
    console.error("fetchTopicQuestionsForStudent error:", err);
    return {
      success: false,
      questions: [],
      message: "ডাটাবেস থেকে প্রশ্ন লোড করতে সমস্যা হয়েছে।"
    };
  }
}

/**
 * Exam keys the student has already submitted — used to mark exams as
 * "সম্পন্ন" (completed) in the student-facing exam lists.
 */
export async function getCompletedExamKeys(
  rawStudentId: string,
  email?: string
): Promise<string[]> {
  try {
    const cleanId = String(rawStudentId || '').trim();
    if (!cleanId) return [];

    // SECURITY: only the student themselves may query their completion list
    if (!(await sessionOwnsStudent(cleanId))) return [];

    const ids = new Set<string>([cleanId, parseBengaliDigits(cleanId).trim()]);

    // Normalize via enrollment lookup so Google users (uid) match their
    // allowed_students id (phone) under which submissions are stored
    const access = await verifyStudentAccess(cleanId, 'ALL', email);
    if (access.normalizedId) ids.add(access.normalizedId);

    const { data } = await supabase
      .from('submissions')
      .select('exam_key')
      .in('student_id', Array.from(ids).filter(Boolean));

    return Array.from(new Set((data || []).map((r) => r.exam_key).filter(Boolean)));
  } catch (err) {
    console.error('Get completed exam keys error:', err);
    return [];
  }
}

/**
 * শিক্ষক প্যানেল: একজন এনরোল্ড স্টুডেন্টের পূর্ণ পরীক্ষা-ইতিহাস ও ফলাফল
 * (কত পরীক্ষা দিয়েছে, কোনটায় কী পেয়েছে)। শুধু শিক্ষকই দেখতে পারেন
 * (requireTeacher) — শিক্ষার্থী বা অন্য কেউ নয়।
 * উত্তর প্রকাশ হয়ে গেলে পেন্ডিং সাবমিশনের স্কোর এখানে মূল্যায়নও হয়ে যায়,
 * ফলে টিচার ভিউতে সবসময় প্রকৃত নম্বর দেখা যায়।
 */
export async function getStudentExamHistoryForTeacher(rawStudentId: string): Promise<{
  student: AllowedStudent | null;
  submissions: Submission[];
  examsMeta: Record<string, { passMark: number; subject: string; course: string }>;
} | null> {
  try {
    await requireTeacher();
  } catch {
    return null; // শিক্ষক নন → কোনো ডেটা নয়
  }

  try {
    const cleanId = String(rawStudentId || "").trim();
    const normId = parseBengaliDigits(cleanId).trim();
    // PostgREST filter মেটা-ক্যারেক্টার স্যানিটাইজ (ফোন/ইমেইল/uid ছাড়া কিছু নেই)
    const sanitize = (s: string) => String(s || "").replace(/[(),;*]/g, "");
    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);
    if (ids.length === 0) return null;

    // শিক্ষার্থীর প্রোফাইল (allowed_students)
    const { data: studentRows } = await supabase
      .from("allowed_students")
      .select("*")
      .or(ids.map((i) => `id.eq.${sanitize(i)}`).join(","))
      .limit(1);
    const srow = studentRows?.[0];
    const student: AllowedStudent | null = srow
      ? {
          docId: srow.id,
          id: srow.id,
          name: srow.name || "শিক্ষার্থী",
          email: srow.email || "",
          courses: srow.courses || [],
          lastLoginAt: srow.last_login_at || srow.approved_at || "",
          photoURL: srow.photo_url || ""
        }
      : null;

    // সব সাবমিশন — সর্বশেষ আগে
    const { data, error } = await supabase
      .from("submissions")
      .select("*")
      .in("student_id", ids)
      .order("submitted_at", { ascending: false });
    if (error) throw error;

    const subs: Submission[] = (data || []).map((r) => ({
      id: r.id,
      studentName: r.student_name,
      studentId: r.student_id,
      examKey: r.exam_key,
      examTitle: r.exam_title,
      score: Number(r.score ?? 0),
      correct: Number(r.correct ?? 0),
      incorrect: Number(r.incorrect ?? 0),
      totalQuestions: Number(r.total_questions ?? 0),
      timeSpent: r.time_spent,
      answers: Array.isArray(r.answers)
        ? r.answers.map((v: any) => (v === -1 || v === null ? null : Number(v)))
        : [],
      isPendingEvaluation: !!r.is_pending_evaluation,
      isLiveSubmission: !!r.is_live_submission,
      submittedAtISO: r.submitted_at
    }));

    // এক্সাম মেটা (পাস মার্ক/সাবজেক্ট/কোর্স) — এবং পেন্ডিং হলে মূল্যায়ন
    const examsMeta: Record<string, { passMark: number; subject: string; course: string }> = {};
    const { data: examRows } = await supabase.from("exams").select("*");
    const examsMap: Record<string, Exam> = {};
    (examRows || []).forEach((ex) => {
      examsMap[ex.id] = {
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
        leaderboardEndTime: ex.leaderboard_end_time
      };
      examsMeta[ex.id] = {
        passMark: Number(ex.pass_mark) || 1,
        subject: ex.subject || "",
        course: ex.course || ""
      };
    });

    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    for (const s of subs) {
      const examObj = examsMap[s.examKey];
      const isReleased = examObj ? isAnswerTimeReached(examObj) : true;
      if (isReleased && (s.isPendingEvaluation || s.score === undefined)) {
        const solutions = await getExamSolutions(s.examKey);
        if (solutions && s.answers) {
          let cor = 0;
          let incor = 0;
          s.answers.forEach((ans, idx) => {
            const sol = solutions[idx];
            if (ans !== null && sol) {
              if (ans === sol.correct) cor++;
              else incor++;
            }
          });
          const sc = Math.max(0, cor - incor * 0.5);
          await supabase
            .from("submissions")
            .update({ score: sc, correct: cor, incorrect: incor, is_pending_evaluation: false })
            .eq("id", s.id);
          s.score = sc;
          s.correct = cor;
          s.incorrect = incor;
          s.isPendingEvaluation = false;
        }
      }
    }

    return { student, submissions: subs, examsMeta };
  } catch (err) {
    console.error("Teacher student history error:", err);
    return null;
  }
}
