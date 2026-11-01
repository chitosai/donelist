create table if not exists public.records (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  happened_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  is_highlighted boolean not null default false,
  deleted_at timestamptz
);

create index if not exists records_user_happened_at_idx
  on public.records (user_id, happened_at);

create index if not exists records_user_updated_at_idx
  on public.records (user_id, updated_at);

alter table public.records enable row level security;

drop policy if exists "Users can read their own records" on public.records;
create policy "Users can read their own records"
  on public.records for select
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own records" on public.records;
create policy "Users can insert their own records"
  on public.records for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own records" on public.records;
create policy "Users can update their own records"
  on public.records for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own records" on public.records;
create policy "Users can delete their own records"
  on public.records for delete
  using ((select auth.uid()) = user_id);
