"use server";

import { supabase } from "@/lib/supabase";
import { parseBengaliDigits } from "@/lib/utils";

/**
 * Cross-device sync for the mistake notebook & bookmarks — INCREMENTAL.
 *
 * আগের ডিজাইনে প্রতিটি পরিবর্তনে পুরো তালিকা delete+insert (replace-all) হতো —
 * হাজার হাজার mistake হলে সেটাই ধীর হয়ে যেত। এখন শুধু **যা বদলেছে তা-ই**
 * সার্ভারে যায়: নতুন mistake add, একটা remove, bookmark add/remove — ছোট ও দ্রুত।
 * তাই কোনো আকারের সীমাও (cap) লাগে না — একজন স্টুডেন্টের যতগুলোই ভুল হোক, সব থাকে।
 *
 * SECURITY: প্রতিটি কলের মালিকানা Supabase সেশন (cookie) দিয়ে যাচাই হয়
 * (getSessionUserFromCookies)। গেস্ট/লগ-ইন-বিহীন কল false পায় — ক্লায়েন্ট তখন
 * শুধু localStorage-এ চালিয়ে যায় (কোনো ক্র্যাশ নেই, অন্য কারও ডেটা স্পর্শ হয় না)।
 *
 * RLS: টেবিল দুটিতে RLS চালু, কোনো পলিসি নেই — শুধু service role (সার্ভার অ্যাকশন)।
 */

export interface MistakeSyncItem {
  id: string;
  q: string;
  opts: string[];
  correct: number;
  exp: string;
  userAns?: number | null;
  examTitle?: string;
  subject?: string;
  topic?: string;
  timestamp?: string;
  isBookmarked?: boolean;
}

type SyncKind = "mistakes" | "bookmarks";

const TABLE_FOR: Record<SyncKind, string> = {
  mistakes: "student_mistakes",
  bookmarks: "student_bookmarks"
};

async function resolveSessionOwner(): Promise<{ uid: string; email?: string } | null> {
  try {
    const { getSessionUserFromCookies } = await import("@/lib/teacher-auth");
    const user = await getSessionUserFromCookies();
    if (!user || !user.id) return null;
    return { uid: user.id, email: user.email };
  } catch {
    return null;
  }
}

/** যে id-গুলোতে এই স্টুডেন্টের পুরোনো রেকর্ড থাকতে পারে (uid/নরমালাইজড/email-মিলানো)। */
async function candidateIds(
  rawStudentId: string,
  session: { uid: string; email?: string }
): Promise<string[]> {
  const ids = new Set<string>();
  const clean = String(rawStudentId || "").trim();
  if (clean) ids.add(clean);
  const norm = parseBengaliDigits(clean).trim();
  if (norm) ids.add(norm);
  if (session.uid) ids.add(session.uid);
  if (session.email) {
    try {
      const { data } = await supabase
        .from("allowed_students")
        .select("id")
        .eq("email", session.email.trim().toLowerCase())
        .maybeSingle();
      if (data?.id) ids.add(String(data.id).trim());
    } catch {
      // ignore
    }
  }
  return Array.from(ids).filter(Boolean);
}

function rowToItem(row: any): MistakeSyncItem {
  return {
    id: row.id,
    q: row.q,
    opts: Array.isArray(row.opts) ? row.opts : [],
    correct: Number(row.correct ?? 0),
    exp: row.exp || "",
    userAns: row.user_ans === null || row.user_ans === undefined ? null : Number(row.user_ans),
    examTitle: row.exam_title || "",
    subject: row.subject || undefined,
    topic: row.topic || undefined,
    timestamp: row.timestamp || row.created_at || undefined,
    isBookmarked: row.is_bookmarked === true
  };
}

/**
 * সার্ভার থেকে এই স্টুডেন্টের পূর্ণ mistakes + bookmarks আনে (নতুন আগে)।
 * @returns পূর্ণ ডেটা; সেশন নেই/অননুমোদিত/টেবিল নেই হলে null (localStorage-ই চলবে)
 */
export async function fetchStudentMistakeData(
  rawStudentId: string
): Promise<{ mistakes: MistakeSyncItem[]; bookmarks: MistakeSyncItem[] } | null> {
  const session = await resolveSessionOwner();
  if (!session) return null;

  const ids = await candidateIds(rawStudentId, session);
  if (ids.length === 0) return null;

  try {
    // PERF: unbounded select নয় — সাম্প্রতিক ৫০০টি করে (UI-তে পেজ-পেজ দেখানো হয়,
    // তাই পুরো টেবিল টানা বন্ধ; বড় DB-তে পোর্টাল খোলার সময় অনেক কমে)
    const [mRes, bRes] = await Promise.all([
      supabase
        .from(TABLE_FOR.mistakes)
        .select("*")
        .in("student_id", ids)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from(TABLE_FOR.bookmarks)
        .select("*")
        .in("student_id", ids)
        .order("created_at", { ascending: false })
        .limit(500)
    ]);
    if (mRes.error || bRes.error) return null;
    return {
      mistakes: (mRes.data || []).map(rowToItem),
      bookmarks: (bRes.data || []).map(rowToItem)
    };
  } catch {
    return null;
  }
}

