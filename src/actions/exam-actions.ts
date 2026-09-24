"use server";

import { supabase } from "@/lib/supabase";
import { Exam, QuestionSolution } from "@/types/exam";
import { Submission, LeaderboardItem } from "@/types/submission";
import { parseBangladeshDateTime, getTrueDate, LIVE_GRACE_MS } from "@/lib/bangladesh-time";
import { parseTimeSpentToSeconds, parseBengaliDigits } from "@/lib/utils";
import { loadAnswerLockState, isQuestionLocked } from "@/lib/answer-lock";

export async function getExamSolutions(examKey: string): Promise<QuestionSolution[] | null> {
  try {
    const { unstable_noStore } = require("next/cache");
    unstable_noStore();
    // SECURITY: never leak the answer key to non-teachers until the exam's answer
    // release time. For SCHEDULED exams the key stays hidden BEFORE the exam starts
    // and while it runs (isAnswerTimeReached is false until endTime passes or the
    // teacher publishes results). Always-open practice exams have no schedule, so
    // their answers are public by design.
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    if (!(await isTeacherSession())) {
      const { data: examData, error: examError } = await supabase
        .from("exams")
        .select("start_time, end_time, leaderboard_start_time, leaderboard_end_time, is_result_published, timer_minutes")
        .eq("id", examKey)
        .maybeSingle();

      // SECURITY (fail-closed): a failed read must never open the gate.
      if (examError) return null;

      // examData === null (row deleted) deliberately keeps the archived-question
      // behaviour: the exam no longer exists, so its mirrored questions must stay
      // readable for practice/reading.
      if (examData) {
        const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
        const exam = {
          startTime: examData.start_time,
          endTime: examData.end_time,
          leaderboardStartTime: examData.leaderboard_start_time,
          leaderboardEndTime: examData.leaderboard_end_time,
          isResultPublished: examData.is_result_published === true,
          // SECURITY: MUST be supplied. Omitting timerMinutes made the release
          // delay fall back to 10 minutes, so a 60-minute live exam leaked its
          // answer key 50 minutes early.
          timerMinutes: Number(examData.timer_minutes ?? 0) || undefined
        } as Exam;

        // SECURITY: any window boundary (start OR end) makes this a scheduled
        // exam. The old `startTime && (endTime || leaderboardEndTime)` test
        // skipped the gate entirely for end-only and start-only exams, leaving
        // the key public from creation.
        const hasWindow = !!(exam.startTime || exam.endTime || exam.leaderboardEndTime);
        if (hasWindow && !isAnswerTimeReached(exam)) return null;
      }
    }

    // 1. Fetch from question_bank via exam_questions_link
    const { data: links, error: linkError } = await supabase
      .from("exam_questions_link")
      .select("order_index, question_bank(id, correct, exp)")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (!linkError && links && links.length > 0) {
      return links.map((l: any) => ({
        id: l.question_bank?.id,
        correct: l.question_bank?.correct ?? 0,
        exp: l.question_bank?.exp ?? ""
      }));
    }

    // 2. Fallback to exam_questions view if any
    const { data, error } = await supabase
      .from("exam_questions")
      .select("id, correct, exp")
      .eq("exam_id", examKey)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return (data || []).map((r) => ({
      id: r.id,
      correct: Number(r.correct),
      exp: r.exp || ""
    }));
  } catch (err) {
    console.error("Error fetching solutions:", err);
  }
  return null;
}

/**
 * একটিমাত্র পরীক্ষার ফলাফল-বিস্তারিত — এক কলেই exam-মেটা + প্রশ্ন + (রিলিজ হলে) উত্তর।
 *
 * শিক্ষার্থী কোনো score-এ ট্যাপ করলে আগে দুইটি আলাদা কল হতো
 * (fetchExamWithQuestions + getExamSolutions), আর দুটোই প্রায় একই exams/links
 * কোয়েরি করত। এখানে একটাই টার্গেটেড কল — শুধু ওই exam-এর ডেটা।
 */
export async function getExamResultBundle(examKey: string): Promise<{
  exam: Exam;
  questions: { id?: string; q: string; opts: string[]; topic?: string }[];
  solutions: QuestionSolution[] | null;
} | null> {
  try {
    const key = String(examKey || "").trim();
    if (!key) return null;

    // SECURITY: লগইন-সেশন থাকতে হবে (আগের fetchExamWithQuestions-এর মতোই)
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const sessionUser = await getSessionUserFromCookies();
    if (!sessionUser) return null;

    const { data: ex, error } = await supabase.from("exams").select("*").eq("id", key).maybeSingle();
    if (error || !ex) return null;

    const exam: Exam = {
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
      leaderboardEndTime: ex.leaderboard_end_time
    };

    // পেইড পরীক্ষায় এনরোলমেন্ট যাচাই (আগের নিয়ম অপরিবর্তিত)
    if (ex.is_free !== true) {
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const access = await verifyStudentAccess(sessionUser.id, ex.course || "", sessionUser.email);
      if (!access.allowed) return null;
    }

    // প্রশ্ন + উত্তর + ব্যাখ্যা — একটাই JOIN কোয়েরি (শুধু এই exam)
    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("order_index, question_bank(id, q, opts, topic, correct, exp)")
      .eq("exam_id", key);

    const sorted = (links || []).sort(
      (a: any, b: any) => Number(a.order_index) - Number(b.order_index)
    );

    const questions = sorted.map((l: any) => ({
      id: l.question_bank?.id,
      q: l.question_bank?.q || "",
      opts: l.question_bank?.opts || [],
      topic: l.question_bank?.topic || undefined
    }));

    // উত্তর কী কেবল রিলিজের পরে (নিরাপত্তা অপরিবর্তিত)
    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const teacher = await isTeacherSession();
    const released = teacher || isAnswerTimeReached(exam);

    const solutions: QuestionSolution[] | null = released
      ? sorted.map((l: any) => ({
          correct: Number(l.question_bank?.correct ?? 0),
          exp: l.question_bank?.exp || ""
        }))
      : null;

    return { exam, questions, solutions };
  } catch (err) {
    console.error("getExamResultBundle error:", err);
    return null;
  }
}

