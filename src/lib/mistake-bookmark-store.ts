import { QuestionItem, QuestionSolution } from "@/types/exam";

export interface MistakeQuestionItem {
  id: string;
  q: string;
  opts: string[];
  correct: number;
  exp: string;
  userAns: number | null;
  examTitle: string;
  subject?: string;
  topic?: string;
  timestamp: string;
  isBookmarked?: boolean;
}

const MISTAKES_KEY_PREFIX = "csp_student_mistakes_";
const BOOKMARKS_KEY_PREFIX = "csp_student_bookmarks_";
const SYNC_META_KEY_PREFIX = "csp_sync_meta_";

/** localStorage = শুধু ফাস্ট-ক্যাশ (সাম্প্রতিক) — ডেটাবেজেই সব স্থায়ী থাকে। */
const FAST_CACHE_CAP = 60;
/** গেস্ট/লগ-ইন-বিহীন (ডেটাবেজ নেই) অবস্থায় localStorage-এর নিরাপত্তা ক্যাপ। */
const LOCAL_ONLY_CAP = 200;

/**
 * ─────────────────────────────────────────────────────────────────────────
 * localStorage policy: শুধু ফাস্ট-ক্যাশ; ডেটাবেজ = সব (কোনো ক্যাপ নেই)
 *
 * • ভুল-উত্তর/বুকমার্ক যতগুলোই হোক — **সব ডেটাবেজে** (student_mistakes /
 *   student_bookmarks) থাকে। কোনো ২০০-সীমা নেই।
 * • localStorage-এ শুধু সাম্প্রতিক (~৬০) আইটেমের ছোট ক্যাশ — পেজ খুললেই সাথে
 *   সাথে দেখানোর জন্য। বাকি সব সার্ভার থেকে আসে।
 * • সিঙ্ক **ইনক্রিমেন্টাল**: পরিবর্তন হলেই শুধু সেই পরিবর্তন (add/remove) যায় —
 *   পুরো তালিকা আবার লেখা হয় না → হাজার হাজার হলেও দ্রুত।
 * • বুকমার্ক-চেক O(1) (মেমোরিতে Set) — প্রশ্নপত্রে প্রতি প্রশ্নে পুরো তালিকা
 *   স্ক্যান হয় না।
 * • গেস্ট/লগ-ইন-বিহীন: ডেটাবেজে জায়গা নেই, তাই localStorage-ই (LOCAL_ONLY_CAP)।
 * • সব ব্যর্থতা নীরব — সার্ভার/টেবিল না থাকলে localStorage-ভিত্তিক আচরণই থাকে।
 * ─────────────────────────────────────────────────────────────────────────
 */

type SyncKind = "mistakes" | "bookmarks";

interface SyncMeta {
  lastAckAt: number; // শেষ সফল সার্ভার হাইড্রেটের সময় (এই ডিভাইসে)
}

function getMetaKey(studentId: string): string {
  return `${SYNC_META_KEY_PREFIX}${studentId}`;
}

function getDataKey(kind: SyncKind, studentId: string): string {
  return `${kind === "mistakes" ? MISTAKES_KEY_PREFIX : BOOKMARKS_KEY_PREFIX}${studentId}`;
}

function getSyncMeta(studentId: string): SyncMeta {
  if (typeof window === "undefined" || !studentId) return { lastAckAt: 0 };
  try {
    const raw = localStorage.getItem(getMetaKey(studentId));
    const parsed = raw ? JSON.parse(raw) : null;
    return { lastAckAt: Number(parsed?.lastAckAt) || 0 };
  } catch {
    return { lastAckAt: 0 };
  }
}

function setSyncMeta(studentId: string, meta: SyncMeta): void {
  if (typeof window === "undefined" || !studentId) return;
  try {
    localStorage.setItem(getMetaKey(studentId), JSON.stringify(meta));
  } catch {
    // ignore
  }
}

function keyOf(item: MistakeQuestionItem): string {
  return String(item?.q || "").trim().toLowerCase();
}

/** সার্ভার-সিঙ্ক হওয়া পরিচয়ের পূর্ণ তালিকা এই পেজ-সেশনের মেমোরিতে। */
interface MemState {
  mistakes: MistakeQuestionItem[];
  bookmarks: MistakeQuestionItem[];
  bookmarkKeys: Set<string>; // O(1) চেকের জন্য q-key সূচি
}
const memStates = new Map<string, MemState>();

