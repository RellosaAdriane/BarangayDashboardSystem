CREATE TABLE IF NOT EXISTS public.announcement_reads (
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  announcement_id bigint NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, announcement_id)
);
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
