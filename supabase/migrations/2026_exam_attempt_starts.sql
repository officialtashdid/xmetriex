-- ============================================================
-- BCS-One: এক্সাম start-রেকর্ড + লিডারবোর্ড-যোগ্যতা (শুরুর সময়-ভিত্তিক)
-- Supabase Dashboard -> SQL Editor -> Run (একবারই; বারবার Run নিরাপদ)
--
-- কেন: লিডারবোর্ডে নাম ওঠা যেন "জমা দেওয়ার সময়" নয়, "পরীক্ষা শুরুর
-- সময়" দিয়ে নির্ধারিত হয় — যাতে শেষ-বাউন্ডারিতে শুরু করলেও নাম ওঠে,
-- কিন্তু live শেষের পর (উদাহরণ ১ মিনিট) শুরু করলে আর ওঠে না। client-এর
-- দাবি বিশ্বাস করা হয় না; start সার্ভারেই নথিবদ্ধ হয় (claimExamStart)।
-- ============================================================

create table if not exists public.exam_attempt_starts (
  id          bigint generated always as identity primary key,
  student_id  text not null,
  exam_id     text not null,
  started_at  timestamptz not null default timezone('utc', now()),
  created_at  timestamptz not null default timezone('utc', now()),
  unique (exam_id, student_id)
);

create index if not exists exam_attempt_starts_exam_idx
  on public.exam_attempt_starts (exam_id, student_id);
