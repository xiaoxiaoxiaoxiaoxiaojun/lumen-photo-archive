create table if not exists public.app_config (
  singleton boolean primary key default true check (singleton),
  owner_email text not null
);

alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_config
    where lower(owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique,
  title text not null check (char_length(title) between 1 and 80),
  category text not null default '旅途' check (category in ('旅途', '城市', '日常')),
  location text not null default '',
  captured_at text not null default '',
  created_at timestamptz not null default now()
);

alter table public.photos enable row level security;

create policy "signed in visitors can view photos"
on public.photos for select to authenticated
using (true);

create policy "owner can add photos"
on public.photos for insert to authenticated
with check (public.is_owner());

create policy "owner can update photos"
on public.photos for update to authenticated
using (public.is_owner()) with check (public.is_owner());

create policy "owner can delete photos"
on public.photos for delete to authenticated
using (public.is_owner());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "signed in visitors can view photo files"
on storage.objects for select to authenticated
using (bucket_id = 'photos');

create policy "owner can upload photo files"
on storage.objects for insert to authenticated
with check (bucket_id = 'photos' and public.is_owner());

create policy "owner can delete photo files"
on storage.objects for delete to authenticated
using (bucket_id = 'photos' and public.is_owner());

-- During private setup, insert the owner email from the Supabase SQL editor:
-- insert into public.app_config (singleton, owner_email) values (true, 'owner@example.com');
