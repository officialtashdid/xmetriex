"use server";

import { supabase } from "@/lib/supabase";
import { Exam, QuestionSolution } from "@/types/exam";
import { Submission, LeaderboardItem } from "@/types/submission";
import { parseBangladeshDateTime, getTrueDate, LIVE_GRACE_MS } from "@/lib/bangladesh-time";
import { parseTimeSpentToSeconds, parseBengaliDigits } from "@/lib/utils";

export async function getExamSolutions(examKey: string): Promise<QuestionSolution[] | null> {
  try {
    // SECURITY: never leak the answer key to non-teachers until the exam's answer
    // release time. For SCHEDULED exams the key stays hidden BEFORE the exam starts
    // and while it runs (isAnswerTimeReached is false until endTime passes or the
    // teacher publishes results). Always-open practice exams have no schedule, so
    // their answers are public by design.
    const { isTeacherSession } = await import("@/lib/teacher-auth");
    if (!(await isTeacherSession())) {
      const { data: examData } = await supabase
        .from("exams")
        .select("start_time, end_time, leaderboard_end_time, is_result_published")
        .eq("id", examKey)
        .maybeSingle();
      if (examData) {
        const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
        const exam = {
          startTime: examData.start_time,
          endTime: examData.end_time,
          leaderboardEndTime: examData.leaderboard_end_time,
          isResultPublished: examData.is_result_published === true
        } as Exam;
        const isScheduled = !!(exam.startTime && (exam.endTime || exam.leaderboardEndTime));
        if (isScheduled && !isAnswerTimeReached(exam)) return null;
      }
    }

    // 1. Fetch from question_bank via exam_questions_link
    const { data: links, error: linkError } = await supabase
      .from("exam_questions_link")
      .select("order_index, question_bank(correct, exp)")
      .eq("exam_id", examKey)
      .order("order_index", { ascending: true });

    if (!linkError && links && links.length > 0) {
      return links.map((l: any) => ({
        correct: Number(l.question_bank?.correct ?? 0),
        exp: l.question_bank?.exp || ""
      }));
    }

    // 2. Fallback to exam_questions view if any
    const { data, error } = await supabase
      .from("exam_questions")
      .select("correct, exp")
      .eq("exam_id", examKey)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return (data || []).map((r) => ({
      correct: Number(r.correct),
      exp: r.exp || ""
    }));
  } catch (err) {
    console.error("Error fetching solutions:", err);
  }
  return null;
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
    return { ok: true, startedAtMs: Date.parse(nowIso) };
  } catch (err) {
    console.error("claimExamStart error:", err);
    return { ok: false };
  }
}

