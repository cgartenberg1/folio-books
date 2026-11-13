-- Folio: Multi-User Accounts, Magic Link Profiles & Invite-Code Friend Groups
-- Run this script in your Supabase SQL Editor (Database -> SQL Editor -> New Query).

create extension if not exists pgcrypto;

-- 1. User Profiles (auto-populated when a user signs in via Magic Link)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  share_activity boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_name text;
begin
  default_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    split_part(coalesce(new.email, 'Reader'), '@', 1)
  );
  insert into public.profiles (id, display_name)
  values (new.id, initcap(replace(replace(default_name, '.', ' '), '_', ' ')))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- 2. Personal Library Tables (scoped per authenticated user_id)
create table if not exists public.followed_authors (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  source text not null,
  external_id text,
  name text not null,
  image_url text,
  bio text,
  followed_at timestamptz not null default now(),
  last_synced_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists idx_followed_authors_user
  on public.followed_authors (user_id);

create table if not exists public.tracked_books (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  source text not null,
  external_id text,
  title text not null,
  author_name text not null,
  author_id text,
  cover_url text,
  release_date text,
  date_precision text not null default 'unknown',
  description text,
  page_count integer,
  isbn text,
  is_one_off boolean not null default false,
  is_manual boolean not null default false,
  hidden boolean not null default false,
  reading_status text not null default 'none',
  added_to_todo_at timestamptz,
  finished_at text,
  rating smallint,
  notes text,
  vellum_book_id text,
  vellum_progress double precision,
  vellum_chapter text,
  vellum_last_read_at timestamptz,
  vellum_format text,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Idempotent column upgrades for existing deployments
alter table public.tracked_books add column if not exists vellum_book_id text;
alter table public.tracked_books add column if not exists vellum_progress double precision;
alter table public.tracked_books add column if not exists vellum_chapter text;
alter table public.tracked_books add column if not exists vellum_last_read_at timestamptz;
alter table public.tracked_books add column if not exists vellum_format text;

create index if not exists idx_tracked_books_user_status
  on public.tracked_books (user_id, reading_status, finished_at desc);

create table if not exists public.reading_challenges (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  year integer not null,
  goal_count integer not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists idx_reading_challenges_user_year
  on public.reading_challenges (user_id, year);

-- 3. Invite-Code Friend Groups
create table if not exists public.friend_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.friend_group_members (
  group_id uuid not null references public.friend_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_friend_group_members_user
  on public.friend_group_members (user_id);

-- 4. Security Definer Helpers (prevents recursive RLS evaluation)
create or replace function public.is_group_member(target_group_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.friend_group_members
    where group_id = target_group_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.shares_group_membership_with(target_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.friend_group_members me
    join public.friend_group_members friend
      on me.group_id = friend.group_id
    where me.user_id = auth.uid()
      and friend.user_id = target_user_id
  );
$$;

create or replace function public.shares_friend_group_with(target_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.friend_group_members me
    join public.friend_group_members friend
      on me.group_id = friend.group_id
    join public.profiles p
      on p.id = friend.user_id
    where me.user_id = auth.uid()
      and friend.user_id = target_user_id
      and p.share_activity = true
  );
$$;

-- Atomic RPC: Create a Friend Group and add creator as owner
create or replace function public.create_friend_group(group_name text)
returns public.friend_groups
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  generated_code text;
  new_group public.friend_groups;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  -- Ensure caller has a profile row
  insert into public.profiles (id, display_name)
  values (caller_id, 'Reader')
  on conflict (id) do nothing;

  loop
    generated_code := '';
    for i in 1..6 loop
      generated_code := generated_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.friend_groups where invite_code = generated_code);
  end loop;

  insert into public.friend_groups (name, invite_code, created_by)
  values (trim(group_name), generated_code, caller_id)
  returning * into new_group;

  insert into public.friend_group_members (group_id, user_id, role)
  values (new_group.id, caller_id, 'owner');

  return new_group;
end;
$$;

-- Atomic RPC: Join a Friend Group by 6-character invite code
create or replace function public.join_group_by_code(invite_code_input text)
returns public.friend_groups
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  normalized_code text := upper(trim(invite_code_input));
  matched_group public.friend_groups;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  select * into matched_group
  from public.friend_groups
  where upper(invite_code) = normalized_code
  limit 1;

  if matched_group.id is null then
    raise exception 'Invalid invite code. Double-check the 6-character code from your friend.';
  end if;

  insert into public.profiles (id, display_name)
  values (caller_id, 'Reader')
  on conflict (id) do nothing;

  insert into public.friend_group_members (group_id, user_id, role)
  values (matched_group.id, caller_id, 'member')
  on conflict (group_id, user_id) do nothing;

  return matched_group;
end;
$$;

-- 5. Row-Level Security Policies
alter table public.profiles enable row level security;
alter table public.followed_authors enable row level security;
alter table public.tracked_books enable row level security;
alter table public.reading_challenges enable row level security;
alter table public.friend_groups enable row level security;
alter table public.friend_group_members enable row level security;

-- Profiles: read own or shared-group member display names; update/insert own
drop policy if exists "Read own or group member profiles" on public.profiles;
create policy "Read own or group member profiles"
  on public.profiles for select
  using (auth.uid() = id or public.shares_group_membership_with(id));

drop policy if exists "Insert own profile" on public.profiles;
create policy "Insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Update own profile" on public.profiles;
create policy "Update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Followed authors: strictly private to each user
drop policy if exists "Manage own followed_authors" on public.followed_authors;
create policy "Manage own followed_authors"
  on public.followed_authors for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Tracked books: owner has full access; group friends can read finished ('read') non-hidden books
drop policy if exists "Manage own tracked_books" on public.tracked_books;
create policy "Manage own tracked_books"
  on public.tracked_books for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Friends can view finished books" on public.tracked_books;
create policy "Friends can view finished books"
  on public.tracked_books for select
  using (
    reading_status = 'read'
    and hidden = false
    and public.shares_friend_group_with(user_id)
  );

-- Reading challenges: owner has full access; group friends can view challenge goals
drop policy if exists "Manage own reading_challenges" on public.reading_challenges;
create policy "Manage own reading_challenges"
  on public.reading_challenges for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Friends can view reading_challenges" on public.reading_challenges;
create policy "Friends can view reading_challenges"
  on public.reading_challenges for select
  using (public.shares_friend_group_with(user_id));

-- Friend groups & memberships
drop policy if exists "Members can view their friend_groups" on public.friend_groups;
create policy "Members can view their friend_groups"
  on public.friend_groups for select
  using (public.is_group_member(id));

drop policy if exists "Members can view group memberships" on public.friend_group_members;
create policy "Members can view group memberships"
  on public.friend_group_members for select
  using (public.is_group_member(group_id));

drop policy if exists "Users can leave groups" on public.friend_group_members;
create policy "Users can leave groups"
  on public.friend_group_members for delete
  using (auth.uid() = user_id);

-- 6. Personal Vellum Ebook Reader Bridge Tokens (for Native iOS/Android & Remote Sync)
create table if not exists public.vellum_bridge_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vellum_bridge_tokens enable row level security;

drop policy if exists "Manage own vellum_bridge_tokens" on public.vellum_bridge_tokens;
create policy "Manage own vellum_bridge_tokens"
  on public.vellum_bridge_tokens for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Generate or fetch the signed-in user's personal Vellum Bridge Token
create or replace function public.get_or_create_vellum_bridge_token(rotate_existing boolean default false)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  existing_token text;
  fresh_token text;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  if not coalesce(rotate_existing, false) then
    select token into existing_token
    from public.vellum_bridge_tokens
    where user_id = caller_id;

    if existing_token is not null then
      return existing_token;
    end if;
  end if;

  fresh_token := 'fbr_' || encode(gen_random_bytes(18), 'hex');

  insert into public.vellum_bridge_tokens (user_id, token, updated_at)
  values (caller_id, fresh_token, now())
  on conflict (user_id) do update
    set token = excluded.token,
        updated_at = now();

  return fresh_token;
end;
$$;

-- Read personal library snapshot for a valid Vellum Bridge Token
create or replace function public.vellum_bridge_get_state(token_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_row public.vellum_bridge_tokens;
  books_arr jsonb;
  challenges_arr jsonb;
begin
  select * into matched_row
  from public.vellum_bridge_tokens
  where token = trim(coalesce(token_input, ''))
  limit 1;

  if matched_row.user_id is null then
    raise exception 'Invalid Folio bridge token';
  end if;

  select coalesce(jsonb_agg(row_to_json(b)), '[]'::jsonb)
  into books_arr
  from (
    select *
    from public.tracked_books
    where user_id = matched_row.user_id
  ) b;

  select coalesce(jsonb_agg(row_to_json(c)), '[]'::jsonb)
  into challenges_arr
  from (
    select *
    from public.reading_challenges
    where user_id = matched_row.user_id
    order by year desc
  ) c;

  return jsonb_build_object(
    'user_id', matched_row.user_id,
    'last_sync_at', matched_row.last_sync_at,
    'books', books_arr,
    'challenges', challenges_arr
  );
end;
$$;

-- Upsert Vellum-synced book updates for a valid Vellum Bridge Token
create or replace function public.vellum_bridge_save_books(token_input text, books_json jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_row public.vellum_bridge_tokens;
  item jsonb;
  synced_ts timestamptz := now();
begin
  select * into matched_row
  from public.vellum_bridge_tokens
  where token = trim(coalesce(token_input, ''))
  limit 1;

  if matched_row.user_id is null then
    raise exception 'Invalid Folio bridge token';
  end if;

  if jsonb_typeof(books_json) = 'array' then
    for item in select * from jsonb_array_elements(books_json)
    loop
      insert into public.tracked_books (
        user_id,
        id,
        source,
        external_id,
        title,
        author_name,
        author_id,
        cover_url,
        release_date,
        date_precision,
        description,
        page_count,
        isbn,
        is_one_off,
        is_manual,
        hidden,
        reading_status,
        added_to_todo_at,
        finished_at,
        rating,
        notes,
        vellum_book_id,
        vellum_progress,
        vellum_chapter,
        vellum_last_read_at,
        vellum_format,
        updated_at
      )
      values (
        matched_row.user_id,
        item->>'id',
        coalesce(item->>'source', 'manual'),
        nullif(item->>'external_id', ''),
        coalesce(item->>'title', 'Untitled'),
        coalesce(item->>'author_name', 'Unknown Author'),
        nullif(item->>'author_id', ''),
        nullif(item->>'cover_url', ''),
        nullif(item->>'release_date', ''),
        coalesce(item->>'date_precision', 'unknown'),
        nullif(item->>'description', ''),
        case when item ? 'page_count' and item->>'page_count' is not null then (item->>'page_count')::integer else null end,
        nullif(item->>'isbn', ''),
        coalesce((item->>'is_one_off')::boolean, true),
        coalesce((item->>'is_manual')::boolean, true),
        coalesce((item->>'hidden')::boolean, false),
        coalesce(item->>'reading_status', 'none'),
        case when nullif(item->>'added_to_todo_at', '') is not null then (item->>'added_to_todo_at')::timestamptz else null end,
        nullif(item->>'finished_at', ''),
        case when item ? 'rating' and item->>'rating' is not null then (item->>'rating')::smallint else null end,
        nullif(item->>'notes', ''),
        nullif(item->>'vellum_book_id', ''),
        case when item ? 'vellum_progress' and item->>'vellum_progress' is not null then (item->>'vellum_progress')::double precision else null end,
        nullif(item->>'vellum_chapter', ''),
        case when nullif(item->>'vellum_last_read_at', '') is not null then (item->>'vellum_last_read_at')::timestamptz else null end,
        nullif(item->>'vellum_format', ''),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, synced_ts)
      )
      on conflict (user_id, id) do update set
        cover_url = coalesce(excluded.cover_url, public.tracked_books.cover_url),
        description = coalesce(excluded.description, public.tracked_books.description),
        hidden = excluded.hidden,
        reading_status = excluded.reading_status,
        added_to_todo_at = excluded.added_to_todo_at,
        finished_at = excluded.finished_at,
        rating = excluded.rating,
        notes = excluded.notes,
        vellum_book_id = coalesce(excluded.vellum_book_id, public.tracked_books.vellum_book_id),
        vellum_progress = coalesce(excluded.vellum_progress, public.tracked_books.vellum_progress),
        vellum_chapter = coalesce(excluded.vellum_chapter, public.tracked_books.vellum_chapter),
        vellum_last_read_at = coalesce(excluded.vellum_last_read_at, public.tracked_books.vellum_last_read_at),
        vellum_format = coalesce(excluded.vellum_format, public.tracked_books.vellum_format),
        updated_at = excluded.updated_at;
    end loop;
  end if;

  update public.vellum_bridge_tokens
  set last_sync_at = synced_ts,
      updated_at = synced_ts
  where user_id = matched_row.user_id;

  return synced_ts;
end;
$$;
