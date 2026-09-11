/**
 * প্রশ্নব্যাংকের "পড়া হয়েছে" (✓ টিক) স্টোর
 *
 * • ডেটাবেজ (student_read_questions) = সব পড়া-চিহ্ন (cross-device)।
 * • localStorage = একই ব্রাউজারে সাথে সাথে দেখানোর ক্যাশ; ডেটাবেজ না থাকলে
 *   বা লগ-ইন না থাকলেও অ্যাপ ঠিকঠাক চলে (শুধু সিঙ্ক বন্ধ থাকে)।
 * • O(1) চেক: মেমোরিতে q-key-এর Set — প্রশ্নপত্রের প্রতি প্রশ্নে পুরো তালিকা
 *   স্ক্যান করা হয় না।
 * • সব সার্ভার-কল নীরব ব্যর্থ: সমস্যা হলেও লোকাল অবস্থা অটুট থাকে।
 */

export interface ReadQuestionItem {
  id: string;
  q: string;
  opts: string[];
  correct: number;
  exp: string;
  subject?: string;
  topic?: string;
  timestamp: string;
}

const READS_KEY_PREFIX = "csp_student_reads_";
const SYNC_META_KEY_PREFIX = "csp_reads_meta_";

/** localStorage-এ রাখা সর্বোচ্চ আইটেম (ক্যাশ) — কুইজ/প্রশ্নব্যাংকের জন্য যথেষ্ট। */
const LOCAL_CAP = 400;

function dataKey(studentId: string): string {
  return `${READS_KEY_PREFIX}${studentId}`;
}

function keyOf(item: { q?: string }): string {
  return String(item?.q || "").trim().toLowerCase();
}

interface MemState {
  items: ReadQuestionItem[];
  keys: Set<string>;
}

const memStates = new Map<string, MemState>();

