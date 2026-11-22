-- Run once in Supabase -> SQL Editor. Safe to run again.
create table if not exists public.hub (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)          -- the app saves with on_conflict=user_id,id, so this is required
);
alter table public.hub enable row level security;
drop policy if exists hub_select on public.hub;
drop policy if exists hub_insert on public.hub;
drop policy if exists hub_update on public.hub;
drop policy if exists hub_delete on public.hub;
create policy hub_select on public.hub for select using (auth.uid() = user_id);
create policy hub_insert on public.hub for insert with check (auth.uid() = user_id);
create policy hub_update on public.hub for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy hub_delete on public.hub for delete using (auth.uid() = user_id);
