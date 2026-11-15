import {
  createClient,
  RealtimeChannel,
  SupabaseClient,
  User,
} from '@supabase/supabase-js';
import { mergeBookLists, mergeChallengeLists } from '@/lib/vellumBridge';
import {
  AppSettings,
  BookItem,
  DataSource,
  DatePrecision,
  FollowedAuthor,
  FriendChallengeStanding,
  FriendFinishedFeedItem,
  FriendGroup,
  ReadingChallenge,
  ReadingStatus,
  TrackerState,
  UserProfile,
} from '@/types/books';

export interface CloudConnectionConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface AuthSessionSnapshot {
  userId: string | null;
  email?: string;
  profile: UserProfile | null;
  includeAuthorBacklist?: boolean;
}

function normalizeSupabaseProjectUrl(raw?: string): string {
  return (raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
}

export function resolveCloudConfig(
  settings?: Partial<AppSettings>
): CloudConnectionConfig | null {
  const supabaseUrl = normalizeSupabaseProjectUrl(
    settings?.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  const supabaseAnonKey =
    settings?.supabaseAnonKey?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  return { supabaseUrl, supabaseAnonKey };
}

let cachedClientKey = '';
let cachedClient: SupabaseClient | null = null;

export function getSupabaseClient(config: CloudConnectionConfig): SupabaseClient {
  const key = `${config.supabaseUrl}::${config.supabaseAnonKey}`;
  if (cachedClient && cachedClientKey === key) {
    return cachedClient;
  }
  cachedClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  cachedClientKey = key;
  return cachedClient;
}

function defaultDisplayNameFromUser(user: User): string {
  const metaName =
    typeof user.user_metadata?.display_name === 'string'
      ? user.user_metadata.display_name.trim()
      : '';
  if (metaName) return metaName;

  const localPart = (user.email || 'Reader').split('@')[0] || 'Reader';
  return localPart
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

export async function ensureAndFetchUserProfile(
  config: CloudConnectionConfig,
  user: User
): Promise<UserProfile> {
  const supabase = getSupabaseClient(config);

  const { data: existing, error: fetchError } = await supabase
    .from('profiles')
    .select('id, display_name, avatar_url, share_activity')
    .eq('id', user.id)
    .maybeSingle();

  if (fetchError) {
    throw new Error(fetchError.message);
  }

  if (existing) {
    return {
      id: existing.id,
      email: user.email,
      displayName: existing.display_name || defaultDisplayNameFromUser(user),
      avatarUrl: existing.avatar_url ?? undefined,
      shareActivity: existing.share_activity ?? true,
    };
  }

  const fallbackName = defaultDisplayNameFromUser(user);
  const { data: inserted, error: insertError } = await supabase
    .from('profiles')
    .upsert(
      {
        id: user.id,
        display_name: fallbackName,
        share_activity: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    .select('id, display_name, avatar_url, share_activity')
    .single();

  if (insertError || !inserted) {
    return {
      id: user.id,
      email: user.email,
      displayName: fallbackName,
      shareActivity: true,
    };
  }

  return {
    id: inserted.id,
    email: user.email,
    displayName: inserted.display_name,
    avatarUrl: inserted.avatar_url ?? undefined,
    shareActivity: inserted.share_activity ?? true,
  };
}

function extractBacklistPref(user: User): boolean | undefined {
  const raw = user.user_metadata?.include_author_backlist;
  return typeof raw === 'boolean' ? raw : undefined;
}

export async function getCurrentSessionAndProfile(
  config: CloudConnectionConfig
): Promise<AuthSessionSnapshot> {
  const supabase = getSupabaseClient(config);
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.user) {
    return { userId: null, profile: null };
  }

  const profile = await ensureAndFetchUserProfile(config, session.user);
  return {
    userId: session.user.id,
    email: session.user.email,
    profile,
    includeAuthorBacklist: extractBacklistPref(session.user),
  };
}

export function subscribeToAuthChanges(
  config: CloudConnectionConfig,
  onChange: (snapshot: AuthSessionSnapshot) => void
): () => void {
  const supabase = getSupabaseClient(config);
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => {
    // Defer async Supabase queries outside the auth state lock
    setTimeout(async () => {
      if (!session?.user) {
        onChange({ userId: null, profile: null });
        return;
      }
      const includeAuthorBacklist = extractBacklistPref(session.user);
      try {
        const profile = await ensureAndFetchUserProfile(config, session.user);
        onChange({
          userId: session.user.id,
          email: session.user.email,
          profile,
          includeAuthorBacklist,
        });
      } catch {
        onChange({
          userId: session.user.id,
          email: session.user.email,
          profile: {
            id: session.user.id,
            email: session.user.email,
            displayName: defaultDisplayNameFromUser(session.user),
            shareActivity: true,
          },
          includeAuthorBacklist,
        });
      }
    }, 0);
  });

  return () => {
    subscription.unsubscribe();
  };
}

export async function sendMagicLink(
  config: CloudConnectionConfig,
  email: string,
  redirectTo: string,
  displayName?: string
): Promise<void> {
  const supabase = getSupabaseClient(config);
  const cleanEmail = email.trim();
  if (!cleanEmail) {
    throw new Error('Please enter your email address.');
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: {
      emailRedirectTo: redirectTo,
      data: displayName?.trim()
        ? { display_name: displayName.trim() }
        : undefined,
    },
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function signInWithEmailPassword(
  config: CloudConnectionConfig,
  email: string,
  password: string
): Promise<void> {
  const supabase = getSupabaseClient(config);
  const cleanEmail = email.trim();
  if (!cleanEmail || !password) {
    throw new Error('Please enter both your email and password.');
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function signUpWithEmailPassword(
  config: CloudConnectionConfig,
  email: string,
  password: string,
  redirectTo: string,
  displayName?: string
): Promise<{ signedInImmediately: boolean }> {
  const supabase = getSupabaseClient(config);
  const cleanEmail = email.trim();
  if (!cleanEmail) {
    throw new Error('Please enter your email address.');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      emailRedirectTo: redirectTo,
      data: displayName?.trim()
        ? { display_name: displayName.trim() }
        : undefined,
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  return { signedInImmediately: Boolean(data.session) };
}

export async function updateAccountPassword(
  config: CloudConnectionConfig,
  newPassword: string
): Promise<void> {
  if (newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const supabase = getSupabaseClient(config);
  const { error } = await supabase.auth.updateUser({
    password: newPassword,
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function signOutUser(config: CloudConnectionConfig): Promise<void> {
  resetCloudSyncFingerprints();
  const supabase = getSupabaseClient(config);
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(error.message);
  }
}

export async function updateUserProfile(
  config: CloudConnectionConfig,
  userId: string,
  updates: {
    displayName?: string;
    shareActivity?: boolean;
    avatarUrl?: string;
  },
  email?: string
): Promise<UserProfile> {
  const supabase = getSupabaseClient(config);
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.displayName !== undefined) {
    payload.display_name = updates.displayName.trim() || 'Reader';
  }
  if (updates.shareActivity !== undefined) {
    payload.share_activity = updates.shareActivity;
  }
  if (updates.avatarUrl !== undefined) {
    payload.avatar_url = updates.avatarUrl.trim() || null;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(payload)
    .eq('id', userId)
    .select('id, display_name, avatar_url, share_activity')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Failed to update profile');
  }

  return {
    id: data.id,
    email,
    displayName: data.display_name,
    avatarUrl: data.avatar_url ?? undefined,
    shareActivity: data.share_activity ?? true,
  };
}

// Slim column projection omits unused multi-megabyte `description` blurbs (~85% payload reduction)
const BOOK_SYNC_COLUMNS =
  'id,source,external_id,title,author_name,author_id,cover_url,release_date,date_precision,page_count,isbn,is_one_off,is_manual,hidden,reading_status,added_to_todo_at,finished_at,rating,notes,vellum_book_id,vellum_progress,vellum_chapter,vellum_last_read_at,vellum_format,updated_at';

const BOOK_SYNC_COLUMNS_NO_VELLUM =
  'id,source,external_id,title,author_name,author_id,cover_url,release_date,date_precision,page_count,isbn,is_one_off,is_manual,hidden,reading_status,added_to_todo_at,finished_at,rating,notes,updated_at';

let serverSupportsVellumCols = true;

interface UserCloudSyncCache {
  books: Map<string, string>;
  authors: Map<string, string>;
  challenges: Map<string, string>;
  lastSyncAnchorMs: number;
}

const userSyncCaches = new Map<string, UserCloudSyncCache>();

function getOrCreateUserSyncCache(userId: string): UserCloudSyncCache {
  let cache = userSyncCaches.get(userId);
  if (!cache) {
    cache = {
      books: new Map(),
      authors: new Map(),
      challenges: new Map(),
      lastSyncAnchorMs: 0,
    };
    userSyncCaches.set(userId, cache);
  }
  return cache;
}

export function resetCloudSyncFingerprints(userId?: string): void {
  if (userId) {
    userSyncCaches.delete(userId);
  } else {
    userSyncCaches.clear();
  }
}

const UPCOMING_GRADUATED_FORMAT_MARKER = 'folio:upcoming';

function resolvePersistedVellumFormat(b: BookItem): string {
  if (b.vellumBookId) {
    return b.vellumFormat ?? '';
  }
  return b.trackedFromUpcoming && !b.hidden
    ? UPCOMING_GRADUATED_FORMAT_MARKER
    : '';
}

function fingerprintBook(b: BookItem): string {
  const isManualCol = Boolean(
    b.userEdited || (b.isManual && b.id.startsWith('manual:book:'))
  );
  return [
    b.source,
    b.externalId ?? '',
    b.title,
    b.authorName,
    b.authorId ?? '',
    b.coverUrl ?? '',
    b.releaseDate ?? '',
    b.datePrecision,
    b.pageCount ?? '',
    b.isbn ?? '',
    b.isOneOff ? 1 : 0,
    isManualCol ? 1 : 0,
    b.hidden ? 1 : 0,
    b.readingStatus,
    b.addedToTodoAt ?? '',
    b.finishedAt ?? '',
    b.rating ?? '',
    b.notes ?? '',
    b.vellumBookId ?? '',
    typeof b.vellumProgress === 'number' ? b.vellumProgress : '',
    b.vellumChapter ?? '',
    b.vellumLastReadAt ?? '',
    resolvePersistedVellumFormat(b),
    b.updatedAt,
  ].join('\x1f');
}

function fingerprintAuthor(a: FollowedAuthor): string {
  return [
    a.source,
    a.externalId ?? '',
    a.name,
    a.imageUrl ?? '',
    a.bio ?? '',
    a.followedAt,
    a.lastSyncedAt ?? '',
    a.updatedAt,
  ].join('\x1f');
}

function fingerprintChallenge(c: ReadingChallenge): string {
  return [c.year, c.goalCount, c.title, c.createdAt, c.updatedAt].join('\x1f');
}

export function hasDirtyCloudState(
  userId: string,
  state: TrackerState
): boolean {
  const cache = userSyncCaches.get(userId);
  if (!cache) {
    return (
      state.books.length > 0 ||
      state.authors.length > 0 ||
      state.challenges.length > 0
    );
  }
  for (const a of state.authors) {
    if (cache.authors.get(a.id) !== fingerprintAuthor(a)) return true;
  }
  for (const b of state.books) {
    if (cache.books.get(b.id) !== fingerprintBook(b)) return true;
  }
  for (const c of state.challenges) {
    if (cache.challenges.get(c.id) !== fingerprintChallenge(c)) return true;
  }
  return false;
}

const CLIENT_INSTANCE_ID = `folio-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;

export interface CloudSyncBroadcastPayload {
  senderId?: string;
  ts?: number;
  changedBookIds?: string[];
  changedAuthorIds?: string[];
  changedChallengeIds?: string[];
  deletedBookIds?: string[];
  deletedAuthorIds?: string[];
  deletedChallengeIds?: string[];
  includeAuthorBacklist?: boolean;
}

interface ManagedBroadcastEntry {
  userId: string;
  clientKey: string;
  channel: RealtimeChannel;
  listeners: Set<(payload: CloudSyncBroadcastPayload) => void>;
}

let activeBroadcastEntry: ManagedBroadcastEntry | null = null;

function ensureBroadcastEntry(
  config: CloudConnectionConfig,
  userId: string
): ManagedBroadcastEntry {
  const supabase = getSupabaseClient(config);
  const clientKey = `${config.supabaseUrl}::${config.supabaseAnonKey}`;

  if (
    activeBroadcastEntry &&
    activeBroadcastEntry.userId === userId &&
    activeBroadcastEntry.clientKey === clientKey
  ) {
    return activeBroadcastEntry;
  }

  if (activeBroadcastEntry) {
    try {
      supabase.removeChannel(activeBroadcastEntry.channel).catch(() => {});
    } catch {}
    activeBroadcastEntry = null;
  }

  const listeners = new Set<(payload: CloudSyncBroadcastPayload) => void>();
  const channel = supabase.channel(`folio-sync:${userId}`, {
    config: {
      broadcast: { self: false },
    },
  });

  channel
    .on('broadcast', { event: 'ledger-mutated' }, (msg) => {
      const payload = (msg?.payload || {}) as CloudSyncBroadcastPayload;
      if (payload.senderId && payload.senderId === CLIENT_INSTANCE_ID) return;
      for (const listener of Array.from(listeners)) {
        try {
          listener(payload);
        } catch {}
      }
    })
    .subscribe();

  activeBroadcastEntry = { userId, clientKey, channel, listeners };
  return activeBroadcastEntry;
}

export function subscribeToCloudSyncBroadcast(
  config: CloudConnectionConfig,
  userId: string,
  onMutation: (payload: CloudSyncBroadcastPayload) => void
): () => void {
  const entry = ensureBroadcastEntry(config, userId);
  entry.listeners.add(onMutation);

  return () => {
    entry.listeners.delete(onMutation);
    if (entry.listeners.size === 0 && activeBroadcastEntry === entry) {
      const supabase = getSupabaseClient(config);
      activeBroadcastEntry = null;
      try {
        supabase.removeChannel(entry.channel).catch(() => {});
      } catch {}
    }
  };
}

function broadcastCloudMutation(
  config: CloudConnectionConfig,
  userId: string,
  payload: Omit<CloudSyncBroadcastPayload, 'senderId' | 'ts'>
): void {
  try {
    const entry = ensureBroadcastEntry(config, userId);
    entry.channel
      .send({
        type: 'broadcast',
        event: 'ledger-mutated',
        payload: {
          ...payload,
          senderId: CLIENT_INSTANCE_ID,
          ts: Date.now(),
        },
      })
      .catch(() => {});
  } catch {}
}

export async function syncCloudSettingsPreference(
  config: CloudConnectionConfig,
  userId: string,
  prefs: { includeAuthorBacklist: boolean }
): Promise<void> {
  const supabase = getSupabaseClient(config);
  await supabase.auth
    .updateUser({
      data: {
        include_author_backlist: Boolean(prefs.includeAuthorBacklist),
      },
    })
    .catch(() => {});
  broadcastCloudMutation(config, userId, {
    includeAuthorBacklist: Boolean(prefs.includeAuthorBacklist),
  });
}

async function fetchAllPaginatedRows<TRow>(
  buildPageQuery: (
    from: number,
    to: number,
    withExactCount?: boolean
  ) => PromiseLike<{
    data: TRow[] | null;
    count?: number | null;
    error: { message: string } | null;
  }>
): Promise<TRow[]> {
  const pageSize = 1000;
  const maxPages = 30;

  const firstRes = await buildPageQuery(0, pageSize - 1, true);
  if (firstRes.error) throw new Error(firstRes.error.message);
  const firstRows = firstRes.data || [];
  if (firstRows.length < pageSize) {
    return firstRows;
  }

  const all: TRow[] = [...firstRows];

  if (typeof firstRes.count === 'number' && firstRes.count > pageSize) {
    const totalPages = Math.min(maxPages, Math.ceil(firstRes.count / pageSize));
    const remainingPages: number[] = [];
    for (let page = 1; page < totalPages; page++) {
      remainingPages.push(page);
    }
    const maxConcurrency = 4;
    for (let i = 0; i < remainingPages.length; i += maxConcurrency) {
      const batch = remainingPages.slice(i, i + maxConcurrency);
      const batchResults = await Promise.all(
        batch.map(async (page) => {
          const from = page * pageSize;
          const to = from + pageSize - 1;
          const { data, error } = await buildPageQuery(from, to, false);
          if (error) throw new Error(error.message);
          return data || [];
        })
      );
      for (const rows of batchResults) {
        all.push(...rows);
      }
    }
    return all;
  }

  for (let page = 1; page < maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await buildPageQuery(from, to, false);
    if (error) throw new Error(error.message);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }

  return all;
}

async function fetchTrackedBookRowsWithFallback(
  supabase: SupabaseClient,
  userId: string,
  options?: { updatedSinceIso?: string }
): Promise<Record<string, any>[]> {
  const runWithCols = (cols: string) =>
    fetchAllPaginatedRows<Record<string, any>>((from, to, withExactCount) => {
      let query = supabase
        .from('tracked_books')
        .select(cols, withExactCount ? { count: 'exact' } : undefined)
        .eq('user_id', userId);
      if (options?.updatedSinceIso) {
        query = query.gte('updated_at', options.updatedSinceIso);
      }
      return query.order('id', { ascending: true }).range(from, to);
    });

  const preferredCols = serverSupportsVellumCols
    ? BOOK_SYNC_COLUMNS
    : BOOK_SYNC_COLUMNS_NO_VELLUM;

  try {
    return await runWithCols(preferredCols);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (serverSupportsVellumCols && /vellum_/i.test(msg)) {
      serverSupportsVellumCols = false;
      return await runWithCols(BOOK_SYNC_COLUMNS_NO_VELLUM);
    }
    throw err;
  }
}

function mapAuthorRow(row: Record<string, any>): FollowedAuthor {
  return {
    id: row.id,
    source: row.source as DataSource,
    externalId: row.external_id ?? undefined,
    name: row.name,
    imageUrl: row.image_url ?? undefined,
    bio: row.bio ?? undefined,
    followedAt: row.followed_at,
    lastSyncedAt: row.last_synced_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapBookRow(row: Record<string, any>): BookItem {
  const rawVellumFmt =
    typeof row.vellum_format === 'string' ? row.vellum_format : undefined;
  const isHidden = Boolean(row.hidden);
  const trackedFromUpcoming =
    !isHidden &&
    (Boolean(row.tracked_from_upcoming) ||
      rawVellumFmt === UPCOMING_GRADUATED_FORMAT_MARKER)
      ? true
      : undefined;
  const vellumFormat =
    rawVellumFmt === UPCOMING_GRADUATED_FORMAT_MARKER
      ? undefined
      : rawVellumFmt;

  return {
    id: row.id,
    source: row.source as DataSource,
    externalId: row.external_id ?? undefined,
    title: row.title,
    authorName: row.author_name,
    authorId: row.author_id ?? undefined,
    coverUrl: row.cover_url ?? undefined,
    releaseDate: row.release_date ?? undefined,
    datePrecision: (row.date_precision || 'unknown') as DatePrecision,
    pageCount: row.page_count ?? undefined,
    isbn: row.isbn ?? undefined,
    isOneOff: Boolean(row.is_one_off),
    isManual: Boolean(row.is_manual),
    userEdited:
      row.is_manual &&
      !String(row.id || '').startsWith('vellum:') &&
      !String(row.id || '').startsWith('manual:batch:')
        ? true
        : undefined,
    trackedFromUpcoming,
    hidden: isHidden,
    readingStatus: (row.reading_status || 'none') as ReadingStatus,
    addedToTodoAt: row.added_to_todo_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    rating: row.rating ?? undefined,
    notes: row.notes ?? undefined,
    vellumBookId: row.vellum_book_id ?? undefined,
    vellumProgress:
      typeof row.vellum_progress === 'number' ? row.vellum_progress : undefined,
    vellumChapter: row.vellum_chapter ?? undefined,
    vellumLastReadAt: row.vellum_last_read_at ?? undefined,
    vellumFormat,
    updatedAt: row.updated_at,
  };
}

function mapChallengeRow(row: Record<string, any>): ReadingChallenge {
  return {
    id: row.id,
    year: row.year,
    goalCount: row.goal_count,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function pullCloudState(
  config: CloudConnectionConfig,
  userId: string
): Promise<TrackerState> {
  const supabase = getSupabaseClient(config);
  const pullStartedMs = Date.now();

  // Paginate past PostgREST's 1,000-row default cap in parallel across pages
  // while omitting unused multi-MB book descriptions.
  const [authorRows, bookRows, challengesRes] = await Promise.all([
    fetchAllPaginatedRows<Record<string, any>>((from, to, withExactCount) =>
      supabase
        .from('followed_authors')
        .select('*', withExactCount ? { count: 'exact' } : undefined)
        .eq('user_id', userId)
        .order('id', { ascending: true })
        .range(from, to)
    ),
    fetchTrackedBookRowsWithFallback(supabase, userId),
    supabase.from('reading_challenges').select('*').eq('user_id', userId),
  ]);

  if (challengesRes.error) throw new Error(challengesRes.error.message);

  const authors = authorRows.map(mapAuthorRow);
  const books = bookRows.map(mapBookRow);
  const challenges = (challengesRes.data || []).map(mapChallengeRow);

  const cache = getOrCreateUserSyncCache(userId);
  cache.authors.clear();
  for (const a of authors) cache.authors.set(a.id, fingerprintAuthor(a));
  cache.books.clear();
  for (const b of books) cache.books.set(b.id, fingerprintBook(b));
  cache.challenges.clear();
  for (const c of challenges) {
    cache.challenges.set(c.id, fingerprintChallenge(c));
  }
  cache.lastSyncAnchorMs = pullStartedMs;

  return { authors, books, challenges };
}

export interface CloudDeltaResult {
  authors: FollowedAuthor[];
  books: BookItem[];
  challenges: ReadingChallenge[];
  remoteAuthorIds?: Set<string>;
  remoteBookIds?: Set<string>;
  remoteChallengeIds?: Set<string>;
}

export async function pullCloudDelta(
  config: CloudConnectionConfig,
  userId: string,
  options?: {
    explicitBookIds?: string[];
    explicitAuthorIds?: string[];
    includeIdManifest?: boolean;
  }
): Promise<CloudDeltaResult> {
  const supabase = getSupabaseClient(config);
  const cache = getOrCreateUserSyncCache(userId);
  const pullStartedMs = Date.now();
  const baseAnchorMs =
    cache.lastSyncAnchorMs > 0
      ? cache.lastSyncAnchorMs
      : pullStartedMs - 5 * 60 * 1000;
  // 2-minute clock-skew buffer guarantees edits from slightly behind device clocks are never missed
  const bufferedSinceIso = new Date(
    Math.max(0, baseAnchorMs - 120_000)
  ).toISOString();

  const explicitBookIds = Array.from(
    new Set((options?.explicitBookIds || []).filter(Boolean))
  ).slice(0, 60);
  const explicitAuthorIds = Array.from(
    new Set((options?.explicitAuthorIds || []).filter(Boolean))
  ).slice(0, 60);

  const fetchExplicitBooksPromise =
    explicitBookIds.length > 0
      ? (async () => {
          const cols = serverSupportsVellumCols
            ? BOOK_SYNC_COLUMNS
            : BOOK_SYNC_COLUMNS_NO_VELLUM;
          const res = await supabase
            .from('tracked_books')
            .select(cols)
            .eq('user_id', userId)
            .in('id', explicitBookIds);
          if (res.error) {
            if (serverSupportsVellumCols && /vellum_/i.test(res.error.message)) {
              serverSupportsVellumCols = false;
              const fallback = await supabase
                .from('tracked_books')
                .select(BOOK_SYNC_COLUMNS_NO_VELLUM)
                .eq('user_id', userId)
                .in('id', explicitBookIds);
              if (fallback.error) throw new Error(fallback.error.message);
              return (fallback.data || []) as Record<string, any>[];
            }
            throw new Error(res.error.message);
          }
          return (res.data || []) as Record<string, any>[];
        })()
      : Promise.resolve([] as Record<string, any>[]);

  const fetchExplicitAuthorsPromise =
    explicitAuthorIds.length > 0
      ? supabase
          .from('followed_authors')
          .select('*')
          .eq('user_id', userId)
          .in('id', explicitAuthorIds)
          .then((res) => {
            if (res.error) throw new Error(res.error.message);
            return (res.data || []) as Record<string, any>[];
          })
      : Promise.resolve([] as Record<string, any>[]);

  const manifestPromise = options?.includeIdManifest
    ? Promise.all([
        fetchAllPaginatedRows<{ id: string }>((from, to, withExactCount) =>
          supabase
            .from('followed_authors')
            .select('id', withExactCount ? { count: 'exact' } : undefined)
            .eq('user_id', userId)
            .order('id', { ascending: true })
            .range(from, to)
        ),
        fetchAllPaginatedRows<{ id: string }>((from, to, withExactCount) =>
          supabase
            .from('tracked_books')
            .select('id', withExactCount ? { count: 'exact' } : undefined)
            .eq('user_id', userId)
            .order('id', { ascending: true })
            .range(from, to)
        ),
        supabase.from('reading_challenges').select('id').eq('user_id', userId),
      ])
    : Promise.resolve(null);

  const [
    sinceAuthorRows,
    explicitAuthorRows,
    sinceBookRows,
    explicitBookRows,
    challengesRes,
    manifestRes,
  ] = await Promise.all([
    fetchAllPaginatedRows<Record<string, any>>((from, to, withExactCount) =>
      supabase
        .from('followed_authors')
        .select('*', withExactCount ? { count: 'exact' } : undefined)
        .eq('user_id', userId)
        .gte('updated_at', bufferedSinceIso)
        .order('id', { ascending: true })
        .range(from, to)
    ),
    fetchExplicitAuthorsPromise,
    fetchTrackedBookRowsWithFallback(supabase, userId, {
      updatedSinceIso: bufferedSinceIso,
    }),
    fetchExplicitBooksPromise,
    supabase
      .from('reading_challenges')
      .select('*')
      .eq('user_id', userId)
      .gte('updated_at', bufferedSinceIso),
    manifestPromise,
  ]);

  if (challengesRes.error) throw new Error(challengesRes.error.message);

  const authorRowMap = new Map<string, Record<string, any>>();
  for (const r of sinceAuthorRows) authorRowMap.set(r.id, r);
  for (const r of explicitAuthorRows) authorRowMap.set(r.id, r);

  const bookRowMap = new Map<string, Record<string, any>>();
  for (const r of sinceBookRows) bookRowMap.set(r.id, r);
  for (const r of explicitBookRows) bookRowMap.set(r.id, r);

  const authors = Array.from(authorRowMap.values()).map(mapAuthorRow);
  const books = Array.from(bookRowMap.values()).map(mapBookRow);
  const challenges = (challengesRes.data || []).map(mapChallengeRow);

  for (const a of authors) cache.authors.set(a.id, fingerprintAuthor(a));
  for (const b of books) cache.books.set(b.id, fingerprintBook(b));
  for (const c of challenges) {
    cache.challenges.set(c.id, fingerprintChallenge(c));
  }
  cache.lastSyncAnchorMs = pullStartedMs;

  let remoteAuthorIds: Set<string> | undefined;
  let remoteBookIds: Set<string> | undefined;
  let remoteChallengeIds: Set<string> | undefined;

  if (manifestRes) {
    const [authorIdsRows, bookIdsRows, challengeIdsRes] = manifestRes;
    remoteAuthorIds = new Set(authorIdsRows.map((r) => r.id));
    remoteBookIds = new Set(bookIdsRows.map((r) => r.id));
    if (!challengeIdsRes.error && challengeIdsRes.data) {
      remoteChallengeIds = new Set(challengeIdsRes.data.map((r) => r.id));
    }
    for (const id of Array.from(cache.authors.keys())) {
      if (!remoteAuthorIds.has(id)) cache.authors.delete(id);
    }
    for (const id of Array.from(cache.books.keys())) {
      if (!remoteBookIds.has(id)) cache.books.delete(id);
    }
    if (remoteChallengeIds) {
      for (const id of Array.from(cache.challenges.keys())) {
        if (!remoteChallengeIds.has(id)) cache.challenges.delete(id);
      }
    }
  }

  return {
    authors,
    books,
    challenges,
    remoteAuthorIds,
    remoteBookIds,
    remoteChallengeIds,
  };
}

export async function upsertCloudBooks(
  config: CloudConnectionConfig,
  userId: string,
  books: BookItem[],
  options?: { skipBroadcast?: boolean }
): Promise<void> {
  if (books.length === 0) return;
  const supabase = getSupabaseClient(config);
  const cache = getOrCreateUserSyncCache(userId);
  const chunkSize = 250;
  const maxConcurrency = 3;

  const slices: BookItem[][] = [];
  for (let i = 0; i < books.length; i += chunkSize) {
    slices.push(books.slice(i, i + chunkSize));
  }

  const upsertSlice = async (slice: BookItem[]) => {
    const buildRows = (includeVellum: boolean) =>
      slice.map((b) => {
        const base: Record<string, unknown> = {
          user_id: userId,
          id: b.id,
          source: b.source,
          external_id: b.externalId ?? null,
          title: b.title,
          author_name: b.authorName,
          author_id: b.authorId ?? null,
          cover_url: b.coverUrl ?? null,
          release_date: b.releaseDate ?? null,
          date_precision: b.datePrecision,
          page_count: b.pageCount ?? null,
          isbn: b.isbn ?? null,
          is_one_off: b.isOneOff,
          is_manual: Boolean(
            b.userEdited || (b.isManual && b.id.startsWith('manual:book:'))
          ),
          hidden: Boolean(b.hidden),
          reading_status: b.readingStatus,
          added_to_todo_at: b.addedToTodoAt ?? null,
          finished_at: b.finishedAt ?? null,
          rating: b.rating ?? null,
          notes: b.notes ?? null,
          updated_at: b.updatedAt,
        };
        if (includeVellum) {
          const persistedFormat = resolvePersistedVellumFormat(b);
          base.vellum_book_id = b.vellumBookId ?? null;
          base.vellum_progress =
            typeof b.vellumProgress === 'number' ? b.vellumProgress : null;
          base.vellum_chapter = b.vellumChapter ?? null;
          base.vellum_last_read_at = b.vellumLastReadAt ?? null;
          base.vellum_format = persistedFormat || null;
        }
        return base;
      });

    const { error } = await supabase
      .from('tracked_books')
      .upsert(buildRows(serverSupportsVellumCols), {
        onConflict: 'user_id,id',
      });
    if (error) {
      if (serverSupportsVellumCols && /vellum_/i.test(error.message)) {
        serverSupportsVellumCols = false;
        const { error: fallbackErr } = await supabase
          .from('tracked_books')
          .upsert(buildRows(false), { onConflict: 'user_id,id' });
        if (fallbackErr) throw new Error(fallbackErr.message);
      } else {
        throw new Error(error.message);
      }
    }

    for (const b of slice) {
      cache.books.set(b.id, fingerprintBook(b));
    }
  };

  for (let i = 0; i < slices.length; i += maxConcurrency) {
    const batch = slices.slice(i, i + maxConcurrency);
    await Promise.all(batch.map(upsertSlice));
  }

  if (!options?.skipBroadcast) {
    broadcastCloudMutation(config, userId, {
      changedBookIds: books.length <= 40 ? books.map((b) => b.id) : undefined,
    });
  }
}

export async function pushFullStateToCloud(
  config: CloudConnectionConfig,
  userId: string,
  state: TrackerState
): Promise<void> {
  const supabase = getSupabaseClient(config);
  const cache = getOrCreateUserSyncCache(userId);

  const dirtyAuthors = state.authors.filter(
    (a) => cache.authors.get(a.id) !== fingerprintAuthor(a)
  );
  const dirtyBooks = state.books.filter(
    (b) => cache.books.get(b.id) !== fingerprintBook(b)
  );
  const dirtyChallenges = state.challenges.filter(
    (c) => cache.challenges.get(c.id) !== fingerprintChallenge(c)
  );

  if (
    dirtyAuthors.length === 0 &&
    dirtyBooks.length === 0 &&
    dirtyChallenges.length === 0
  ) {
    return;
  }

  // Ensure followed_authors exist before books referencing author_id if any dirty authors exist
  if (dirtyAuthors.length > 0) {
    const authorRows = dirtyAuthors.map((a) => ({
      user_id: userId,
      id: a.id,
      source: a.source,
      external_id: a.externalId ?? null,
      name: a.name,
      image_url: a.imageUrl ?? null,
      bio: a.bio ?? null,
      followed_at: a.followedAt,
      last_synced_at: a.lastSyncedAt ?? null,
      updated_at: a.updatedAt,
    }));
    const { error } = await supabase
      .from('followed_authors')
      .upsert(authorRows, { onConflict: 'user_id,id' });
    if (error) throw new Error(error.message);
    for (const a of dirtyAuthors) {
      cache.authors.set(a.id, fingerprintAuthor(a));
    }
  }

  await Promise.all([
    dirtyBooks.length > 0
      ? upsertCloudBooks(config, userId, dirtyBooks, { skipBroadcast: true })
      : Promise.resolve(),
    dirtyChallenges.length > 0
      ? (async () => {
          const challengeRows = dirtyChallenges.map((c) => ({
            user_id: userId,
            id: c.id,
            year: c.year,
            goal_count: c.goalCount,
            title: c.title,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          }));
          const { error } = await supabase
            .from('reading_challenges')
            .upsert(challengeRows, { onConflict: 'user_id,id' });
          if (error) throw new Error(error.message);
          for (const c of dirtyChallenges) {
            cache.challenges.set(c.id, fingerprintChallenge(c));
          }
        })()
      : Promise.resolve(),
  ]);

  broadcastCloudMutation(config, userId, {
    changedAuthorIds:
      dirtyAuthors.length > 0 && dirtyAuthors.length <= 40
        ? dirtyAuthors.map((a) => a.id)
        : undefined,
    changedBookIds:
      dirtyBooks.length > 0 && dirtyBooks.length <= 40
        ? dirtyBooks.map((b) => b.id)
        : undefined,
    changedChallengeIds:
      dirtyChallenges.length > 0
        ? dirtyChallenges.map((c) => c.id)
        : undefined,
  });
}

export async function deleteCloudRecords(
  config: CloudConnectionConfig,
  userId: string,
  table: 'followed_authors' | 'tracked_books' | 'reading_challenges',
  ids: string[]
): Promise<void> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return;
  const supabase = getSupabaseClient(config);
  const cache = getOrCreateUserSyncCache(userId);
  const chunkSize = 75;
  const maxConcurrency = 3;

  const slices: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    slices.push(uniqueIds.slice(i, i + chunkSize));
  }

  for (let i = 0; i < slices.length; i += maxConcurrency) {
    const batch = slices.slice(i, i + maxConcurrency);
    await Promise.all(
      batch.map(async (slice) => {
        const { error } = await supabase
          .from(table)
          .delete()
          .eq('user_id', userId)
          .in('id', slice);
        if (error) throw new Error(error.message);
      })
    );
  }

  const cacheMap =
    table === 'followed_authors'
      ? cache.authors
      : table === 'tracked_books'
        ? cache.books
        : cache.challenges;
  for (const id of uniqueIds) {
    cacheMap.delete(id);
  }

  const cappedIds = uniqueIds.length <= 80 ? uniqueIds : undefined;
  broadcastCloudMutation(config, userId, {
    deletedAuthorIds: table === 'followed_authors' ? cappedIds : undefined,
    deletedBookIds: table === 'tracked_books' ? cappedIds : undefined,
    deletedChallengeIds: table === 'reading_challenges' ? cappedIds : undefined,
  });
}

export function mergeLocalAndCloudState(
  local: TrackerState,
  cloud: TrackerState,
  options?: { preferCloudDeletions?: boolean }
): TrackerState {
  const preferCloudDeletions = Boolean(options?.preferCloudDeletions);
  const recentGraceCutoffMs = Date.now() - 2 * 60 * 1000;

  const cloudAuthorIds = new Set(cloud.authors.map((a) => a.id));
  const filteredLocalAuthors =
    preferCloudDeletions && cloud.authors.length > 0
      ? local.authors.filter((a) => {
          if (cloudAuthorIds.has(a.id)) return true;
          const ts = Date.parse(a.updatedAt || a.followedAt || '') || 0;
          return ts >= recentGraceCutoffMs;
        })
      : local.authors;

  const cloudBookIds = new Set(cloud.books.map((b) => b.id));
  const filteredLocalBooks =
    preferCloudDeletions && cloud.books.length > 0
      ? local.books.filter((b) => {
          if (cloudBookIds.has(b.id)) return true;
          const hasUserEngagement =
            b.readingStatus !== 'none' ||
            Boolean(
              b.isOneOff ||
                b.isManual ||
                b.userEdited ||
                b.trackedFromUpcoming ||
                b.hidden ||
                b.rating ||
                b.notes ||
                b.vellumBookId
            );
          if (hasUserEngagement) return true;
          const ts = Date.parse(b.updatedAt || '') || 0;
          return ts >= recentGraceCutoffMs;
        })
      : local.books;

  const mergeById = <T extends { id: string; updatedAt: string }>(
    a: T[],
    b: T[]
  ): T[] => {
    const map = new Map<string, T>();
    for (const item of a) map.set(item.id, item);
    for (const item of b) {
      const existing = map.get(item.id);
      if (!existing || item.updatedAt >= existing.updatedAt) {
        map.set(item.id, item);
      }
    }
    return Array.from(map.values());
  };

  return {
    authors: mergeById(filteredLocalAuthors, cloud.authors),
    books: mergeBookLists(filteredLocalBooks, cloud.books),
    challenges: mergeChallengeLists(local.challenges, cloud.challenges),
  };
}

export async function fetchOrRotateVellumBridgeToken(
  config: CloudConnectionConfig,
  rotate = false
): Promise<string> {
  const supabase = getSupabaseClient(config);
  const { data, error } = await supabase.rpc(
    'get_or_create_vellum_bridge_token',
    { rotate_existing: rotate }
  );
  if (error) {
    throw new Error(error.message);
  }
  return String(data || '');
}

// --- Invite-Code Friend Groups & Shared Activity Feed ---

export async function fetchUserFriendGroups(
  config: CloudConnectionConfig
): Promise<FriendGroup[]> {
  const supabase = getSupabaseClient(config);

  const { data: groupsData, error: groupsErr } = await supabase
    .from('friend_groups')
    .select('id, name, invite_code, created_by, created_at')
    .order('created_at', { ascending: true });

  if (groupsErr) {
    throw new Error(groupsErr.message);
  }

  const groups = groupsData || [];
  if (groups.length === 0) {
    return [];
  }

  const groupIds = groups.map((g) => g.id);
  const { data: membersData } = await supabase
    .from('friend_group_members')
    .select('group_id, user_id')
    .in('group_id', groupIds);

  const countByGroup = new Map<string, number>();
  for (const m of membersData || []) {
    countByGroup.set(m.group_id, (countByGroup.get(m.group_id) || 0) + 1);
  }

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    inviteCode: g.invite_code,
    createdBy: g.created_by,
    createdAt: g.created_at,
    memberCount: countByGroup.get(g.id) || 1,
  }));
}

export async function createFriendGroup(
  config: CloudConnectionConfig,
  name: string
): Promise<FriendGroup> {
  const supabase = getSupabaseClient(config);
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error('Please enter a group name.');
  }

  const { data, error } = await supabase.rpc('create_friend_group', {
    group_name: cleanName,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Could not create group.');
  }

  return {
    id: data.id,
    name: data.name,
    inviteCode: data.invite_code,
    createdBy: data.created_by,
    createdAt: data.created_at,
    memberCount: 1,
  };
}

export async function joinFriendGroupByCode(
  config: CloudConnectionConfig,
  inviteCode: string
): Promise<FriendGroup> {
  const supabase = getSupabaseClient(config);
  const cleanCode = inviteCode.trim().toUpperCase();
  if (!cleanCode) {
    throw new Error('Please enter a 6-character invite code.');
  }

  const { data, error } = await supabase.rpc('join_group_by_code', {
    invite_code_input: cleanCode,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Invalid invite code.');
  }

  return {
    id: data.id,
    name: data.name,
    inviteCode: data.invite_code,
    createdBy: data.created_by,
    createdAt: data.created_at,
  };
}

export async function leaveFriendGroup(
  config: CloudConnectionConfig,
  groupId: string,
  userId: string
): Promise<void> {
  const supabase = getSupabaseClient(config);
  const { error } = await supabase
    .from('friend_group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', userId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function fetchGroupFeedAndStandings(
  config: CloudConnectionConfig,
  groupId: string,
  year: number,
  currentUserId: string
): Promise<{
  standings: FriendChallengeStanding[];
  feed: FriendFinishedFeedItem[];
}> {
  const supabase = getSupabaseClient(config);

  const { data: membersRows, error: membersErr } = await supabase
    .from('friend_group_members')
    .select('user_id, joined_at')
    .eq('group_id', groupId);

  if (membersErr) {
    throw new Error(membersErr.message);
  }

  const memberIds = Array.from(
    new Set((membersRows || []).map((m) => m.user_id))
  );

  if (memberIds.length === 0) {
    return { standings: [], feed: [] };
  }

  const [profilesRes, challengesRes, allReadRows] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, avatar_url, share_activity')
      .in('id', memberIds),
    supabase
      .from('reading_challenges')
      .select('*')
      .in('user_id', memberIds)
      .eq('year', year),
    fetchAllPaginatedRows<Record<string, any>>((from, to, withExactCount) =>
      supabase
        .from('tracked_books')
        .select(
          'id,user_id,source,external_id,title,author_name,cover_url,release_date,date_precision,finished_at,rating,notes,updated_at',
          withExactCount ? { count: 'exact' } : undefined
        )
        .in('user_id', memberIds)
        .eq('reading_status', 'read')
        .eq('hidden', false)
        .order('user_id', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    ),
  ]);

  if (profilesRes.error) throw new Error(profilesRes.error.message);
  if (challengesRes.error) throw new Error(challengesRes.error.message);

  const profileById = new Map<
    string,
    { displayName: string; avatarUrl?: string; shareActivity: boolean }
  >();
  for (const p of profilesRes.data || []) {
    profileById.set(p.id, {
      displayName: p.display_name || 'Reader',
      avatarUrl: p.avatar_url ?? undefined,
      shareActivity: p.share_activity ?? true,
    });
  }

  const challengeByUserId = new Map<
    string,
    { goalCount: number; title: string }
  >();
  for (const c of challengesRes.data || []) {
    challengeByUserId.set(c.user_id, {
      goalCount: c.goal_count,
      title: c.title,
    });
  }

  const yearPrefix = `${year}`;

  // Build Yearly Reading Challenge Standings per group member
  const standings: FriendChallengeStanding[] = memberIds.map((uid) => {
    const prof = profileById.get(uid) || {
      displayName: uid === currentUserId ? 'You' : 'Group Member',
      shareActivity: true,
    };
    const challenge = challengeByUserId.get(uid);

    const memberYearBooks = allReadRows
      .filter(
        (b) =>
          b.user_id === uid &&
          typeof b.finished_at === 'string' &&
          b.finished_at.startsWith(yearPrefix)
      )
      .sort((a, b) => {
        const da = a.finished_at || '';
        const db = b.finished_at || '';
        if (da !== db) return db.localeCompare(da);
        return String(b.updated_at || '').localeCompare(
          String(a.updated_at || '')
        );
      });

    return {
      userId: uid,
      displayName: prof.displayName,
      avatarUrl: prof.avatarUrl,
      isCurrentUser: uid === currentUserId,
      shareActivity: prof.shareActivity,
      year,
      goalCount: challenge?.goalCount,
      challengeTitle: challenge?.title,
      booksReadCount: memberYearBooks.length,
      recentCovers: memberYearBooks.slice(0, 5).map((b) => ({
        id: b.id,
        title: b.title,
        authorName: b.author_name,
        coverUrl: b.cover_url ?? undefined,
      })),
    };
  });

  standings.sort((a, b) => {
    if (a.shareActivity !== b.shareActivity) {
      return a.shareActivity ? -1 : 1;
    }
    if (b.booksReadCount !== a.booksReadCount) {
      return b.booksReadCount - a.booksReadCount;
    }
    const pctA = a.goalCount ? a.booksReadCount / a.goalCount : 0;
    const pctB = b.goalCount ? b.booksReadCount / b.goalCount : 0;
    if (pctB !== pctA) return pctB - pctA;
    return a.displayName.localeCompare(b.displayName);
  });

  // Build Reverse-Chronological Finished Books, Ratings & Reviews Feed
  const visibleFeedRows = allReadRows.filter((row) => {
    const prof = profileById.get(row.user_id);
    if (!prof) return true;
    return prof.shareActivity || row.user_id === currentUserId;
  });

  visibleFeedRows.sort((a, b) => {
    const sortDateA = a.finished_at || String(a.updated_at || '').slice(0, 10);
    const sortDateB = b.finished_at || String(b.updated_at || '').slice(0, 10);
    if (sortDateA !== sortDateB) {
      return sortDateB.localeCompare(sortDateA);
    }
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });

  const feed: FriendFinishedFeedItem[] = visibleFeedRows
    .slice(0, 80)
    .map((row) => {
      const prof = profileById.get(row.user_id);
      return {
        bookId: row.id,
        userId: row.user_id,
        userDisplayName:
          prof?.displayName ||
          (row.user_id === currentUserId ? 'You' : 'Friend'),
        userAvatarUrl: prof?.avatarUrl,
        isCurrentUser: row.user_id === currentUserId,
        source: (row.source || 'manual') as DataSource,
        externalId: row.external_id ?? undefined,
        title: row.title,
        authorName: row.author_name,
        coverUrl: row.cover_url ?? undefined,
        releaseDate: row.release_date ?? undefined,
        datePrecision: (row.date_precision || 'unknown') as DatePrecision,
        finishedAt: row.finished_at ?? undefined,
        rating: row.rating ?? undefined,
        notes: row.notes ?? undefined,
        updatedAt: row.updated_at,
      };
    });

  return { standings, feed };
}
