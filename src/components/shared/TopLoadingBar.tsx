"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * গ্লোবাল টপ প্রগ্রেস-বার — ক্লিক করার সাথে সাথেই সাড়া।
 *
 * কেন: Next.js নতুন পেজের ডেটা সার্ভার থেকে আনার সময় পুরো সময়টা কিছুই দেখানো
 * হয় না — তাই "বাটনে চাপ দিলাম, কিছুই হচ্ছে না" মনে হয়। এই বারটি ক্লিকের মুহূর্তেই
 * (এমনকি নেটওয়ার্ক শুরু হওয়ার আগেই) দেখা যায়, আর কাজ শেষ হলে মিলিয়ে যায়।
 *
 * কীভাবে: (১) ইন্টারনাল লিংকে ক্লিক → সাথে সাথে দেখাই; (২) window.fetch-এ
 * Next-এর RSC ডেটা-অনুরোধ বা সার্ভার-অ্যাকশন (POST) শুরু → দেখাই; শেষ হলে লুকাই;
 * (৩) পাথ বদলালে (নেভিগেশন শেষ) লুকাই। সর্বনিম্ন ৩০০ms দেখায় — যাতে ঝলকানি না লাগে।
 */
export const TopLoadingBar: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const pending = useRef(0);
  const shownAt = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!visible) {
      shownAt.current = Date.now();
      setVisible(true);
    }
  };

  const hide = () => {
    const elapsed = Date.now() - shownAt.current;
    const wait = Math.max(0, 300 - elapsed); // খুব দ্রুত হলে ঝলকাবে না
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), wait);
  };

  // পাথ বদলানো = নেভিগেশন শেষ → বার মিলিয়ে দিই
  useEffect(() => {
    pending.current = 0;
    hide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    // Next-এর RSC ডেটা-অনুরোধ (_rsc) বা সার্ভার-অ্যাকশন (POST) — এগুলোই "লোড হচ্ছে"
    const isBusyRequest = (url: string, method: string) => {
      try {
        if (!url.startsWith(window.location.origin)) return false;
        if (url.includes("_rsc=")) return true;
        if (method === "POST") return true;
        return false;
      } catch {
        return false;
      }
    };

    const wrapped: typeof window.fetch = async (input, init) => {
      let url = "";
      let method = "GET";
      try {
        if (typeof input === "string") url = input;
        else if (input instanceof URL) url = input.toString();
        else if (input instanceof Request) {
          url = input.url;
          method = input.method || "GET";
        }
        if (init?.method) method = init.method;
      } catch {
        /* ignore */
      }

      const busy = url ? isBusyRequest(url, method.toUpperCase()) : false;
      if (busy) {
        pending.current += 1;
        show();
      }
      try {
        return await originalFetch(input as RequestInfo, init);
      } finally {
        if (busy) {
          pending.current = Math.max(0, pending.current - 1);
          if (pending.current === 0) hide();
        }
      }
    };

    window.fetch = wrapped;

    // ইন্টারনাল লিংকে ক্লিক → নেটওয়ার্ক শুরুর আগেই সাথে সাথে সাড়া
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element | null;
      const anchor = el?.closest?.('a[href^="/"]');
      if (anchor) show();
    };
    document.addEventListener("click", onClick, true);

    return () => {
      window.fetch = originalFetch;
      document.removeEventListener("click", onClick, true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[200] h-1 pointer-events-none" aria-hidden="true">
      <div className="h-full w-1/3 rounded-r-full bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.6)] animate-[loadingbar_1.1s_ease-in-out_infinite]" />
    </div>
  );
};
