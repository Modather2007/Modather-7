-- Run once in Supabase -> SQL Editor. Safe to run again.
create table if not exists public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_key text not null unique,
  phone text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
alter table public.signup_requests enable row level security;

drop policy if exists sr_insert on public.signup_requests;
drop policy if exists sr_admin on public.signup_requests;
-- anyone may send a request, but only as "pending"
create policy sr_insert on public.signup_requests for insert to anon, authenticated with check (status = 'pending');
-- only the admin account (Modather) can read, approve, reject or remove requests
create policy sr_admin on public.signup_requests for all to authenticated
  using ((auth.jwt() ->> 'email') = 'dseero2007+u2b84644c2f9a0baeea0406c2@gmail.com')
  with check ((auth.jwt() ->> 'email') = 'dseero2007+u2b84644c2f9a0baeea0406c2@gmail.com');

-- lets the applicant see the state of his own request without reading the table
create or replace function public.signup_status(u text) returns text
language sql security definer set search_path = public as $$
  select status from public.signup_requests where username_key = lower(trim(u))
$$;
grant execute on function public.signup_status(text) to anon, authenticated;
