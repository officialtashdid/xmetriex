import { Exam } from "@/types/exam";

export interface TimeSyncState {
  synced: boolean;
  serverTimeOffset: number;
  baseServerTime: number;
  basePerfTime: number;
}

let timeSync: TimeSyncState = {
  synced: false,
  serverTimeOffset: 0,
  baseServerTime: 0,
  basePerfTime: 0
};

/**
 * Live-window grace: submissions arriving up to this long after endTime are
 * still classified as live (protects on-time auto-submits from network
 * latency). Answer keys must NOT unlock before this grace has elapsed, or a
 * scripted client could fetch the key and submit a perfect score inside the
 * live window (see isAnswerTimeReached).
 */
export const LIVE_GRACE_MS = 10 * 1000;

export function parseBangladeshDateTime(dtStr?: string | null): Date | null {
  if (!dtStr) return null;
  let str = String(dtStr).trim();
  if (!str) return null;
  if (str.includes("Z") || str.includes("+") || str.match(/-\d{2}:\d{2}$/)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  if (str.length === 16) str += ":00";
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += "T00:00:00";
  str += "+06:00";
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  // Last resort: never fall back to device-local interpretation of a naive
  // string — treat it as Bangladesh time explicitly.
  const fallback = new Date(String(dtStr).trim().replace(" ", "T") + "+06:00");
  return isNaN(fallback.getTime()) ? null : fallback;
}

export function getTrueDate(): Date {
  if (typeof window !== "undefined" && timeSync.synced && timeSync.baseServerTime > 0 && timeSync.basePerfTime > 0) {
    const elapsed = performance.now() - timeSync.basePerfTime;
    return new Date(timeSync.baseServerTime + elapsed);
  }
  return new Date(Date.now() + timeSync.serverTimeOffset);
}

export function getTrueNowMs(): number {
  if (typeof window !== "undefined" && timeSync.synced && timeSync.baseServerTime > 0 && timeSync.basePerfTime > 0) {
    return timeSync.baseServerTime + (performance.now() - timeSync.basePerfTime);
  }
  return Date.now() + timeSync.serverTimeOffset;
}

export async function syncBangladeshNetworkTime(): Promise<boolean> {
  if (typeof window === "undefined") return true;

  // 1. Try local server time endpoint (fastest, no CORS, ~5-15ms)
  try {
    const startPerf = performance.now();
    const startLocal = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);

    const res = await fetch("/api/time", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const endPerf = performance.now();
      const endLocal = Date.now();
      const rtt = endPerf - startPerf;
      const serverTs = Number(data.now);

      if (serverTs && !isNaN(serverTs)) {
        const adjusted = serverTs + rtt / 2;
        timeSync.baseServerTime = adjusted;
        timeSync.basePerfTime = endPerf;
        timeSync.serverTimeOffset = adjusted - endLocal;
        timeSync.synced = true;
        return true;
      }
    }
  } catch {
    // Continue to external fallback endpoints
  }

  // 2. Fallback external endpoints
  const fallbackEndpoints = [
    {
      url: "https://cloudflare.com/cdn-cgi/trace",
      type: "text",
      parse: (text: string) => {
        const m = text.match(/ts=(\d+(?:\.\d+)?)/);
        return m ? Math.round(parseFloat(m[1]) * 1000) : null;
      }
    },
    {
      url: "https://1.1.1.1/cdn-cgi/trace",
      type: "text",
      parse: (text: string) => {
        const m = text.match(/ts=(\d+(?:\.\d+)?)/);
        return m ? Math.round(parseFloat(m[1]) * 1000) : null;
      }
    }
  ];

  for (const ep of fallbackEndpoints) {
    try {
      const startPerf = performance.now();
      const startLocal = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(ep.url, { method: "GET", cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const endPerf = performance.now();
        const endLocal = Date.now();
        const rtt = endPerf - startPerf;
        const text = await res.text();
        const serverTs = ep.parse(text);

        if (serverTs && !isNaN(serverTs)) {
          const adjusted = serverTs + rtt / 2;
          timeSync.baseServerTime = adjusted;
          timeSync.basePerfTime = endPerf;
          timeSync.serverTimeOffset = adjusted - endLocal;
          timeSync.synced = true;
          return true;
        }
      }
    } catch {
      // Continue to next endpoint
    }
  }

  return false;
}

export function isAnswerTimeReached(exam: Exam): boolean {
  // ১. শিক্ষক প্যানেল থেকে যদি রেজাল্ট ম্যানুয়ালি প্রকাশ/রিলিজ করা থাকে
  if (exam.isResultPublished === true) return true;

  // ২. নির্ধারিত (লাইভ) পরীক্ষার উত্তর-রিলিজ সময়।
  //     নিয়ম: যারা live-উইন্ডোতে (শেষ-বাউন্ডারি-সহ) শুরু করেছিল তারা যেন পুরো
  //     exam-সময় (timerMinutes) শেষ করার আগে উত্তর/উত্তরপত্র না খোলে। তাই লাইভ
  //     শেষ-সময়ের (endTime/leaderboardEndTime) পরে আরও exam-দৈর্ঘ্য (মিনিট) অপেক্ষা
  //     করতে হয় — LIVE_GRACE-এর বদলে। শিক্ষক আগেই publish করলে (শর্ত-১) সঙ্গে সঙ্গে।
  const now = getTrueDate();
  const examDurationMs = Math.max(1, (exam.timerMinutes || 10)) * 60 * 1000;
  if (exam.endTime) {
    const endTime = parseBangladeshDateTime(exam.endTime);
    if (endTime && now.getTime() >= endTime.getTime() + examDurationMs) return true;
  } else if (exam.leaderboardEndTime) {
    const endTime = parseBangladeshDateTime(exam.leaderboardEndTime);
    if (endTime && now.getTime() >= endTime.getTime() + examDurationMs) return true;
  }

  return false;
}

export function isExamCurrentlyLive(exam: Exam): boolean {
  if (!exam.startTime) return false;
  const now = getTrueDate();
  const startTime = parseBangladeshDateTime(exam.startTime);
  if (!startTime || now < startTime) return false;

  if (exam.endTime) {
    const endTime = parseBangladeshDateTime(exam.endTime);
    if (endTime && now > endTime) return false;
  } else if (exam.leaderboardEndTime) {
    const endTime = parseBangladeshDateTime(exam.leaderboardEndTime);
    if (endTime && now > endTime) return false;
  }
  return true;
}
