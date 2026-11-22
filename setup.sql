create table if not exists public.reset_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  tries int not null default 0,
  sent_at timestamptz not null default now()
);
alter table public.reset_codes enable row level security; -- no policies: only the Edge Function (service role) can touch it