function readLocalList(kind: SyncKind, studentId: string): MistakeQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    const raw = localStorage.getItem(getDataKey(kind, studentId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** পড়া: মেমোরিতে পূর্ণ তালিকা থাকলে সেটাই; নাহলে ক্যাশ। */
function readFull(kind: SyncKind, studentId: string): MistakeQuestionItem[] {
  const mem = memStates.get(studentId);
  if (mem) return kind === "mistakes" ? mem.mistakes : mem.bookmarks;
  return readLocalList(kind, studentId);
}

function persistCache(kind: SyncKind, studentId: string, items: MistakeQuestionItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getDataKey(kind, studentId), JSON.stringify(items.slice(0, FAST_CACHE_CAP)));
  } catch {
    // ignore
  }
}

function persistLocalOnly(kind: SyncKind, studentId: string, items: MistakeQuestionItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getDataKey(kind, studentId), JSON.stringify(items.slice(0, LOCAL_ONLY_CAP)));
  } catch {
    // ignore
  }
}

/** মেমোরি (পূর্ণ) + localStorage (ফাস্ট-ক্যাশ) একসাথে হালনাগাদ। */
function writeFull(kind: SyncKind, studentId: string, items: MistakeQuestionItem[]): void {
  const mem = memStates.get(studentId);
  if (mem) {
    if (kind === "mistakes") mem.mistakes = items;
    else {
      mem.bookmarks = items;
      mem.bookmarkKeys = new Set(items.map((b) => keyOf(b)));
    }
    persistCache(kind, studentId, items);
  } else {
    persistLocalOnly(kind, studentId, items);
  }
}

function rebuildMemIndexes(studentId: string, mistakes: MistakeQuestionItem[], bookmarks: MistakeQuestionItem[]): void {
  memStates.set(studentId, {
    mistakes,
    bookmarks,
    bookmarkKeys: new Set(bookmarks.map((b) => keyOf(b)))
  });
  persistCache("mistakes", studentId, mistakes);
  persistCache("bookmarks", studentId, bookmarks);
}

function notifyLocalChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

/**
 * ডেটাবেজে যাদের ডেটা নিরাপদ (সিঙ্ক-মেটা আছে) কিন্তু এই পরিচয় নয় — তাদের
 * পুরোনো ক্যাশ মুছে দেয় (localStorage-এ জাঙ্ক জমতে দেয় না)। গেস্ট ও বর্তমান
 * পরিচয় স্পর্শ হয় না।
 */
function cleanupStaleSyncedKeys(currentId: string): void {
  if (typeof window === "undefined" || !currentId) return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key) continue;
      let sid: string | null = null;
      if (key.startsWith(MISTAKES_KEY_PREFIX)) sid = key.slice(MISTAKES_KEY_PREFIX.length);
      else if (key.startsWith(BOOKMARKS_KEY_PREFIX)) sid = key.slice(BOOKMARKS_KEY_PREFIX.length);
      else if (key.startsWith(SYNC_META_KEY_PREFIX)) sid = key.slice(SYNC_META_KEY_PREFIX.length);
      if (!sid || sid === currentId || sid.startsWith("guest_")) continue;
      const hasMeta = localStorage.getItem(getMetaKey(sid)) !== null;
      if (hasMeta) localStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

/** সার্ভার-অপারেশন চালানোর আগে দ্রুত ক্লায়েন্ট-গেট: Google লগ-ইন আছে কি না। */
async function hasLoginSession(): Promise<boolean> {
  try {
    const { getLocalStudentUser } = await import("@/lib/student-auth");
    return !!getLocalStudentUser();
  } catch {
    return false;
  }
}

/**
 * সার্ভারে একমুখী ছোট পরিবর্তন (fire-and-forget, নীরব ব্যর্থ)।
 * গেস্ট/লগ-ইন-বিহীন অবস্থায় কলই করা হয় না।
 */
async function sendOp(studentId: string, fn: () => Promise<boolean>): Promise<void> {
  if (!studentId || typeof window === "undefined") return;
  try {
    if (!(await hasLoginSession())) return;
    await fn();
  } catch {
    // নীরব — লোকাল অবস্থা ঠিক আছে; পরের হাইড্রেটে reconcile হবে
  }
}

