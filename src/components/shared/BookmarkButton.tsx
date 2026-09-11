"use client";

import React, { useState, useEffect } from "react";
import { Bookmark } from "lucide-react";
import {
  toggleQuestionBookmark,
  isQuestionBookmarked,
  ensureMistakeDataHydrated
} from "@/lib/mistake-bookmark-store";
import { getLocalStudentUser } from "@/lib/student-auth";

interface BookmarkButtonProps {
  studentId?: string;
  question: {
    q: string;
    opts: string[];
    correct: number;
    exp: string;
    userAns?: number | null;
    examTitle?: string;
    topic?: string;
    subject?: string;
  };
  size?: "sm" | "md";
}

export const BookmarkButton: React.FC<BookmarkButtonProps> = ({
  studentId,
  question,
  size = "md",
}) => {
  const [effectiveStudentId, setEffectiveStudentId] = useState(studentId || "");
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    const computeActiveId = (): string => {
      if (studentId) return studentId;
      const stored = sessionStorage.getItem("current_student");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.id) return parsed.id;
        } catch {
          // corrupted — fall through
        }
      }
      // Fall back to a stable per-browser guest id so anonymous visitors do
      // not all share one bookmark namespace.
      let guestId = sessionStorage.getItem("guest_bookmark_id");
      if (!guestId) {
        guestId = `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem("guest_bookmark_id", guestId);
      }
      return guestId;
    };

    const refresh = (skipHydrate = false) => {
      const id = computeActiveId();
      setEffectiveStudentId(id);
      setIsSaved(isQuestionBookmarked(id, question.q));

      // Cross-device sync: Google-লগ-ইন থাকলে অন্য ডিভাইসের বুকমার্ক নামিয়ে
      // আনি (গেস্ট/লগ-ইন-বিহীন অবস্থায় সার্ভার কল হয় না — নীরব fail)।
      // PERF: পেজে অনেক বাটন থাকতে পারে — হাইড্রেট সেশনে একবারই চলে; শেষ হলে
      // store "storage" ইভেন্ট দেয়, তাতেই সব বাটন নিজেরাই হালনাগাদ হয়।
      if (!skipHydrate && getLocalStudentUser()) {
        ensureMistakeDataHydrated(id);
      }
    };

    refresh();
    // Re-check when bookmarks change elsewhere (other tabs, or the app's own
    // manually-dispatched "storage" events on login/logout).
    const onStorage = () => refresh(true);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [studentId, question.q]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const activeId = effectiveStudentId || "guest_student";
    const newState = toggleQuestionBookmark(activeId, question);
    setIsSaved(newState);
  };

  const isSmall = size === "sm";

  return (
    <button
      type="button"
      onClick={handleToggle}
      title={isSaved ? "বুকমার্ক থেকে মুছুন" : "ভবিষ্যত রিভিশনের জন্য বুকমার্ক করুন"}
      className={`rounded-xl transition-all duration-200 flex items-center gap-1 cursor-pointer select-none active:scale-95 ${
        isSmall ? "p-1.5 text-xs" : "px-2.5 py-1.5 text-xs"
      } ${
        isSaved
          ? "bg-amber-100 text-amber-900 border border-amber-300 font-bold shadow-sm"
          : "bg-slate-100/80 hover:bg-slate-200/80 text-slate-600 border border-slate-200"
      }`}
    >
      <Bookmark
        className={`${isSmall ? "w-3.5 h-3.5" : "w-4 h-4"} ${
          isSaved ? "fill-amber-500 text-amber-600" : "text-slate-500"
        }`}
      />
      <span className="hidden sm:inline text-sm">
        {isSaved ? "বুকমার্ক সংরক্ষিত" : "বুকমার্ক"}
      </span>
    </button>
  );
};