function readLocal(studentId: string): ReadQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    const raw = localStorage.getItem(dataKey(studentId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocal(studentId: string, items: ReadQuestionItem[]): void {
  if (typeof window === "undefined" || !studentId) return;
  try {
    localStorage.setItem(dataKey(studentId), JSON.stringify(items.slice(0, LOCAL_CAP)));
  } catch {
    // ignore (private mode / কোটা শেষ) — শুধু গতি, মূল ফিচার নয়
  }
}

function setMem(studentId: string, items: ReadQuestionItem[]): void {
  memStates.set(studentId, { items, keys: new Set(items.map((i) => keyOf(i))) });
  writeLocal(studentId, items);
}

function currentItems(studentId: string): ReadQuestionItem[] {
  const mem = memStates.get(studentId);
  return mem ? mem.items : readLocal(studentId);
}

function write(studentId: string, items: ReadQuestionItem[]): void {
  const mem = memStates.get(studentId);
  if (mem) {
    mem.items = items;
    mem.keys = new Set(items.map((i) => keyOf(i)));
    writeLocal(studentId, items);
  } else {
    writeLocal(studentId, items);
  }
}

function notify(): void {
  if (typeof window === "undefined") return;
  try {
    // synthetic "storage" — একই ট্যাবে থাকা অন্য কম্পোনেন্টও রিফ্রেশ হয়
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

function getMeta(studentId: string): number {
  if (typeof window === "undefined" || !studentId) return 0;
  try {
    const raw = localStorage.getItem(`${SYNC_META_KEY_PREFIX}${studentId}`);
    return Number(JSON.parse(raw || "null")?.lastAckAt) || 0;
  } catch {
    return 0;
  }
}

function setMeta(studentId: string, lastAckAt: number): void {
  if (typeof window === "undefined" || !studentId) return;
  try {
    localStorage.setItem(`${SYNC_META_KEY_PREFIX}${studentId}`, JSON.stringify({ lastAckAt }));
  } catch {
    // ignore
  }
}

async function hasLoginSession(): Promise<boolean> {
  try {
    const { getLocalStudentUser } = await import("@/lib/student-auth");
    return !!getLocalStudentUser();
  } catch {
    return false;
  }
}

/** এই স্টুডেন্টের সব পড়া-হয়েছে প্রশ্ন (নতুন আগে)। */
export function getStudentReads(studentId: string): ReadQuestionItem[] {
  if (typeof window === "undefined" || !studentId) return [];
  try {
    return currentItems(studentId);
  } catch {
    return [];
  }
}

/** এই প্রশ্নটা পড়া হয়েছে কি না — O(1)। */
export function isQuestionRead(studentId: string, questionText: string): boolean {
  if (typeof window === "undefined" || !studentId || !questionText) return false;
  const mem = memStates.get(studentId);
  const key = keyOf({ q: questionText });
  if (mem) return mem.keys.has(key);
  return readLocal(studentId).some((i) => keyOf(i) === key);
}

function newItem(q: string, opts: string[], correct: number, exp: string, subject?: string, topic?: string): ReadQuestionItem {
  return {
    id: `read_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    q,
    opts: Array.isArray(opts) ? opts : [],
    correct: Number(correct ?? 0),
    exp: exp || "",
    subject,
    topic,
    timestamp: new Date().toISOString()
  };
}

function upload(studentId: string, items: ReadQuestionItem[]): void {
  queueUpload(studentId, items);
}
/**
 * ── আপলোড ব্যাচিং ────────────────────────────────────────────────────────
 * প্রশ্নব্যাংকে শিক্ষার্থী পরপর অনেক প্রশ্নে ✓ টিক দেয়। প্রতি টিকে আলাদা
 * সার্ভার-কল গেলে ৫০টি টিকে ~৫০টি রিকোয়েস্ট যেত। তাই টিকগুলো অল্প সময় জমিয়ে
 * একবারে পাঠাই (১.৫ সেকেন্ড নিষ্ক্রিয়তা বা ট্যাব লুকানোর সময়)।
 * ব্যর্থ হলেও কিছু হারায় না — পরের বার পেজ খুললে সিঙ্ক নিজেই বাকিগুলো তুলে নেয়।
 */
const FLUSH_DELAY_MS = 1500;
const pendingUploads = new Map<string, ReadQuestionItem[]>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueUpload(studentId: string, items: ReadQuestionItem[]): void {
  if (typeof window === "undefined" || !items?.length) return;
  const list = pendingUploads.get(studentId) || [];
  const seen = new Set(list.map((i) => keyOf(i)));
  items.forEach((it) => {
    const k = keyOf(it);
    if (seen.has(k)) return;
    seen.add(k);
    list.push(it);
  });
  pendingUploads.set(studentId, list);

  const timer = flushTimers.get(studentId);
  if (timer) clearTimeout(timer);
  flushTimers.set(
    studentId,
    setTimeout(() => void flushUploads(studentId), FLUSH_DELAY_MS)
  );
}

async function flushUploads(studentId: string): Promise<void> {
  const timer = flushTimers.get(studentId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(studentId);
  }
  const items = pendingUploads.get(studentId);
  pendingUploads.delete(studentId);
  if (!items || items.length === 0) return;
  try {
    if (!(await hasLoginSession())) return;
    const { addReadItems } = await import("@/actions/mistake-actions");
    await addReadItems(studentId, items);
  } catch {
    // নীরব — পরের সিঙ্কে reconcile হবে
  }
}

// ট্যাব লুকানো/বন্ধ করার আগে জমে থাকা টিকগুলো পাঠিয়ে দিই
if (typeof window !== "undefined") {
  try {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        Array.from(pendingUploads.keys()).forEach((id) => void flushUploads(id));
      }
    });
  } catch {
    // ignore
  }
}

/** ✓ টিক বসায়/তুলে দেয়। @returns নতুন অবস্থা (true = পড়া হয়েছে) */
export function toggleQuestionRead(
  studentId: string,
  item: { q: string; opts: string[]; correct: number; exp: string; subject?: string; topic?: string }
): boolean {
  if (typeof window === "undefined" || !studentId || !item?.q) return false;
  try {
    const items = currentItems(studentId);
    const key = keyOf(item);
    const idx = items.findIndex((i) => keyOf(i) === key);

    if (idx >= 0) {
      const removedQ = items[idx].q;
      const next = items.filter((_, i) => i !== idx);
      write(studentId, next);
      notify();
      void (async () => {
        try {
          if (!(await hasLoginSession())) return;
          const { removeReadItem } = await import("@/actions/mistake-actions");
          await removeReadItem(studentId, removedQ);
        } catch {
          // ignore
        }
      })();
      return false;
    }

    const full = newItem(item.q, item.opts, item.correct, item.exp, item.subject, item.topic);
    const next = [full, ...items];
    write(studentId, next);
    notify();
    upload(studentId, [full]);
    return true;
  } catch {
    return false;
  }
}

/** একসাথে অনেক প্রশ্ন "পড়া হয়েছে" চিহ্নিত করে (যেমন "সব পড়া হয়েছে" বাটন)। */
export function markQuestionsRead(
  studentId: string,
  items: { q: string; opts: string[]; correct: number; exp: string; subject?: string; topic?: string }[]
): number {
  if (typeof window === "undefined" || !studentId || !items?.length) return 0;
  try {
    const existing = currentItems(studentId);
    const have = new Set(existing.map((i) => keyOf(i)));
    const fresh = items
      .filter((it) => it?.q && !have.has(keyOf(it)))
      .map((it) => newItem(it.q, it.opts, it.correct, it.exp, it.subject, it.topic));
    if (fresh.length === 0) return 0;

    write(studentId, [...fresh, ...existing]);
    notify();
    upload(studentId, fresh);
    return fresh.length;
  } catch {
    return 0;
  }
}

/** সব পড়া-চিহ্ন মুছে দেয়। */
export function clearAllStudentReads(studentId: string): void {
  if (typeof window === "undefined" || !studentId) return;
  try {
    localStorage.removeItem(dataKey(studentId));
  } catch {
    // ignore
  }
  setMem(studentId, []);
  notify();
  void (async () => {
    try {
      if (!(await hasLoginSession())) return;
      const { clearStudentReads } = await import("@/actions/mistake-actions");
      await clearStudentReads(studentId);
    } catch {
      // ignore
    }
  })();
}

const syncChains = new Map<string, Promise<void>>();

/**
 * সার্ভার-হাইড্রেট: অন্য ডিভাইসের পড়া-চিহ্ন নামিয়ে আনে এবং এই ডিভাইসে জমা
 * হওয়া (এখনো আপলোড হয়নি এমন) চিহ্নগুলো সার্ভারে পাঠায়।
 * @returns পূর্ণ তালিকা; সেশন/টেবিল নেই বা ত্রুটি হলে null (localStorage-ই চলবে)
 */
export async function syncStudentReads(studentId: string): Promise<ReadQuestionItem[] | null> {
  if (typeof window === "undefined" || !studentId) return null;

  const run = async (): Promise<ReadQuestionItem[] | null> => {
    try {
      const mod = await import("@/actions/mistake-actions");
      const server = await mod.fetchStudentReadQuestions(studentId);
      if (!server) return null;

      const serverItems: ReadQuestionItem[] = server.map((s) => ({
        id: s.id,
        q: s.q,
        opts: s.opts,
        correct: s.correct,
        exp: s.exp,
        subject: s.subject,
        topic: s.topic,
        timestamp: s.timestamp || new Date().toISOString()
      }));

      const serverKeys = new Set(serverItems.map((i) => keyOf(i)));
      const lastAckAt = getMeta(studentId);
      const localItems = currentItems(studentId);
      const fresh = localItems.filter((it) => {
        if (serverKeys.has(keyOf(it))) return false;
        const ts = it.timestamp ? Date.parse(it.timestamp) : NaN;
        return lastAckAt === 0 || Number.isNaN(ts) || ts > lastAckAt;
      });

      let uploadOk = true;
      if (fresh.length > 0) {
        const ok = await mod.addReadItems(studentId, fresh);
        if (!ok) uploadOk = false;
      }

      const seen = new Set<string>();
      const merged: ReadQuestionItem[] = [];
      [...fresh, ...serverItems].forEach((it) => {
        const k = keyOf(it);
        if (seen.has(k)) return;
        seen.add(k);
        merged.push(it);
      });

      setMem(studentId, merged);
      notify();
      if (uploadOk) setMeta(studentId, Date.now());
      return merged;
    } catch {
      return null;
    }
  };

  const prev = syncChains.get(studentId) || Promise.resolve();
  let result: ReadQuestionItem[] | null = null;
  const next = prev.then(async () => {
    result = await run();
  }).catch(() => {
    result = null;
  });
  syncChains.set(studentId, next);
  await next;
  return result;
}