/** লোকাল আইটেম বনাম সার্ভারের পার্থক্য বের করে “নতুন” (আপলোড করার মতো) গুলো। */
function pickUnsyncedNew(
  localItems: MistakeQuestionItem[],
  serverKeys: Set<string>,
  lastAckAt: number
): MistakeQuestionItem[] {
  return localItems.filter((item) => {
    if (serverKeys.has(keyOf(item))) return false;
    const ts = item.timestamp ? Date.parse(item.timestamp) : NaN;
    return lastAckAt === 0 || Number.isNaN(ts) || ts > lastAckAt;
  });
}

/** সার্ভার-সিঙ্কের কাজগুলো একসাথে সিরিয়ালাইজ করে (race এড়াতে)। */
const syncChains = new Map<string, Promise<void>>();

/**
 * একই পেজ-সেশনে প্রতি পরিচয়ের জন্য হাইড্রেট **একবারই**।
 *
 * কেন: প্রশ্নব্যাংক/পরীক্ষার রিভিউতে একসাথে ২০০টি কার্ড পর্যন্ত থাকে, আর
 * প্রতিটি কার্ডে একটা BookmarkButton বসে। প্রতিটি বাটন নিজে নিজে সিঙ্ক
 * ডাকলে ২০০টি সার্ভার-কল চলে যেত — তাই সিদ্ধান্তটা মডিউল-স্তরে রাখা হলো।
 * হাইড্রেট শেষে store নিজেই "storage" ইভেন্ট দেয়, ফলে সব বাটন নিজেরাই
 * হালনাগাদ হয়ে যায়।
 */
const hydratedIds = new Set<string>();

export function ensureMistakeDataHydrated(studentId: string): void {
  if (typeof window === "undefined" || !studentId) return;
  if (hydratedIds.has(studentId)) return;
  hydratedIds.add(studentId);
  void syncStudentMistakeData(studentId).catch(() => {
    // ব্যর্থ হলে দাগটা তুলে দিই — পরে আবার চেষ্টা করা যাবে
    hydratedIds.delete(studentId);
  });
}

/**
 * সার্ভার-হাইড্রেট: পূর্ণ mistakes/bookmarks নামিয়ে মেমোরি/ক্যাশ আপডেট করে;
 * অফলাইনে/সিঙ্ক-আগে জমা হওয়া নতুন আইটেমগুলো সার্ভারে আপলোড করে।
 * @returns পূর্ণ তালিকা; সেশন নেই/টেবিল নেই/ত্রুটি হলে null (localStorage-ই চলে)
 */
