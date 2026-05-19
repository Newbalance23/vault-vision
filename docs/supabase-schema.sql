-- Vault Vision V1 Supabase setup
-- Run this in the Supabase SQL editor for the project used by the web app.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.athletes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vault_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  athlete_id uuid references public.athletes(id) on delete set null,
  title text not null,
  recorded_at timestamptz,
  camera_angle text not null default 'auto',
  calibration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id uuid not null references public.vault_sessions(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  duration_seconds numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id uuid not null references public.vault_sessions(id) on delete cascade,
  schema_version text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists athletes_user_id_idx on public.athletes(user_id);
create index if not exists vault_sessions_user_id_created_idx on public.vault_sessions(user_id, created_at desc);
create index if not exists videos_session_id_idx on public.videos(session_id);
create index if not exists analyses_session_id_idx on public.analyses(session_id);

alter table public.profiles enable row level security;
alter table public.athletes enable row level security;
alter table public.vault_sessions enable row level security;
alter table public.videos enable row level security;
alter table public.analyses enable row level security;

drop policy if exists "profiles are self owned" on public.profiles;
create policy "profiles are self owned"
on public.profiles
for all
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "athletes are self owned" on public.athletes;
create policy "athletes are self owned"
on public.athletes
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "sessions are self owned" on public.vault_sessions;
create policy "sessions are self owned"
on public.vault_sessions
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "videos are self owned" on public.videos;
create policy "videos are self owned"
on public.videos
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "analyses are self owned" on public.analyses;
create policy "analyses are self owned"
on public.analyses
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vault-videos',
  'vault-videos',
  false,
  524288000,
  array['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "vault video objects are self readable" on storage.objects;
create policy "vault video objects are self readable"
on storage.objects
for select
using (
  bucket_id = 'vault-videos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "vault video objects are self insertable" on storage.objects;
create policy "vault video objects are self insertable"
on storage.objects
for insert
with check (
  bucket_id = 'vault-videos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "vault video objects are self updatable" on storage.objects;
create policy "vault video objects are self updatable"
on storage.objects
for update
using (
  bucket_id = 'vault-videos'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'vault-videos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "vault video objects are self deletable" on storage.objects;
create policy "vault video objects are self deletable"
on storage.objects
for delete
using (
  bucket_id = 'vault-videos'
  and (storage.foldername(name))[1] = auth.uid()::text
);
