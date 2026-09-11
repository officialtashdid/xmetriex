-- ============================================================
-- BCS-One: student_read_questions (প্রশ্নব্যাংকে "পড়া হয়েছে" টিকের সিঙ্ক)
--
-- প্রশ্নব্যাংকে প্রতিটি প্রশ্নের পাশে ✓ চিহ্ন দিয়ে শিক্ষার্থী "পড়া হয়েছে"
-- মার্ক করতে পারে। বুকমার্কের মতোই এই অবস্থাটাও সার্ভারে রাখা হয়, যাতে অন্য
-- ডিভাইসে/ব্রাউজারে ঢুকলেও কোনগুলো পড়া হয়ে গেছে তা জানা যায়।
--
-- টেবিল না থাকলে অ্যাপ ভাঙবে না — তখন শুধু localStorage-এ (একই ব্রাউজারে)
-- পড়া-চিহ্ন কাজ করবে, সার্ভার-সিঙ্ক নীরবে বন্ধ থাকবে।
--
-- Supabase Dashboard → SQL Editor → পেস্ট করে Run করুন (বারবার Run করলেও ক্ষতি নেই)
-- ============================================================

create table if not exists public.student_read_questions (
  id          text not null,               -- ক্লায়েন্ট-জেনারেটেড আইডি (read_...)
  student_id  text not null,               -- সুপাবেজ সেশন uid (ক্যানোনিকাল মালিক)
  q           text not null,               -- প্রশ্নের লেখা (এ দিয়েই dedupe হয়)
  opts        jsonb not null default '[]'::jsonb,
  correct     int  not null default 0,
  exp         text not null default '',
  user_ans    int,
  exam_title  text not null default '',
  subject     text,
  topic       text,
  timestamp   text,                        -- ক্লায়েন্টের ISO টাইমস্ট্যাম্প
  created_at  timestamptz not null default now(),
  primary key (student_id, id)
);

-- স্টুডেন্টভিত্তিক দ্রুত পড়ার জন্য সূচি (নতুন আগে)
create index if not exists student_read_questions_student_idx
  on public.student_read_questions (student_id, created_at desc);

-- কেবল সার্ভার অ্যাকশন (service role) পড়া/লেখা করতে পারবে —
-- RLS চালু, কোনো পলিসি নেই, তাই ক্লায়েন্ট সরাসরি অন্য কারও ডেটা দেখতে পারে না।
alter table public.student_read_questions enable row level security;