export async function syncStudentMistakeData(
  studentId: string
): Promise<{ mistakes: MistakeQuestionItem[]; bookmarks: MistakeQuestionItem[] } | null> {
  if (typeof window === "undefined" || !studentId) return null;

  const run = async (): Promise<{ mistakes: MistakeQuestionItem[]; bookmarks: MistakeQuestionItem[] } | null> => {
    try {
      const mod = await import("@/actions/mistake-actions");
      const server = await mod.fetchStudentMistakeData(studentId);
      if (!server) return null;

      const meta = getSyncMeta(studentId);
      const toLocalItem = (s: {
        id: string; q: string; opts: string[]; correct: number; exp: string;
        userAns?: number | null; examTitle?: string; subject?: string;
        topic?: string; timestamp?: string; isBookmarked?: boolean;
      }): MistakeQuestionItem => ({
        id: s.id,
        q: s.q,
        opts: s.opts,
        correct: s.correct,
        exp: s.exp,
        userAns: s.userAns ?? null,
        examTitle: s.examTitle || "",
        subject: s.subject,
        topic: s.topic,
        timestamp: s.timestamp || new Date().toISOString(),
        isBookmarked: s.isBookmarked
      });

      const serverM = (server.mistakes || []).map(toLocalItem);
      const serverB = (server.bookmarks || []).map(toLocalItem);
      const serverMKeys = new Set(serverM.map((m) => keyOf(m)));
      const serverBKeys = new Set(serverB.map((b) => keyOf(b)));

      const localM = readFull("mistakes", studentId);
      const localB = readFull("bookmarks", studentId);

      // অফলাইনে/সিঙ্ক-আগে জমা হওয়া নতুন আইটেম — সার্ভারে আপলোড করি
      const newMistakes = pickUnsyncedNew(localM, serverMKeys, meta.lastAckAt);
      const newBookmarks = pickUnsyncedNew(localB, serverBKeys, meta.lastAckAt);

      let uploadOk = true;
      if (newMistakes.length > 0) {
        const ok = await mod.addMistakeItems(studentId, newMistakes);
        if (!ok) uploadOk = false;
      }
      for (const bm of newBookmarks) {
        const ok = await mod.addBookmarkItem(studentId, bm);
        if (!ok) uploadOk = false;
      }

      // চূড়ান্ত তালিকা: নতুনগুলো আগে, তারপর সার্ভারের বাকিগুলো (q-দিয়ে dedupe)
      const merge = (fresh: MistakeQuestionItem[], serverItems: MistakeQuestionItem[]) => {
        const seen = new Set<string>();
        const out: MistakeQuestionItem[] = [];
        [...fresh, ...serverItems].forEach((item) => {
          const k = keyOf(item);
          if (seen.has(k)) return;
          seen.add(k);
          out.push(item);
        });
        return out;
      };
      const mergedM = merge(newMistakes, serverM);
      const mergedB = merge(newBookmarks, serverB);

      rebuildMemIndexes(studentId, mergedM, mergedB);
      notifyLocalChange();

      // আপলোড সফল (বা আপলোড করার কিছু ছিল না) হলে lastAckAt বাড়াই
      if (uploadOk) {
        setSyncMeta(studentId, { lastAckAt: Date.now() });
        cleanupStaleSyncedKeys(studentId);
      }
      return { mistakes: mergedM, bookmarks: mergedB };
    } catch {
      return null;
    }
  };

  const prev = syncChains.get(studentId) || Promise.resolve();
  let result: { mistakes: MistakeQuestionItem[]; bookmarks: MistakeQuestionItem[] } | null = null;
  const next = prev
    .then(async () => {
      result = await run();
    })
    .catch(() => {
      result = null;
    });
  syncChains.set(studentId, next);
  await next;
  return result;
}

/** এক্সাম শেষে নতুন ভুলগুলো সার্ভারে পাঠায় (শুধু নতুন — dedupe সার্ভারেও)। */
function pushNewMistakes(studentId: string, items: MistakeQuestionItem[]): void {
  void sendOp(studentId, async () => {
    const { addMistakeItems } = await import("@/actions/mistake-actions");
    return addMistakeItems(studentId, items);
  });
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * নিচের সব ফাংশন সিঙ্ক্রোনাস (UI-র কল-সাইট বদলায়নি) — মেমোরি/ক্যাশ থেকে
 * সাথে সাথে পড়ে; প্রতিটি পরিবর্তনের জন্য ছোট ইনক্রিমেন্টাল সার্ভার-কল চলে।
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Get all stored mistakes for a student
 */
export function getStudentMistakes(studentId: string): MistakeQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    const mem = memStates.get(studentId);
    if (mem) return mem.mistakes;
    const parsed = readLocalList("mistakes", studentId);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Error loading student mistakes:", err);
    return [];
  }
}

/**
 * Get all stored bookmarks for a student
 */
export function getStudentBookmarks(studentId: string): MistakeQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    const mem = memStates.get(studentId);
    if (mem) return mem.bookmarks;
    const parsed = readLocalList("bookmarks", studentId);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Error loading student bookmarks:", err);
    return [];
  }
}

/**
 * Save mistakes when a student finishes an exam
 */
