-- Run once in Supabase -> SQL Editor. Safe to run again.
create table if not exists public.reset_requests (
  email text primary key,
  user_id uuid not null,
  username text not null,
  phone text not null,
  created_at timestamptz not null default now()
);
alter table public.reset_requests enable row level security; -- no policies: only the Edge Function can touch it
