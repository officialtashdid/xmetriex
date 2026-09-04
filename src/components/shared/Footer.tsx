"use client";

import React from "react";
import { GraduationCap, MessageCircle, Facebook } from "lucide-react";

export const Footer: React.FC = () => {
  const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER || "8801577301529";
  const facebookUrl = process.env.NEXT_PUBLIC_FACEBOOK_URL || "https://facebook.com/aarohon.edu";

  return (
    <footer className="bg-slate-900 text-slate-300 mt-10 border-t border-slate-800 font-bengali">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 py-4 flex flex-col sm:flex-row justify-between items-center gap-3 text-center sm:text-left">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-bold">
            <GraduationCap className="w-4 h-4" />
          </span>
          <h3 className="text-sm font-bold text-white">আরোহণ</h3>
          <span className="text-[10px] text-slate-400 ml-1">সর্বস্বত্ব সংরক্ষিত © {new Date().getFullYear()}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <a
            href={`https://wa.me/${whatsappNumber}`}
            target="_blank"
            rel="noreferrer"
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 shadow-sm"
          >
            <MessageCircle className="w-3.5 h-3.5 text-emerald-400" /> WhatsApp
          </a>
          <a
            href={facebookUrl}
            target="_blank"
            rel="noreferrer"
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 shadow-sm"
          >
            <Facebook className="w-3.5 h-3.5 text-indigo-400" /> Facebook
          </a>
        </div>
      </div>
    </footer>
  );
};