export function saveMistakesFromSubmission(
  studentId: string,
  examTitle: string,
  questions: QuestionItem[],
  solutions: QuestionSolution[],
  answers: (number | null)[],
  subject?: string
): void {
  if (typeof window === "undefined" || !studentId || !questions.length) return;
  try {
    const currentMistakes = readFull("mistakes", studentId);
    const existingQTexts = new Set(currentMistakes.map((m) => m.q.trim().toLowerCase()));
    const added: MistakeQuestionItem[] = [];

    questions.forEach((q, idx) => {
      const userAns = answers[idx] ?? null;
      const sol = solutions[idx] || { correct: 0, exp: "" };

      // If wrong answer or skipped
      if (userAns !== sol.correct) {
        const qKey = q.q.trim().toLowerCase();
        if (!existingQTexts.has(qKey)) {
          const item: MistakeQuestionItem = {
            id: `mistake_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
            q: q.q,
            opts: q.opts,
            correct: sol.correct,
            exp: sol.exp,
            userAns,
            examTitle,
            subject: subject || "সাধারণ",
            topic: q.topic,
            timestamp: new Date().toISOString()
          };
          currentMistakes.unshift(item);
          added.push(item);
          existingQTexts.add(qKey);
        }
      }
    });

    if (added.length === 0) return;
    writeFull("mistakes", studentId, currentMistakes);
    notifyLocalChange();
    pushNewMistakes(studentId, added);
  } catch (err) {
    console.error("Error saving mistakes:", err);
  }
}

/**
 * Toggle bookmark for a question
 */
export function toggleQuestionBookmark(
  studentId: string,
  item: {
    q: string;
    opts: string[];
    correct: number;
    exp: string;
    userAns?: number | null;
    examTitle?: string;
    subject?: string;
    topic?: string;
  }
): boolean {
  if (typeof window === "undefined" || !studentId) return false;
  try {
    const bookmarks = readFull("bookmarks", studentId);
    const qKey = item.q.trim().toLowerCase();
    const existingIdx = bookmarks.findIndex((b) => b.q.trim().toLowerCase() === qKey);

    if (existingIdx >= 0) {
      // Remove bookmark (আগে প্রশ্নের লেখাটা ধরে রাখি — splice-এর পরে দরকার হবে)
      const removedQ = bookmarks[existingIdx].q;
      bookmarks.splice(existingIdx, 1);
      writeFull("bookmarks", studentId, bookmarks);
      notifyLocalChange();
      void sendOp(studentId, async () => {
        const { removeBookmarkItem } = await import("@/actions/mistake-actions");
        return removeBookmarkItem(studentId, removedQ);
      });
      return false;
    } else {
      // Add bookmark
      const full: MistakeQuestionItem = {
        id: `bm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        q: item.q,
        opts: item.opts,
        correct: item.correct,
        exp: item.exp,
        userAns: item.userAns ?? null,
        examTitle: item.examTitle || "বুকমার্ককৃত প্রশ্ন",
        subject: item.subject || "সাধারণ",
        topic: item.topic,
        timestamp: new Date().toISOString(),
        isBookmarked: true
      };
      bookmarks.unshift(full);
      writeFull("bookmarks", studentId, bookmarks);
      notifyLocalChange();
      void sendOp(studentId, async () => {
        const { addBookmarkItem } = await import("@/actions/mistake-actions");
        return addBookmarkItem(studentId, full);
      });
      return true;
    }
  } catch (err) {
    console.error("Error toggling bookmark:", err);
    return false;
  }
}

/**
 * Check if a question is bookmarked — O(1) (মেমোরি-সূচি); গেস্টে স্ক্যান।
 */
export function isQuestionBookmarked(studentId: string, questionText: string): boolean {
  if (typeof window === "undefined" || !studentId || !questionText) return false;
  const mem = memStates.get(studentId);
  const qKey = questionText.trim().toLowerCase();
  if (mem) return mem.bookmarkKeys.has(qKey);
  return getStudentBookmarks(studentId).some((b) => b.q.trim().toLowerCase() === qKey);
}

/**
 * Remove a mistake from mistake notebook
 */
export function removeStudentMistake(studentId: string, mistakeId: string): MistakeQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    const mistakes = readFull("mistakes", studentId).filter((m) => m.id !== mistakeId);
    writeFull("mistakes", studentId, mistakes);
    notifyLocalChange();
    void sendOp(studentId, async () => {
      const { removeMistakeItem } = await import("@/actions/mistake-actions");
      return removeMistakeItem(studentId, mistakeId);
    });
    return mistakes;
  } catch (err) {
    console.error("Error removing student mistake:", err);
    return getStudentMistakes(studentId);
  }
}

/**
 * Clear all mistakes for a student
 */
export function clearAllStudentMistakes(studentId: string): void {
  if (typeof window === "undefined" || !studentId) return;
  const mem = memStates.get(studentId);
  if (mem) mem.mistakes = [];
  try {
    localStorage.removeItem(getDataKey("mistakes", studentId));
  } catch {
    // ignore
  }
  notifyLocalChange();
  void sendOp(studentId, async () => {
    const { clearStudentMistakes } = await import("@/actions/mistake-actions");
    return clearStudentMistakes(studentId);
  });
}
