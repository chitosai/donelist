begin;

-- Existing installations must run the table-rename migration first.
do $check$
begin
  if to_regclass('public.done_records') is not null then
    raise exception 'Run the records table-rename migration before initializing this schema.';
  end if;
end;
$check$;

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

-- Keep version allocation and record writes in the same transaction.
-- The counter row serializes writes for one account; it is not a sequence.
lock table public.records in access exclusive mode;

create table if not exists public.record_sync_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  latest_version bigint not null default 0 check (latest_version >= 0)
);

alter table public.records add column if not exists sync_version bigint;

-- Backfill only unversioned rows, preserving existing IDs, content and times.
with existing_versions as (
  select user_id, coalesce(max(sync_version), 0) as latest_version
  from public.records
  group by user_id
), unversioned as (
  select record.id,
    versions.latest_version + row_number() over (partition by record.user_id order by record.id) as version
  from public.records as record
  join existing_versions as versions using (user_id)
  where record.sync_version is null
)
update public.records as record
set sync_version = unversioned.version
from unversioned
where record.id = unversioned.id;

insert into public.record_sync_state as state (user_id, latest_version)
select user_id, max(sync_version) from public.records group by user_id
on conflict (user_id) do update
set latest_version = greatest(state.latest_version, excluded.latest_version);

alter table public.records alter column sync_version set not null;
do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.records'::regclass and conname = 'records_sync_version_positive'
  ) then
    alter table public.records
      add constraint records_sync_version_positive check (sync_version > 0);
  end if;
end;
$constraint$;

-- Version order is unique within each account, so keyset pages need no offset.
create unique index if not exists records_user_sync_version_idx
  on public.records (user_id, sync_version);

create or replace function public.assign_record_sync_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'A record cannot be moved to another account.' using errcode = '23514';
  end if;

  insert into public.record_sync_state as state (user_id, latest_version)
  values (new.user_id, 1)
  on conflict (user_id) do update
  set latest_version = state.latest_version + 1
  returning latest_version into new.sync_version;

  return new;
end;
$function$;

revoke all on function public.assign_record_sync_version() from public, anon, authenticated;

drop trigger if exists records_assign_sync_version on public.records;
create trigger records_assign_sync_version
  before insert or update on public.records
  for each row execute function public.assign_record_sync_version();

alter table public.record_sync_state enable row level security;
revoke all on public.record_sync_state from public, anon, authenticated;
grant select on public.record_sync_state to authenticated;

drop policy if exists "Users can read their own sync state" on public.record_sync_state;
create policy "Users can read their own sync state"
  on public.record_sync_state for select to authenticated
  using ((select auth.uid()) = user_id);

-- The latest committed version bounds this download window. Text keeps bigint
-- cursors exact in JavaScript; the caller cannot inspect a different account.
create or replace function public.get_latest_sync_version(p_user_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'The sync account does not match the authenticated user.' using errcode = '42501';
  end if;
  return coalesce((
    select latest_version::text from public.record_sync_state where user_id = p_user_id
  ), '0');
end;
$function$;

revoke all on function public.get_latest_sync_version(uuid) from public, anon, authenticated;
grant execute on function public.get_latest_sync_version(uuid) to authenticated;

-- Validate the account on every page, including empty results. A plain table
-- GET under a changed auth session could otherwise look like an empty final page.
create or replace function public.get_record_diffs(
  p_user_id uuid,
  p_after_version bigint,
  p_until_version bigint,
  p_page_size integer default 500
)
returns setof public.records
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'The sync account does not match the authenticated user.' using errcode = '42501';
  end if;
  if p_after_version is null or p_until_version is null or p_page_size is null
    or p_after_version < 0 or p_until_version < p_after_version
    or p_page_size < 1 or p_page_size > 500 then
    raise exception 'Invalid sync page range or page size.' using errcode = '22023';
  end if;
  return query
    select record.* from public.records as record
    where record.user_id = p_user_id
      and record.sync_version > p_after_version
      and record.sync_version <= p_until_version
    order by record.sync_version
    limit p_page_size;
end;
$function$;

revoke all on function public.get_record_diffs(uuid, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.get_record_diffs(uuid, bigint, bigint, integer) to authenticated;


-- Physical deletion would make other devices miss the deletion. The existing
-- app deletes by updating deleted_at, which is versioned by the trigger.
drop policy if exists "Users can delete their own records" on public.records;
revoke all on public.records from public, anon, authenticated;
grant select, insert, update on public.records to authenticated;

notify pgrst, 'reload schema';

commit;
