import { supabase } from "@/lib/supabase";

/**
 * Server-side teacher authorization helpers.
 *
 * The session token is synced into a cookie (`sb_access_token`) by
 * src/lib/supabase.ts on every auth state change, so server actions can
 * verify who is calling them instead of trusting client-side storage
 * (sessionStorage/localStorage can be forged with DevTools).
 *
 * A user counts as a "teacher" when ANY of these is true:
 *  1. app_metadata.role is "admin" or "teacher" (set in Supabase Dashboard:
 *     Authentication → Users → Edit user → app_metadata — server-only, cannot
 *     be forged by the user)
 *  2. email is listed in the TEACHER_EMAILS env var (comma-separated)
 *
 * NOTE: user_metadata is deliberately NOT trusted — the user can overwrite it
 * themselves via supabase.auth.updateUser(), so it must never grant admin.
 */

function getAccessTokenFromCookies(): string | null {
  try {
    // Dynamic import keeps this module server-only even if imported by a client bundle
    const { cookies } = require("next/headers") as typeof import("next/headers");
    return cookies().get("sb_access_token")?.value || null;
  } catch {
    return null;
  }
}

/**
 * PERF: `auth.getUser(token)` একটি **নেটওয়ার্ক রাউন্ড-ট্রিপ** (মাপা ~২১০ms)।
 * প্র্যাকটিস/প্রশ্নব্যাংকের মতো ফ্লোতে একই রিকোয়েস্ট-সিরিজে ২-৩ বার ডাকা হতো
 * (verifyTeacherSession → getPracticeTopics → getPracticeQuestions), তাই একই
 * টোকেনের ফলাফল ৬০ সেকেন্ড মেমো করি। টোকেনই কী — লগআউট/রিফ্রেশে টোকেন বদলায়,
 * ফলে ক্যাশ নিজে থেকেই আলাদা হয়ে যায়। ব্যর্থ/null ফল ক্যাশ করা হয় না, যাতে
 * নেটওয়ার্ক ফিরে এলে সাথে সাথে কাজ করে।
 */
const AUTH_USER_TTL_MS = 60 * 1000;
const AUTH_USER_CACHE_MAX = 200;
/** Supabase auth.getUser() যেই ইউজার-অবজেক্ট দেয় (user_metadata/app_metadata সহ)। */
type AuthUser = NonNullable<Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"]>;
const authUserCache = new Map<string, { at: number; user: AuthUser }>();

export async function getUserFromToken(token?: string | null) {
  if (!token) return null;

  const hit = authUserCache.get(token);
  if (hit && Date.now() - hit.at < AUTH_USER_TTL_MS) return hit.user;

  try {
    const { data, error } = await Promise.race([
      supabase.auth.getUser(token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Auth timeout")), 4000))
    ]);
    if (error || !data.user) return null;

    if (authUserCache.size >= AUTH_USER_CACHE_MAX) {
      // সবচেয়ে পুরোনো এন্ট্রি ফেলে দিই (Map insertion-order)
      const oldest = authUserCache.keys().next().value;
      if (oldest) authUserCache.delete(oldest);
    }
    authUserCache.set(token, { at: Date.now(), user: data.user });
    return data.user;
  } catch {
    // timeout or network failure → treat as unauthenticated (never hang the UI)
    return null;
  }
}

function isTeacherEmail(email?: string): boolean {
  if (!email) return false;
  const allowed = (process.env.TEACHER_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

export function userIsTeacher(user: {
  app_metadata?: Record<string, unknown>;
  email?: string;
} | null): boolean {
  if (!user) return false;
  // Only app_metadata is trusted (set via Supabase Dashboard / admin API).
  // user_metadata can be self-edited by the user and must never grant admin.
  const role = user.app_metadata?.role;
  if (role === "admin" || role === "teacher") return true;
  return isTeacherEmail(user.email);
}

/** Returns the verified teacher (or null) for the current request. */
export async function getTeacherUser(token?: string | null): Promise<{ id: string; email?: string } | null> {
  const resolvedToken = token || getAccessTokenFromCookies();
  const user = await getUserFromToken(resolvedToken);
  if (!user) return null;
  if (!userIsTeacher(user)) return null;
  return { id: user.id, email: user.email };
}

/** Throws when the caller is not a verified teacher. Use in write/admin actions. */
export async function requireTeacher(): Promise<{ id: string; email?: string }> {
  const teacher = await getTeacherUser();
  if (!teacher) {
    throw new Error("Unauthorized: teacher access required");
  }
  return teacher;
}

/** Non-throwing variant. Use where a read may fall back to public access. */
export async function isTeacherSession(): Promise<boolean> {
  try {
    return !!(await getTeacherUser());
  } catch {
    return false;
  }
}

/**
 * Returns the verified Supabase session user for the current request (from the
 * sb_access_token cookie), or null. Unlike getTeacherUser this does NOT require
 * teacher privileges — it only proves "someone is logged in". Used to bind
 * student-facing actions to a real session instead of trusting client-supplied
 * student IDs.
 */
export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

export async function getSessionUserFromCookies(): Promise<SessionUser | null> {
  try {
    const user = await getUserFromToken(getAccessTokenFromCookies());
    if (!user) return null;
    const meta = (user.user_metadata || {}) as Record<string, unknown>;
    const name =
      (typeof meta.full_name === "string" && meta.full_name) ||
      (typeof meta.name === "string" && meta.name) ||
      "";
    return { id: user.id, email: user.email, name: name || undefined };
  } catch {
    return null;
  }
}

/**
 * True when the current request's session user is the same person as the given
 * student id: either the session uid equals the id, or the session user's email
 * matches the allowed_students row for that id (Google users are keyed by email
 * while exam records are keyed by phone id).
 */
export async function sessionOwnsStudent(studentId?: string | null): Promise<boolean> {
  try {
    const sessionUser = await getSessionUserFromCookies();
    if (!sessionUser) return false;
    const cleanId = String(studentId || "").trim();
    if (!cleanId) return false;
    if (sessionUser.id && sessionUser.id === cleanId) return true;
    if (!sessionUser.email) return false;

    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase
      .from("allowed_students")
      .select("email")
      .eq("id", cleanId)
      .maybeSingle();
    if (data?.email && String(data.email).trim().toLowerCase() === sessionUser.email.toLowerCase()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