export async function checkStudentAlreadySubmitted(
  examKey: string,
  rawStudentId: string
): Promise<boolean> {
  try {
    const cleanId = String(rawStudentId || "").trim();
    const normId = parseBengaliDigits(cleanId).trim();
    if (!cleanId) return false;

    // SECURITY: only the student themselves may check their own submission
    const { sessionOwnsStudent } = await import("@/lib/teacher-auth");
    if (!(await sessionOwnsStudent(cleanId)) && !(await sessionOwnsStudent(normId))) return false;

    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);

    const { data, error } = await supabase
      .from("submissions")
      .select("student_id")
      .eq("exam_key", examKey)
      .in("student_id", ids);

    if (error) throw error;

    return (data || []).length > 0;
  } catch (err) {
    console.error("Check student submission error:", err);
    return false;
  }
}

/**
 * Returns whether the current caller holds a verified Supabase session. Used by
 * the exam hall to refuse starting an exam — and burning a full-length attempt —
 * when the student cannot submit at the end anyway (submission requires a
 * server-verified session).
 */
export async function ensureExamSession(): Promise<{ session: boolean; name?: string; id?: string }> {
  const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
  const sessionUser = await getSessionUserFromCookies();
  if (!sessionUser) return { session: false };
  return { session: true, id: sessionUser.id, name: sessionUser.name };
}

/**
 * পরীক্ষা শুরুর সময় সার্ভারে start-রেকর্ড তৈরি করে — client-এর দাবি নয়।
 * লিডারবোর্ড-যোগ্যতা (is_live_submission) পরে এই রেকর্ডের started_at live
 * উইন্ডোতে পড়ে কিনা তার উপর নির্ধারিত হয় (জমা-সময় দিয়ে নয়) — যাতে শেষ
 * বাউন্ডারিতে শুরু করলেও নাম লিডারবোর্ডে ওঠে।
 */
export async function claimExamStart(
  examKey: string,
  clientStudentId?: string
): Promise<{ ok: boolean; startedAtMs?: number }> {
  try {
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const sessionUser = await getSessionUserFromCookies();
    if (!sessionUser) return { ok: false };

    const examKeyClean = String(examKey || "").trim();
    if (!examKeyClean) return { ok: false };

    // শিক্ষার্থী-পরিচয় ঠিক করা: client id প্রিমিয়ামে সার্ভার-যাচাই হয়; ফ্রিতে session uid
    const { data: ex } = await supabase
      .from("exams")
      .select("is_free, course")
      .eq("id", examKeyClean)
      .maybeSingle();
    let studentId = "";
    if (ex?.is_free === true) {
      studentId = sessionUser.id;
    } else {
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const rawId = String(clientStudentId || sessionUser.id || "").trim();
      const access = await verifyStudentAccess(sessionUser.id, ex?.course || "", sessionUser.email);
      studentId = access.normalizedId || rawId;
      if (!access.allowed) return { ok: false };
    }
    if (!studentId) return { ok: false };

    const nowIso = new Date().toISOString();
    // একবারই রেকর্ড (প্রথম শুরুর সময় সংরক্ষিত) — বারবার শুরু করলে overwrite হয় না
    const { error } = await supabase
      .from("exam_attempt_starts")
      .upsert(
        { exam_id: examKeyClean, student_id: studentId, started_at: nowIso },
        { onConflict: "exam_id,student_id", ignoreDuplicates: true }
      );
    if (error) {
      // টেবিল এখনো না থাকলে (migration pending) নীরবে fail — ব্লক করি না
      if (/exam_attempt_starts/.test(String(error.message || ""))) return { ok: false };
      throw error;
    }

    // প্রকৃত (প্রথম) শুরুর সময়টাই ফেরত দিই — `nowIso` নয়।
    //
    // ⚠️ কেন: upsert টা `ignoreDuplicates` দিয়ে ডুপ্লিকেট এড়ায়, অর্থাৎ DB-তে
    // **প্রথম** সময়টাই থেকে যায়, কিন্তু এখানে `Date.parse(nowIso)` ফেরত দিলে
    // প্রতিবারই "এখন" ফিরত যেত। অথচ অ্যাপ এই মানটাকেই টাইমারের起点 বানায়
    // (`resolveExamDeadlineMs`) — ফলে শিক্ষার্থী পরীক্ষা বন্ধ করে আবার খুললেই
    // নতুন করে পুরো সময় পেয়ে যেত। ওটা বন্ধ করতে হলে সত্যিকারের সারি পড়তে হবে।
    let startedAtMs = Date.parse(nowIso);
    const stored = await readExamStartMs(examKeyClean, studentId);
    if (stored !== null) startedAtMs = stored;

    return { ok: true, startedAtMs };
  } catch (err) {
    console.error("claimExamStart error:", err);
    return { ok: false };
  }
}

/**
 * সার্ভারে নিবন্ধিত **প্রকৃত** শুরুর সময় (epoch ms) — না থাকলে `null`।
 *
 * `claimExamStart` যেটা লেখে, এটা ঠিক সেটাই পড়ে। `claimExamStart`-এর রিটার্ন
 * ব্যবহার না করে আলাদা রাখা হলো, কারণ একই পাঠ দরকার হয় তিন জায়গায়:
 * heartbeat-এ (`remainingSeconds`-এর জন্য), submit-এ (লাইভ-যোগ্যতা ও সময়ের
 * হিসাবে), আর debug-এ।
 *
 * টেবিল/মাইগ্রেশন না থাকলে নীরবে `null` — কোনোটাই ব্লক করি না।
 */