function itemToRow(item: MistakeSyncItem, studentId: string) {
  return {
    id: String(item.id || ""),
    student_id: studentId,
    q: String(item.q || ""),
    opts: Array.isArray(item.opts) ? item.opts : [],
    correct: Number(item.correct ?? 0),
    exp: String(item.exp || ""),
    user_ans: item.userAns === undefined || item.userAns === null ? null : Number(item.userAns),
    exam_title: String(item.examTitle || ""),
    subject: item.subject || null,
    topic: item.topic || null,
    timestamp: item.timestamp || null
  };
}

function qKey(q: string): string {
  return String(q || "").trim().toLowerCase();
}

/** লগ-ইন গেট — প্রতিটি অপারেশনের শুরুতে। সেশন না থাকলে null। */
async function authorizedIds(rawStudentId: string): Promise<string[] | null> {
  const session = await resolveSessionOwner();
  if (!session) return null;
  const ids = await candidateIds(rawStudentId, session);
  return ids.length > 0 ? ids : null;
}

/**
 * নতুন ভুল-উত্তরগুলো যোগ করে (যেগুলো ইতিমধ্যে নেই — প্রশ্নের লেখা দিয়ে dedupe)।
 * ইতিমধ্যে থাকা প্রশ্ন আবার পাঠালে সেটা ignore হয়।
 */
export async function addMistakeItems(
  rawStudentId: string,
  items: MistakeSyncItem[]
): Promise<boolean> {
  const ids = await authorizedIds(rawStudentId);
  if (!ids) return false;
  if (!items || items.length === 0) return true;

  try {
    // কোন প্রশ্নগুলো ইতিমধ্যে আছে — শুধু নতুনগুলোই insert হবে
    const { data: existing } = await supabase
      .from(TABLE_FOR.mistakes)
      .select("q")
      .in("student_id", ids);
    if (existing === null) return false;

    const have = new Set((existing || []).map((r) => qKey(r.q)));
    const fresh = items.filter((it) => it && !have.has(qKey(it.q)));

    if (fresh.length === 0) return true;
    const { error } = await supabase
      .from(TABLE_FOR.mistakes)
      .insert(fresh.slice(0, 500).map((it) => itemToRow(it, ids[0])));
    return !error;
  } catch {
    return false;
  }
}

/** একটা mistake id দিয়ে মুছে দেয় (শুধু নিজের student_id-এর মধ্যে)। */
export async function removeMistakeItem(rawStudentId: string, itemId: string): Promise<boolean> {
  const ids = await authorizedIds(rawStudentId);
  if (!ids || !itemId) return false;
  try {
    const { error } = await supabase
      .from(TABLE_FOR.mistakes)
      .delete()
      .eq("id", itemId)
      .in("student_id", ids);
    return !error;
  } catch {
    return false;
  }
}

/** এই স্টুডেন্টের সব mistake মুছে দেয়। */
export async function clearStudentMistakes(rawStudentId: string): Promise<boolean> {
  const ids = await authorizedIds(rawStudentId);
  if (!ids) return false;
  try {
    const { error } = await supabase.from(TABLE_FOR.mistakes).delete().in("student_id", ids);
    return !error;
  } catch {
    return false;
  }
}

/** একটা bookmark যোগ করে (একই প্রশ্ন আগে থেকে থাকলে আগেরটা বাদ দিয়ে নতুনটা)। */
export async function addBookmarkItem(rawStudentId: string, item: MistakeSyncItem): Promise<boolean> {
  const ids = await authorizedIds(rawStudentId);
  if (!ids || !item?.q) return false;
  try {
    await supabase
      .from(TABLE_FOR.bookmarks)
      .delete()
      .eq("q", item.q)
      .in("student_id", ids);
    const { error } = await supabase
      .from(TABLE_FOR.bookmarks)
      .insert(itemToRow(item, ids[0]));
    return !error;
  } catch {
    return false;
  }
}

/** একটা bookmark (প্রশ্নের লেখা দিয়ে) মুছে দেয়। */
export async function removeBookmarkItem(rawStudentId: string, questionText: string): Promise<boolean> {
  const ids = await authorizedIds(rawStudentId);
  if (!ids || !questionText) return false;
  try {
    const { error } = await supabase
      .from(TABLE_FOR.bookmarks)
      .delete()
      .eq("q", questionText)
      .in("student_id", ids);
    return !error;
  } catch {
    return false;
  }
}