export async function submitExamAnswers(payload: {
  studentName: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  examTimerMinutes: number;
  timeRemaining: number;
  answers: (number | null)[];
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
    }

    // Validate + sanitize answers (never trust the client's shape blindly)
    const rawAnswers = Array.isArray(payload.answers) ? payload.answers : [];
    const answers = rawAnswers.slice(0, 500).map((v) =>
      v === null || v === undefined ? null : Math.min(20, Math.max(0, Math.floor(Number(v) || 0)))
    );
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
    if (startTime && endTime) {
      try {
        const { data: startRow } = await supabase
          .from("exam_attempt_starts")
          .select("started_at")
          .eq("exam_id", payload.examKey)
          .eq("student_id", recordStudentId)
          .maybeSingle();
        if (startRow?.started_at) {
          const s = parseBangladeshDateTime(startRow.started_at);
          liveByStart = !!s && s.getTime() >= startTime.getTime() && s.getTime() <= endTime.getTime();
        }
      } catch {
        // টেবিল/মাইগ্রেশন না থাকলে নীরবে fallback-এ নামি
      }
    }

    // Is submitted within live scheduled window (fallback: জমা-সময় — start-রেকর্ড
    // না থাকলে / মাইগ্রেশন pending হলে আগের মতোই)। LIVE_GRACE_MS answer-release
    // গেটের সাথেও সামঞ্জস্য রাখে।
    const liveBySubmit = (startTime && endTime)
      ? (now.getTime() >= startTime.getTime() && now.getTime() <= endTime.getTime() + LIVE_GRACE_MS)
      : false;

    const isLiveSubmission = startTime && endTime ? (liveByStart || liveBySubmit) : false;

    if (isLiveSubmission) {
      const alreadySubmitted = await checkStudentAlreadySubmitted(payload.examKey, recordStudentId);
      if (alreadySubmitted) {
        return {
          success: false,
          isLive: true,
          message: "আপনি ইতিমধ্যে এই লাইভ পরীক্ষায় অংশগ্রহণ করেছেন! লাইভ চলাকালীন এক আইডি দিয়ে কেবল একবারই পরীক্ষা দেওয়া যাবে।"
        };
      }
    }

    const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
    // isLive: if currently in live window and results are not published yet
    const isLive = isLiveSubmission && exam ? !isAnswerTimeReached(exam) : false;

    // Time spent is derived from the SERVER-known duration, not trusted raw
    // from the client: clamp it to [0, duration] so a forged timeRemaining
    // cannot produce a negative/absurd timeSpent for leaderboard tiebreaks.
    const durationSecs = Math.max(1, (exam?.timerMinutes ?? payload.examTimerMinutes) * 60);
    const rawSpent = durationSecs - Number(payload.timeRemaining || 0);
    const timeSpentSecs = Math.max(0, Math.min(durationSecs, rawSpent));
    const mins = Math.floor(timeSpentSecs / 60);
    const secs = timeSpentSecs % 60;
    const timeFormatted = `${mins} মি. ${secs} সে.`;

    let correct = 0;
    let incorrect = 0;
    let score = 0;

    // Always fetch solutions and compute score (stored in DB or returned when published)
    const solutions = await getExamSolutions(payload.examKey);
    if (solutions) {
      answers.forEach((ans, idx) => {
        const sol = solutions[idx];
        if (ans !== null && sol) {
          if (ans === sol.correct) correct++;
          else incorrect++;
        }
      });
      score = Math.max(0, correct - incorrect * 0.5);
    }

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
        answers: answers.map((v) => (v === null ? -1 : v)),
        is_pending_evaluation: isLive,
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

    const subs: Submission[] = (subData || []).map((row) => ({
      id: row.id,
      studentName: row.student_name,
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
        ? row.answers.map((v: any) => (v === -1 || v === null ? null : Number(v)))
        : [],
      isPendingEvaluation: row.is_pending_evaluation,
      isLiveSubmission: row.is_live_submission,
      submittedAtISO: row.submitted_at
    }));

    let hasPending = subs.some((s) => s.isPendingEvaluation || s.score === undefined);

    if (hasPending) {
      const solutions = await getExamSolutions(examKey);
      if (solutions) {
        for (const s of subs) {
          if ((s.isPendingEvaluation || s.score === undefined) && s.answers) {
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

            // Save evaluated score back to Supabase
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

export async function getExamCandidateRank(
  examKey: string,
  userScore: number,
  userTimeSpent: string
): Promise<{ practiceRank: number; totalCandidates: number; officialCandidates: number }> {
  try {
    const { data: subData, error } = await supabase
      .from("submissions")
      .select("score, time_spent, is_live_submission")
      .eq("exam_key", examKey);

    if (error) throw error;

    // Rank only among OFFICIAL live submissions — exactly the entries that
    // appear on the leaderboard. Late/practice attempts are never ranked.
    const official: { score: number; timeSecs: number }[] = [];
    (subData || []).forEach((row) => {
      if (row.is_live_submission !== true) return;
      const sc = typeof row.score === "number" ? row.score : parseFloat(row.score as any) || 0;
      official.push({
        score: sc,
        timeSecs: parseTimeSpentToSeconds(row.time_spent)
      });
    });

    const userTimeSecs = parseTimeSpentToSeconds(userTimeSpent);

    let higherCount = 0;
    official.forEach((sub) => {
      if (sub.score > userScore) {
        higherCount++;
      } else if (sub.score === userScore && sub.timeSecs < userTimeSecs) {
        higherCount++;
      }
    });

    const practiceRank = higherCount + 1;
    return {
      practiceRank,
      totalCandidates: Math.max(1, official.length),
      officialCandidates: official.length
    };
  } catch (err) {
    console.error("Error calculating candidate rank:", err);
    return { practiceRank: 1, totalCandidates: 1, officialCandidates: 0 };
  }
}

/**
 * Returns the student's own stored submission result from the database.
 * Used by the result page so the displayed score is the server-computed one,
 * not a client-side re-computation of editable sessionStorage data.
 */
export async function getMySubmissionResult(
  examKey: string,
  studentId: string
): Promise<{
  score: number;
  correct: number;
  incorrect: number;
  answers: (number | null)[];
  isPendingEvaluation: boolean;
  isLiveSubmission: boolean;
  submittedAtISO: string;
} | null> {
  try {
    const cleanId = String(studentId || "").trim();
    if (!cleanId) return null;
    const normId = parseBengaliDigits(cleanId).trim();

    // SECURITY: only the student themselves may fetch their own result
    const { sessionOwnsStudent } = await import("@/lib/teacher-auth");
    if (!(await sessionOwnsStudent(cleanId)) && !(await sessionOwnsStudent(normId))) return null;
    const ids = Array.from(new Set([cleanId, normId])).filter(Boolean);

    const { data, error } = await supabase
      .from("submissions")
      .select("*")
      .eq("exam_key", examKey)
      .in("student_id", ids)
      .order("submitted_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    const row = data?.[0];
    if (!row) return null;

    // If the row is still pending evaluation but answers are now released,
    // evaluate it here (idempotently) so the student's result page never shows
    // placeholder 0s while the review section shows the real per-question marks.
    if (row.is_pending_evaluation) {
      const { data: exRow } = await supabase
        .from("exams")
        .select("start_time, end_time, leaderboard_end_time, is_result_published")
        .eq("id", examKey)
        .maybeSingle();
      if (exRow) {
        const { isAnswerTimeReached } = await import("@/lib/bangladesh-time");
        const releaseExam = {
          startTime: exRow.start_time,
          endTime: exRow.end_time,
          leaderboardEndTime: exRow.leaderboard_end_time,
          isResultPublished: exRow.is_result_published === true
        } as Exam;
        if (isAnswerTimeReached(releaseExam)) {
          const solutions = await getExamSolutions(examKey);
          if (solutions) {
            const rawAnswers = Array.isArray(row.answers) ? row.answers : [];
            let cor = 0;
            let incor = 0;
            rawAnswers.forEach((v: any, qIdx: number) => {
              const sol = solutions[qIdx];
              if (v !== null && v !== -1 && v !== undefined && sol) {
                if (Number(v) === sol.correct) cor++;
                else incor++;
              }
            });
            const sc = Math.max(0, cor - incor * 0.5);
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
    }

    return {
      score: Number(row.score ?? 0),
      correct: Number(row.correct ?? 0),
      incorrect: Number(row.incorrect ?? 0),
      answers: Array.isArray(row.answers)
        ? row.answers.map((v: any) => (v === -1 || v === null ? null : Number(v)))
        : [],
      isPendingEvaluation: !!row.is_pending_evaluation,
      isLiveSubmission: !!row.is_live_submission,
      submittedAtISO: row.submitted_at || ""
    };
  } catch (err) {
    console.error("Get my submission result error:", err);
    return null;
  }
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

    const examIds = Array.from(new Set(links.map((l) => l.exam_id)));
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