export async function readExamStartMs(
  examKey: string,
  studentId: string
): Promise<number | null> {
  try {
    const { data } = await supabase
      .from("exam_attempt_starts")
      .select("started_at")
      .eq("exam_id", String(examKey || "").trim())
      .eq("student_id", String(studentId || "").trim())
      .maybeSingle();
    if (!data?.started_at) return null;
    let dateStr = String(data.started_at);
    if (!dateStr.includes("Z") && !dateStr.includes("+")) dateStr += "Z";
    const t = Date.parse(dateStr);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

export async function submitExamAnswers(payload: {
  studentName: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  examTimerMinutes: number;
  timeRemaining: number;
  answers: any[];
  totalQuestions: number;
}): Promise<{
  success: boolean;
  isLive: boolean;
  isLiveSubmission?: boolean;
  score?: number;
  correct?: number;
  incorrect?: number;
  submissionId?: string;
  message?: string;
}> {
  try {
    // Fetch exam info
    const { data: examData, error: examError } = await supabase
      .from("exams")
      .select("*")
      .eq("id", payload.examKey)
      .maybeSingle();

    if (examError) throw examError;

    const exam: Exam | undefined = examData
      ? {
        id: examData.id,
        course: examData.course,
        subject: examData.subject,
        title: examData.title,
        timerMinutes: examData.timer_minutes,
        isFree: examData.is_free,
        passMark: Number(examData.pass_mark),
        startTime: examData.start_time,
        endTime: examData.end_time,
        isResultPublished: examData.is_result_published,
        leaderboardStartTime: examData.leaderboard_start_time,
        leaderboardEndTime: examData.leaderboard_end_time
      }
      : undefined;

    // SECURITY: the caller must hold a valid Supabase session (the exam UI
    // requires Google login before starting). Free exams accept any logged-in
    // user; paid exams additionally require enrollment in the exam's course.
    // The student record id is resolved server-side (phone id for paid exams),
    // so the client cannot submit under an arbitrary/forged student id.
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const sessionUser = await getSessionUserFromCookies();
    if (!sessionUser) {
      return {
        success: false,
        isLive: false,
        message: "পরীক্ষা দেওয়ার জন্য লগইন করা প্রয়োজন। অনুগ্রহ করে আবার লগইন করুন।"
      };
    }

    let recordStudentId = String(payload.studentId || "").trim();
    let recordStudentName = String(payload.studentName || "").trim();
    if (exam && exam.isFree !== true) {
      const { verifyStudentAccess } = await import("@/actions/student-actions");
      const access = await verifyStudentAccess(sessionUser.id, exam.course || "", sessionUser.email);
      if (!access.allowed) {
        return {
          success: false,
          isLive: false,
          message: access.message || "এই কোর্সের পরীক্ষা দেওয়ার অনুমতি নেই।"
        };
      }
      if (access.normalizedId) recordStudentId = access.normalizedId;
      // Use the enrollment record's name (not a client-supplied one) on the leaderboard
      if (access.studentName) recordStudentName = access.studentName;
    } else if (sessionUser.id) {
      // SECURITY: free exams previously stored the client-supplied student id
      // verbatim — anyone could file submissions under another student's id and
      // lock that student out of the live attempt. Bind the record to the
      // verified session uid instead (not forgeable from the client).
      recordStudentId = sessionUser.id;
      if (sessionUser.name) recordStudentName = sessionUser.name;

      // নাম: রোস্টারের নাম (allowed_students.name) আগে, Google প্রোফাইলের নাম পরে।
      // পোর্টালে নাম বদলালে সেটা এখানেই লেখা হয় — নাহলে ফ্রি পরীক্ষার
      // লিডারবোর্ডে Google-এর পুরোনো নামই দেখাত, পোর্টালের নাম কখনোই আসত না।
      try {
        const { verifyStudentAccess } = await import("@/actions/student-actions");
        const access = await verifyStudentAccess(sessionUser.id, "ALL", sessionUser.email);
        const rosterName = String(access.studentName || "").trim();
        if (access.allowed && rosterName) recordStudentName = rosterName;
      } catch {
        // রোস্টার না মিললে Google নামই থাকল
      }
    }

    // Validate + sanitize answers (never trust the client's shape blindly)
    const rawAnswers = Array.isArray(payload.answers) ? payload.answers : [];
    
    // Check if new format (objects) or old format (numbers)
    const isNewFormat = rawAnswers.length > 0 && typeof rawAnswers[0] === 'object' && rawAnswers[0] !== null && 'qid' in rawAnswers[0];
    let finalAnswers: any[] = [];
    
    if (isNewFormat) {
      finalAnswers = rawAnswers.slice(0, 500).map((v: any) => {
        if (!v || typeof v !== 'object') return null;
        const ans = v.ans === null || v.ans === undefined ? -1 : Math.min(20, Math.max(0, Math.floor(Number(v.ans) || 0)));
        return { qid: String(v.qid), ans };
      });
    } else {
      finalAnswers = rawAnswers.slice(0, 500).map((v: any) =>
        v === null || v === undefined ? -1 : Math.min(20, Math.max(0, Math.floor(Number(v) || 0)))
      );
    }

    const totalQuestions = Math.max(0, Number(payload.totalQuestions) || 0);

    const { parseBangladeshDateTime, getTrueDate } = await import("@/lib/bangladesh-time");
    const now = getTrueDate();

    // Check if exam is configured as a scheduled live exam (has startTime and endTime)
    const startTime = exam?.startTime ? parseBangladeshDateTime(exam.startTime) : null;
    const endTime = exam?.endTime ? parseBangladeshDateTime(exam.endTime) : (exam?.leaderboardEndTime ? parseBangladeshDateTime(exam.leaderboardEndTime) : null);

    // SECURITY: a scheduled exam cannot be submitted before its start time
    if (startTime && now.getTime() < startTime.getTime()) {
      return {
        success: false,
        isLive: false,
        message: "পরীক্ষাটি এখনো শুরু হয়নি। নির্ধারিত সময়ে আবার চেষ্টা করুন।"
      };
    }

    // লিডারবোর্ড-যোগ্যতা (is_live_submission) নির্ধারিত হয় **শুরু-সময়** দিয়ে:
    // শিক্ষার্থীর exam_attempt_starts-এর started_at যদি live-উইন্ডোতে (start..end) পড়ে
    // — জমা কখন হয়েছে তা দিয়ে নয়। ফলে শেষ-বাউন্ডারিতে শুরু করলেও নাম লিডারবোর্ডে ওঠে,
    // কিন্তু শেষের পরে শুরু করলে (start-রেকর্ড live-বাইরে) ওঠে না। (start-টেবিল migration-নির্ভর)
    let liveByStart = false;
    // SECURITY: this server-recorded start is also the authoritative source for
    // elapsed time (the leaderboard tie-breaker). It was previously read only to
    // decide live eligibility, while time_spent came from the client -- so a
    // caller could declare `timeRemaining = duration` and win every tie.
    let startedAtMs: number | null = null;
    if (startTime || endTime) {
      try {
        const storedMs = await readExamStartMs(payload.examKey, recordStudentId);
        if (storedMs !== null) {
          startedAtMs = storedMs;
          if (startTime && endTime) {
            liveByStart = storedMs >= startTime.getTime() && storedMs <= (endTime.getTime() + 59000);
          }
        }
      } catch {
        // টেবিল/মাইগ্রেশন না থাকলে নীরবে fallback-এ নামি
      }
    }

    // Is submitted within live scheduled window (fallback: জমা-সময় — start-রেকর্ড
    // না থাকলে / মাইগ্রেশন pending হলে আগের মতোই)। LIVE_GRACE_MS answer-release
    // গেটের সাথেও সামঞ্জস্য রাখে।
    const liveBySubmit = (startTime && endTime)
      ? (now.getTime() >= startTime.getTime() && now.getTime() <= endTime.getTime() + 59000 + LIVE_GRACE_MS)
      : false;

    // ── লাইভ-যোগ্যতার উপরের সীমা ──
    //
    // ⚠️ কেন দরকার: `liveByStart` কেবল দেখে "শুরু হয়েছিল উইন্ডোর ভেতরে কি না",
    // **জমা কখন হলো** তা নয়। ফলে কেউ লাইভ পরীক্ষা খুলে (start-রেকর্ড হয়ে যায়)
    // দিন পেরিয়ে, উত্তর প্রকাশের পরে — অর্থাৎ উত্তর দেখে — জমা দিলে সেটা তখনো
    // `is_live_submission = true` হয়ে **লিডারবোর্ডে** উঠে যেত।
    //
    // এখন নিজের পরীক্ষা-দৈর্ঘ্যের বাইরে গেলে সেটা "প্র্যাকটিস-প্রয়াস": জমা
    // নেওয়া হয় (ওয়েবের নিয়ম), কিন্তু লিডারবোর্ডে যায় না। start-রেকর্ড না
    // থাকলে (মাইগ্রেশন pending) আগের আচরণই থাকে — নাহলে ওই পরিবেশে সব লাইভ
    // সাবমিশন হঠাৎ প্র্যাকটিস হয়ে যেত।
    const liveWindowDurationMs =
      Math.max(1, exam?.timerMinutes ?? payload.examTimerMinutes ?? 60) * 60 * 1000;
    const withinOwnDuration = startedAtMs === null
      ? true
      : now.getTime() <= startedAtMs + liveWindowDurationMs + LIVE_GRACE_MS;

    const isLiveSubmission = startTime && endTime
      ? ((liveByStart || liveBySubmit) && withinOwnDuration)
      : false;

    // (User requested: "kew duibar exam dile agew ager rank r submission kete new ta add koro")
    // Therefore, we no longer block multiple live submissions. The previous submission
    // is simply deleted below and replaced by the new one.

    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    // isLive: if currently in live window and results are not published yet
    const isLive = isLiveSubmission && exam ? !isAnswerTimeReached(exam) : false;

    // Time spent is derived from the SERVER-known duration, not trusted raw
    // from the client: clamp it to [0, duration] so a forged timeRemaining
    // cannot produce a negative/absurd timeSpent for leaderboard tiebreaks.
    const durationSecs = Math.max(1, (exam?.timerMinutes ?? payload.examTimerMinutes) * 60);
    // SECURITY: prefer the server-recorded start; the clamped client report is
    // only a fallback (migration pending / always-open practice exam). time_spent
    // is the leaderboard tie-breaker, so a caller must not be able to declare
    // `timeRemaining = duration` and claim "0 মি. ০ সে." to win every tie.
    const rawSpent = startedAtMs !== null
      ? (now.getTime() - startedAtMs) / 1000
      : durationSecs - Number(payload.timeRemaining || 0);
    const timeSpentSecs = Math.max(0, Math.min(Math.floor(durationSecs), Math.floor(rawSpent)));
    const mins = Math.floor(timeSpentSecs / 60);
    const secs = timeSpentSecs % 60;
    const timeFormatted = `${mins} মি. ${secs} সে.`;

    let correct = 0;
    let incorrect = 0;
    let score = 0;

    // Always fetch solutions and compute score (stored in DB or returned when published)
    const solutions = await getExamSolutions(payload.examKey);
    // True whenever the answer key is still withheld, so this submission cannot
    // be scored yet -- including a non-live (late) attempt. Stored as pending so
    // it is scored automatically at release instead of being frozen at 0.
    const needsEvaluation = solutions === null;
    if (solutions) {
      if (isNewFormat) {
        const answerMap = new Map<string, number>();
        finalAnswers.forEach((a: any) => {
          if (a && a.qid) answerMap.set(a.qid, a.ans);
        });
        solutions.forEach((sol) => {
          const ans = sol.id != null && answerMap.has(sol.id) ? answerMap.get(sol.id) : -1;
          if (ans !== undefined && ans !== -1 && sol) {
            if (ans === sol.correct) correct++;
            else incorrect++;
          }
        });
      } else {
        finalAnswers.forEach((ans: number, idx: number) => {
          const sol = solutions[idx];
          if (ans !== -1 && sol) {
            if (ans === sol.correct) correct++;
            else incorrect++;
          }
        });
      }
      score = Math.max(0, correct - incorrect * 0.5);
    }

    // Delete any existing submission for this exam by this student that has the SAME live/practice status
    // (allows keeping a live score AND a practice score separately)
    await supabase
      .from("submissions")
      .delete()
      .eq("student_id", recordStudentId)
      .eq("exam_key", payload.examKey)
      .eq("is_live_submission", isLiveSubmission);

    // Remove the old start time record so if they retake it, they get a fresh timer
    await supabase
      .from("exam_attempt_starts")
      .delete()
      .eq("student_id", recordStudentId)
      .eq("exam_id", payload.examKey);

    const { data: newSub, error: insertError } = await supabase
      .from("submissions")
      .insert({
        student_name: recordStudentName,
        student_id: recordStudentId,
        exam_key: payload.examKey,
        exam_title: payload.examTitle,
        score: isLive ? 0 : score,
        correct: isLive ? 0 : correct,
        incorrect: isLive ? 0 : incorrect,
        total_questions: totalQuestions,
        time_spent: timeFormatted,
        answers: finalAnswers,
        // CORRECTNESS: a late (non-live) submission used to be written with
        // score 0 and is_pending_evaluation = false -- nothing ever re-evaluated
        // it, so the student saw 0/0 permanently. Any row we could not score
        // stays pending and is filled in once the key is released.
        is_pending_evaluation: needsEvaluation,
        is_live_submission: isLiveSubmission,
        submitted_at: getTrueDate().toISOString()
      })
      .select("id")
      .single();

    if (insertError) {
      // 23505 = unique violation: a concurrent tab/request already inserted a
      // live submission for this student (DB-level once-only guarantee).
      if ((insertError as { code?: string })?.code === "23505") {
        return {
          success: false,
          isLive: true,
          message: "আপনি ইতিমধ্যে এই লাইভ পরীক্ষায় অংশগ্রহণ করেছেন! লাইভ চলাকালীন এক আইডি দিয়ে কেবল একবারই পরীক্ষা দেওয়া যাবে।"
        };
      }
      throw insertError;
    }

    // Update streak silently
    try {
      await supabase.rpc("sync_user_streak", { user_id: recordStudentId });
    } catch (e) {
      console.error("Streak sync failed:", e);
    }

    return {
      success: true,
      isLive,
      isLiveSubmission,
      score: isLive ? undefined : score,
      correct: isLive ? undefined : correct,
      incorrect: isLive ? undefined : incorrect,
      submissionId: newSub.id
    };
  } catch (err) {
    console.error("Submit exam error:", err);
    return { success: false, isLive: false, message: "উত্তরপত্র জমা দিতে ত্রুটি হয়েছে।" };
  }
}

export async function fetchLeaderboard(examKey: string): Promise<LeaderboardItem[]> {
  try {
    const { data: examData, error: examError } = await supabase
      .from("exams")
      .select("*")
      .eq("id", examKey)
      .maybeSingle();

    if (examError) throw examError;

    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    const exam: Exam | undefined = examData
      ? {
        id: examData.id,
        course: examData.course,
        subject: examData.subject,
        title: examData.title,
        timerMinutes: examData.timer_minutes,
        isFree: examData.is_free,
        passMark: Number(examData.pass_mark),
        startTime: examData.start_time,
        endTime: examData.end_time,
        isResultPublished: examData.is_result_published,
        leaderboardStartTime: examData.leaderboard_start_time,
        leaderboardEndTime: examData.leaderboard_end_time
      }
      : undefined;

    if (!exam) {
      return [];
    }

    // Only SCHEDULED exams have an official leaderboard, and only after the
    // answer-release time. Late "practice" submissions and always-open exams
    // are never ranked on any leaderboard.
    const isScheduled = !!(exam.startTime && (exam.endTime || exam.leaderboardEndTime));
    if (!isScheduled || !isAnswerTimeReached(exam)) {
      return [];
    }

    const hasScheduledTime = isScheduled;

    let query = supabase
      .from("submissions")
      .select("*")
      .eq("exam_key", examKey);

    if (hasScheduledTime) {
      query = query.eq("is_live_submission", true);
    }


    const { data: subData, error: subError } = await query;

    if (subError) throw subError;

    // PII: student ids on the leaderboard are phone numbers. Never expose them
    // in full to anonymous viewers — the session owner (uid match) still sees
    // their own full id; everyone else sees only the last 2 digits.
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const sessionUser = await getSessionUserFromCookies();

    // নাম: `submissions.student_name` হলো সাবমিটের সময়কার snapshot, তাই নাম
    // বদলালে লিডারবোর্ডে পুরোনোটাই থেকে যেত। রোস্টার (`allowed_students.name`)
    // হলো আসল সূত্র — আগে যারা নাম বদলেছেন তাঁদের পুরোনো সারিগুলোও এতে ঠিক
    // দেখাবে, আলাদা করে আবার সেভ করার দরকার নেই।
    const rosterNames = new Map<string, string>();
    try {
      const studentIds = Array.from(
        new Set((subData || []).map((r) => String(r?.student_id || "").trim()).filter(Boolean))
      );
      if (studentIds.length > 0) {
        const { data: rosterRows } = await supabase
          .from("allowed_students")
          .select("id, name")
          .in("id", studentIds);
        (rosterRows || []).forEach((r: { id?: string; name?: string }) => {
          const rowId = String(r?.id || "").trim();
          const rowName = String(r?.name || "").trim();
          if (rowId && rowName) rosterNames.set(rowId, rowName);
        });
      }
    } catch {
      // রোস্টার না পড়া গেলে snapshot-ই থাকল (আগের আচরণ)
    }

    const subs: Submission[] = (subData || []).map((row) => ({
      id: row.id,
      studentName: rosterNames.get(String(row.student_id || "").trim()) || row.student_name,
      studentId:
        sessionUser && sessionUser.id && sessionUser.id === row.student_id
          ? row.student_id
          : "••••••" + String(row.student_id || "").slice(-2),
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

    // ALWAYS fetch solutions and recalculate. If the teacher deleted a question or fixed a wrong answer,
    // the leaderboard should instantly self-correct without manual intervention.
    const solutions = await getExamSolutions(examKey);
    if (solutions) {
      for (const s of subs) {
        if (s.answers) {
          let cor = 0;
          let incor = 0;
          
          const isNewFormat = s.answers.length > 0 && typeof s.answers[0] === 'object' && s.answers[0] !== null && 'qid' in s.answers[0];
          
          if (isNewFormat) {
             const answerMap = new Map<string, number>();
             s.answers.forEach((a: any) => {
               if (a && a.qid) answerMap.set(a.qid, Number(a.ans));
             });
             // Only evaluate based on CURRENT solutions. If a question was deleted, it won't be in `solutions`.
             solutions.forEach((sol) => {
               const ans = sol.id != null && answerMap.has(sol.id) ? answerMap.get(sol.id) : -1;
               if (ans !== undefined && ans !== -1 && sol) {
                  if (ans === sol.correct) cor++;
                  else incor++;
               }
             });
          } else {
             s.answers.forEach((ans, idx) => {
               const sol = solutions[idx];
               if (ans !== null && sol) {
                 if (Number(ans) === sol.correct) cor++;
                 else incor++;
               }
             });
          }
          
          const newScore = Math.max(0, cor - incor * 0.5);
          
          // Only hit the DB if the score actually changed, or if it was pending
          if (s.score !== newScore || s.correct !== cor || s.incorrect !== incor || s.isPendingEvaluation) {
            s.correct = cor;
            s.incorrect = incor;
            s.score = newScore;
            s.isPendingEvaluation = false;

            await supabase
              .from("submissions")
              .update({
                score: s.score,
                correct: cor,
                incorrect: incor,
                is_pending_evaluation: false
              })
              .eq("id", s.id);
          }
        }
      }
    }

    subs.sort((a, b) => {
      const scoreA = typeof a.score === "number" ? a.score : parseFloat(a.score) || 0;
      const scoreB = typeof b.score === "number" ? b.score : parseFloat(b.score) || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      const timeA = parseTimeSpentToSeconds(a.timeSpent);
      const timeB = parseTimeSpentToSeconds(b.timeSpent);
      if (timeA !== timeB) return timeA - timeB;

      return String(a.studentName || "").localeCompare(String(b.studentName || ""), "bn");
    });

    const passMark = exam.passMark ?? 1;

    return subs.map((s, idx) => ({
      rank: idx + 1,
      studentName: s.studentName || "নামবিহীন শিক্ষার্থী",
      studentId: s.studentId,
      timeSpent: s.timeSpent || "—",
      score: s.score ?? 0,
      isPassed: (s.score ?? 0) >= passMark
    }));
  } catch (err) {
    console.error("Fetch leaderboard error:", err);
    return [];
  }
}

/** র‍্যাঙ্ক-গণনার জন্য দরকারি কলাম এতটুকুই — পুরো সারি নয়। */
interface RankRow {
  score?: unknown;
  time_spent?: unknown;
  is_live_submission?: unknown;
}

export interface ExamRankInfo {
  practiceRank: number;
  totalCandidates: number;
  officialCandidates: number;
}

/** কুয়েরি ব্যর্থ, বা পরীক্ষার কোনো submission নেই — দুটোতেই আগের ফলাফলই। */
const RANK_FALLBACK: ExamRankInfo = {
  practiceRank: 1,
  totalCandidates: 1,
  officialCandidates: 0,
};

/**
 * এক পরীক্ষার সব submission থেকে র‍্যাঙ্ক।
 *
 * ⚠️ `time_spent` একটি **মুক্ত টেক্সট** কলাম ("১২ মিনিট ৩০ সেকেন্ড", "45:30",
 * "120") — তাই টাই-ব্রেকের তুলনাটা SQL-এ হয় না, `parseTimeSpentToSeconds` দিয়ে
 * JS-এ করতেই হয়। ওই একটাই কারণ, যেজন্য পুরো সারিগুলো টানা হয়।
 */
function computeRank(
  rows: RankRow[],
  userScore: number,
  userTimeSpent: string
): ExamRankInfo {
  let officialCandidates = 0;
  const allSubmissions: { score: number; timeSecs: number }[] = [];

  rows.forEach((row) => {
    if (row.is_live_submission === true) {
      officialCandidates++;
    }
    const sc = typeof row.score === "number" ? row.score : parseFloat(row.score as any) || 0;
    allSubmissions.push({
      score: sc,
      timeSecs: parseTimeSpentToSeconds(row.time_spent as any),
    });
  });

  const userTimeSecs = parseTimeSpentToSeconds(userTimeSpent);

  let practiceRank = 1;
  allSubmissions.forEach((cand) => {
    if (cand.score > userScore) {
      practiceRank++;
    } else if (cand.score === userScore && cand.timeSecs < userTimeSecs) {
      practiceRank++;
    }
  });

  return {
    practiceRank,
    totalCandidates: Math.max(1, allSubmissions.length),
    officialCandidates,
  };
}

/**
 * সীমিত সমান্তরালতায় ম্যাপ — একসাথে শত শত কুয়েরি ছুড়ে দিয়ে Supabase-এর
 * কানেকশন-পুল চেপে বসা ঠেকাতে।
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}

/** একসাথে কতগুলো submission-কুয়েরি উড়বে। */
const RANK_FETCH_CONCURRENCY = 8;

/**
 * **প্রতিটা পরীক্ষার জন্য একবার** submission আনে, এবং সেগুলো **সমান্তরালে**।
 *
 * ── কেন এটাই N+1-এর সমাধান ──
 * আগে কলাররা (দুই প্রোফাইল রুট) র‍্যাঙ্ক-ফাংশনটা **লুপের ভেতরে `await`** করত,
 * অর্থাৎ একটা শেষ না হলে পরেরটা শুরুই হতো না। `/api/profile/results`-এ সেটা ছিল
 * শিক্ষার্থীর প্রতিটি submission-এর জন্য দুটো করে ক্রমিক রাউন্ড-ট্রিপ (র‍্যাঙ্ক +
 * `exams`), আর প্রতিটি রাউন্ড-ট্রিপ ফাংশন-রিজিয়ন থেকে ডেটাবেস-রিজিয়ন পর্যন্ত
 * পাড়ি দিত। ফলে শিক্ষার্থীর পরীক্ষা যত, অপেক্ষা তত — সরলরৈখিকভাবে।
 *
 * এখন একই কুয়েরিগুলোই চলে, কেবল **ক্রমিকের বদলে একসাথে**। তাই মোট অপেক্ষা
 * প্রায় একটাই রাউন্ড-ট্রিপের, N-এর নয়।
 *
 * ⚠️ ইচ্ছাকৃতভাবে **এক কুয়েরিতে সব exam_key মেলানো হয়নি** (`.in(...)`)।
 * PostgREST-এর ডিফল্ট সারি-সীমা ১০০০; অনেক পরীক্ষার সারি একসাথে আনলে ওই সীমায়
 * কাটা পড়ে র‍্যাঙ্ক চুপচাপ **ভুল** হয়ে যেত (সবাইকে "১ম" দেখানোর ঝুঁকি)। প্রতি
 * পরীক্ষায় আলাদা কুয়েরি রাখলে সীমাটা আগের মতোই প্রতি-পরীক্ষায় খাটে, অর্থাৎ
 * কোনো নতুন আচরণ-পরিবর্তন নেই।
 */
export async function getExamCandidateRanks(
  queries: { examKey: string; score: number; timeSpent: string }[]
): Promise<ExamRankInfo[]> {
  if (queries.length === 0) return [];

  // একই পরীক্ষা একাধিকবার চাওয়া হলে (একই পরীক্ষার লাইভ ও প্র্যাকটিস সারি)
  // কুয়েরিটা যেন একবারই যায় — নাহলে লাভটা অর্ধেক হয়ে যায়।
  const uniqueKeys: string[] = [];
  const seen = new Set<string>();
  queries.forEach((q) => {
    const key = String(q.examKey ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    uniqueKeys.push(key);
  });

  if (uniqueKeys.length === 0) {
    return queries.map(() => ({ ...RANK_FALLBACK }));
  }

  const rowsByExam = await mapWithConcurrency(
    uniqueKeys,
    RANK_FETCH_CONCURRENCY,
    async (examKey) => {
      try {
        const { data, error } = await supabase
          .from("submissions")
          .select("score, time_spent, is_live_submission")
          .eq("exam_key", examKey);
        if (error) {
          console.error("Error calculating candidate rank:", error);
          return null;
        }
        return ((data || []) as unknown) as RankRow[];
      } catch (err) {
        console.error("Error calculating candidate rank:", err);
        return null;
      }
    }
  );

  const byKey = new Map<string, RankRow[] | null>();
  uniqueKeys.forEach((key, i) => byKey.set(key, rowsByExam[i]));

  return queries.map((q) => {
    const key = String(q.examKey ?? "").trim();
    const rows = key ? byKey.get(key) : undefined;
    // কুয়েরি ব্যর্থ (null) আর শূন্য submission — দুটোতেই একই ফল, ঠিক আগের মতো।
    if (!rows || rows.length === 0) return { ...RANK_FALLBACK };
    return computeRank(rows, Number(q.score) || 0, q.timeSpent);
  });
}

/**
 * একক পরীক্ষার র‍্যাঙ্ক — ব্যাচড সংস্করণের সরু মোড়ক।
 *
 * ক্লায়েন্ট-কম্পোনেন্ট (`exam/[examId]/result/page.tsx`) একটা পরীক্ষার জন্যই
 * ডাকে, তাই ওখানে সিগনেচার অপরিবর্তিত রাখা হলো।
 */
export async function getExamCandidateRank(
  examKey: string,
  userScore: number,
  userTimeSpent: string
): Promise<ExamRankInfo> {
  const [info] = await getExamCandidateRanks([
    { examKey, score: userScore, timeSpent: userTimeSpent },
  ]);
  return info ?? { ...RANK_FALLBACK };
}

/**
 * একগুচ্ছ পরীক্ষার কোর্স — **এক কুয়েরিতে**, `id → course` ম্যাপ।
 *
 * আগে প্রোফাইল রুটগুলো প্রতিটি সারির জন্য আলাদা করে
 * `exams.select('course').eq('id', …).single()` ডাকত, লুপের ভেতরে — অর্থাৎ
 * আরও N ক্রমিক রাউন্ড-ট্রিপ। ছোট ম্যাপটা একবার আনাই যথেষ্ট।
 */
export async function getExamCourseMap(
  examKeys: string[]
): Promise<Map<string, string>> {
  const keys: string[] = [];
  const seen = new Set<string>();
  examKeys.forEach((k) => {
    const key = String(k ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  });

  const map = new Map<string, string>();
  if (keys.length === 0) return map;

  try {
    const { data, error } = await supabase
      .from("exams")
      .select("id, course")
      .in("id", keys);
    if (error) return map;
    ((data || []) as any[]).forEach((row) => {
      const id = String(row?.id ?? "").trim();
      const course = String(row?.course ?? "").trim();
      if (id && course) map.set(id, course);
    });
  } catch {
    // কোর্স না মিললে ডিফল্ট ("মডেল টেস্ট")-ই থাকবে — আগের আচরণ
  }
  return map;
}

/**
 * Returns the student's own stored submission result from the database.
 * Used by the result page so the displayed score is the server-computed one,
 * not a client-side re-computation of editable sessionStorage data.
 *
 * ⚠️ এটা **সর্বশেষ** সাবমিশনটাই দেয় (যেকোনো ধরনের — লাইভ বা প্র্যাকটিস) —
 * ওয়েবের আচরণ অপরিবর্তিত রাখতে এটাই রেখে দেওয়া হলো। একই পরীক্ষার লাইভ ও
 * প্র্যাকটিস — **দুইটাই** দরকার হলে [getMySubmissions] ডাকুন (অ্যাপের
 * `/api/exams/{id}/result` তাই করে)।
 */
export async function getMySubmissionResult(
  examKey: string,
  studentId: string
): Promise<MySubmission | null> {
  const [latest] = await getMySubmissions(examKey, studentId);
  return latest ?? null;
}

/** শিক্ষার্থীর নিজের এক সাবমিশন — সার্ভার-সংরক্ষিত, ক্লায়েন্টের নয়। */
export interface MySubmission {
  score: number;
  correct: number;
  incorrect: number;
  answers: (number | null)[];
  isPendingEvaluation: boolean;
  isLiveSubmission: boolean;
  submittedAtISO: string;
  /** টাই-ব্রেকের জন্য দরকার (র‍্যাঙ্ক গণনা) — `"১২ মিনিট ৩০ সেকেন্ড"` জাতীয় টেক্সট। */
  timeSpent: string;
}

/**
 * একই পরীক্ষার **সব** সাবমিশন — নতুন আগে (`submitted_at` desc)।
 *
 * ── কেন লাগল ──
 * ওয়েব আর অ্যাপ — দুই জায়গাতেই একই পরীক্ষার **দুইটা ফল** থাকতে পারে: একবার
 * নির্ধারিত সময়ে (লাইভ, `is_live_submission = true`) আর যতবার খুশি তারপর
 * (প্র্যাকটিস, `false`)। ওয়েবের ড্যাশবোর্ড ঠিক এভাবেই দুইটা বাটন দেখায়
 * (`StudentDashboardModal.tsx` → `লাইভ: …` · `প্র্যাকটিস: …`)।
 *
 * অ্যাপের `/api/exams/{id}/result` আগে কেবল **সর্বশেষ সারিটাই** দিত, তাই লাইভ
 * পরীক্ষার পরে একবার প্র্যাকটিস করলেই লাইভ ফলটা পর্দা থেকে **মুছে যেত**।
 * এখন দুইটাই পাঠানো হয় — কিছুই মোছা হয় না (ওয়েবও মোছে না)।
 */
export async function getMySubmissions(
  examKey: string,
  studentId: string
): Promise<MySubmission[]> {
  try {
    const cleanId = String(studentId || "").trim();
    if (!cleanId) return [];
    const normId = parseBengaliDigits(cleanId).trim();

    // SECURITY: only the student themselves may fetch their own result
    const { sessionOwnsStudent } = await import("@/lib/teacher-auth");
    if (!(await sessionOwnsStudent(cleanId)) && !(await sessionOwnsStudent(normId))) return [];
    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);

    const { data, error } = await supabase
      .from("submissions")
      .select("*")
      .eq("exam_key", examKey)
      .in("student_id", ids)
      .order("submitted_at", { ascending: false });

    if (error) throw error;
    const rows = (data || []) as any[];
    if (rows.length === 0) return [];

    // উত্তর-কী প্রকাশ হয়ে গেলে যেসব সারি এখনো "pending" তাদের এখানেই (idempotent)
    // মূল্যায়ন করে নেওয়া হয় — নাহলে ফলাফলের পর্দায় ভুয়া শূন্য দেখাত, অথচ
    // রিভিউ-সেকশনে সত্যিকারের নম্বর থাকত। আগে এটা কেবল সর্বশেষ সারির জন্য হতো।
    const releaseExam = await loadReleaseExam(examKey);
    if (releaseExam) {
      const solutions = await getExamSolutions(examKey);
      for (const row of rows) {
        if (!row.is_pending_evaluation) continue;
        if (!solutions) break;
        const rawAnswers = Array.isArray(row.answers) ? row.answers : [];
        let cor = 0;
        let incor = 0;
        
        const isNewFormat = rawAnswers.length > 0 && typeof rawAnswers[0] === 'object' && rawAnswers[0] !== null && 'qid' in rawAnswers[0];
        
        if (isNewFormat) {
          const answerMap = new Map<string, number>();
          rawAnswers.forEach((a: any) => {
            if (a && a.qid) answerMap.set(a.qid, Number(a.ans));
          });
          solutions.forEach((sol) => {
            const ans = sol.id != null && answerMap.has(sol.id) ? answerMap.get(sol.id) : -1;
            if (ans !== undefined && ans !== -1 && sol) {
              if (ans === sol.correct) cor++;
              else incor++;
            }
          });
        } else {
          rawAnswers.forEach((v: any, qIdx: number) => {
            const sol = solutions[qIdx];
            if (v !== null && v !== -1 && v !== undefined && sol) {
              if (Number(v) === sol.correct) cor++;
              else incor++;
            }
          });
        }

        const sc = Math.max(0, cor - incor * 0.5);
        if (row.score !== sc || row.correct !== cor || row.incorrect !== incor || row.is_pending_evaluation) {
          await supabase
            .from("submissions")
            .update({ score: sc, correct: cor, incorrect: incor, is_pending_evaluation: false })
            .eq("id", row.id);
          row.score = sc;
          row.correct = cor;
          row.incorrect = incor;
          row.is_pending_evaluation = false;
        }
      }
    }

    return rows.map((row) => ({
      score: Number(row.score ?? 0),
      correct: Number(row.correct ?? 0),
      incorrect: Number(row.incorrect ?? 0),
      answers: Array.isArray(row.answers)
        ? row.answers.map((v: any) => {
            if (typeof v === 'object' && v !== null && 'qid' in v) {
               return v;
            }
            return (v === -1 || v === null ? null : Number(v));
          })
        : [],
      isPendingEvaluation: !!row.is_pending_evaluation,
      isLiveSubmission: !!row.is_live_submission,
      submittedAtISO: row.submitted_at || "",
      timeSpent: row.time_spent || "",
    }));
  } catch (err) {
    console.error("Get my submission result error:", err);
    return [];
  }
}

/**
 * উত্তর-কী এতক্ষণে প্রকাশ পেয়েছে কি না — pending সারি মূল্যায়নের সময় কাটা।
 * প্রকাশ না পেলে `null` (তখন হাতে-কলমে মূল্যায়ন করা হয় না)।
 */
async function loadReleaseExam(examKey: string): Promise<Exam | null> {
  const { data: exRow } = await supabase
    .from("exams")
    .select(
      "start_time, end_time, leaderboard_start_time, leaderboard_end_time, is_result_published, timer_minutes"
    )
    .eq("id", examKey)
    .maybeSingle();
  if (!exRow) return null;

  const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
  const releaseExam = {
    startTime: exRow.start_time,
    endTime: exRow.end_time,
    leaderboardStartTime: exRow.leaderboard_start_time,
    leaderboardEndTime: exRow.leaderboard_end_time,
    isResultPublished: exRow.is_result_published === true,
    // SECURITY: required -- without it the release delay defaulted to 10
    // minutes (see lib/bangladesh-time.ts isAnswerTimeReached).
    timerMinutes: Number(exRow.timer_minutes ?? 0) || undefined,
  } as Exam;

  return isAnswerTimeReached(releaseExam) ? releaseExam : null;
}

/**
 * Per-question live-exam statistics: how many students answered this question
 * correctly / wrongly / skipped during LIVE exams. Used by the topic reading
 * "এনালাইসিস" section (pie chart).
 */
export async function getQuestionLiveStats(
  qText: string
): Promise<{ correct: number; wrong: number; skipped: number; total: number }> {
  const zero = { correct: 0, wrong: 0, skipped: 0, total: 0 };
  try {
    const cleanQ = String(qText || "").trim();
    if (!cleanQ) return zero;

    // SECURITY: this action compares submitted answers against the TRUE key
    // (below), so during a live window it is a bit-by-bit answer-key oracle --
    // one throwaway account answering option 0 everywhere, plus one stats query
    // per question, recovers "is option 0 correct?" without the key ever being
    // returned. Restrict it to released exams for non-teachers.
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    const isTeacher = await isTeacherSession();
    const lock = isTeacher ? null : await loadAnswerLockState();

    // Find this question in the bank (exact text match)
    const { data: qRows } = await supabase
      .from("question_bank")
      .select("id, correct")
      .eq("q", cleanQ)
      .limit(20);
    if (!qRows || qRows.length === 0) return zero;

    const correctMap = new Map<string, number>();
    qRows.forEach((r) => correctMap.set(r.id, Number(r.correct)));

    // Exams that contain these questions
    const { data: links } = await supabase
      .from("exam_questions_link")
      .select("exam_id, question_id, order_index")
      .in("question_id", qRows.map((r) => r.id));
    if (!links || links.length === 0) return zero;

    if (lock && isQuestionLocked(lock, { questionId: qRows[0]?.id, text: cleanQ })) {
      return zero;
    }

    const examIds = Array.from(
      new Set(
        links
          .filter((l) => !lock || !isQuestionLocked(lock, { examKey: l.exam_id }))
          .map((l) => l.exam_id)
      )
    );
    if (examIds.length === 0) return zero;

    let correct = 0;
    let wrong = 0;
    let skipped = 0;

    for (const examId of examIds) {
      const { data: subs } = await supabase
        .from("submissions")
        .select("answers")
        .eq("exam_key", examId)
        .eq("is_live_submission", true);

      const examLinks = links.filter((l) => l.exam_id === examId);
      for (const s of subs || []) {
        for (const link of examLinks) {
          const ans = Array.isArray(s.answers) ? s.answers[link.order_index] : null;
          if (ans === null || ans === undefined || ans === -1) {
            skipped++;
          } else if (Number(ans) === correctMap.get(link.question_id)) {
            correct++;
          } else {
            wrong++;
          }
        }
      }
    }

    return { correct, wrong, skipped, total: correct + wrong + skipped };
  } catch (err) {
    console.error("Get question live stats error:", err);
    return zero;
  }
}
