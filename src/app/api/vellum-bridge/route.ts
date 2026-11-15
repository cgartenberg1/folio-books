import { NextRequest, NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  applyVellumSyncToBooks,
  mergeBookLists,
  mergeChallengeLists,
  VellumBridgeLedger,
  VellumStatusMutation,
  VellumSyncBookPayload,
} from '@/lib/vellumBridge';
import {
  BookItem,
  DataSource,
  DatePrecision,
  ReadingChallenge,
  ReadingStatus,
} from '@/types/books';

export const dynamic = 'force-dynamic';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-folio-bridge-token',
};

function isHostedServerlessEnv(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.NETLIFY ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.FLY_APP_NAME
  );
}

function resolveDataDir(): string {
  const cwd = process.cwd();
  const nestedProject = path.join(cwd, 'BookReleaseTracker');
  if (
    path.basename(cwd) !== 'BookReleaseTracker' &&
    existsSync(path.join(nestedProject, 'package.json'))
  ) {
    return path.join(nestedProject, 'data');
  }
  return path.join(cwd, 'data');
}

const DATA_DIR = resolveDataDir();
const PRIMARY_LEDGER_FILE = path.join(DATA_DIR, 'vellum-bridge.json');
const FALLBACK_LEDGER_FILE = path.join(os.tmpdir(), 'folio-vellum-bridge.json');

let ledgerMutex: Promise<void> = Promise.resolve();

async function withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = ledgerMutex;
  let release!: () => void;
  ledgerMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function getDefaultLedger(): VellumBridgeLedger {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    vellumUrl: 'http://localhost:3030',
    books: [],
    challenges: [],
    appliedMutationIds: [],
  };
}

async function readLedger(): Promise<VellumBridgeLedger> {
  for (const candidate of [PRIMARY_LEDGER_FILE, FALLBACK_LEDGER_FILE]) {
    try {
      const raw = await fs.readFile(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        vellumUrl: parsed.vellumUrl || 'http://localhost:3030',
        lastVellumSyncAt: parsed.lastVellumSyncAt,
        books: Array.isArray(parsed.books) ? parsed.books : [],
        challenges: Array.isArray(parsed.challenges) ? parsed.challenges : [],
        appliedMutationIds: Array.isArray(parsed.appliedMutationIds)
          ? parsed.appliedMutationIds
          : [],
      };
    } catch {
      // Try next candidate
    }
  }
  return getDefaultLedger();
}

async function writeLedger(ledger: VellumBridgeLedger): Promise<void> {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmpFile = `${PRIMARY_LEDGER_FILE}.${uniq}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(ledger, null, 2), 'utf-8');
    await fs.rename(tmpFile, PRIMARY_LEDGER_FILE);
  } catch {
    const tmpFile = `${FALLBACK_LEDGER_FILE}.${uniq}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(ledger, null, 2), 'utf-8');
    await fs.rename(tmpFile, FALLBACK_LEDGER_FILE);
  }
}

function extractRequestToken(req: NextRequest): string {
  return (
    req.headers.get('x-folio-bridge-token')?.trim() ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    ''
  );
}

function getServerSupabaseClient() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function mapSupabaseBookRow(row: Record<string, unknown>): BookItem {
  return {
    id: String(row.id || ''),
    source: (row.source || 'manual') as DataSource,
    externalId: row.external_id ? String(row.external_id) : undefined,
    title: String(row.title || 'Untitled'),
    authorName: String(row.author_name || 'Unknown Author'),
    authorId: row.author_id ? String(row.author_id) : undefined,
    coverUrl: row.cover_url ? String(row.cover_url) : undefined,
    releaseDate: row.release_date ? String(row.release_date) : undefined,
    datePrecision: (row.date_precision || 'unknown') as DatePrecision,
    description: row.description ? String(row.description) : undefined,
    pageCount: typeof row.page_count === 'number' ? row.page_count : undefined,
    isbn: row.isbn ? String(row.isbn) : undefined,
    isOneOff: Boolean(row.is_one_off),
    isManual: Boolean(row.is_manual),
    userEdited:
      row.is_manual &&
      !String(row.id || '').startsWith('vellum:') &&
      !String(row.id || '').startsWith('manual:batch:')
        ? true
        : undefined,
    hidden: Boolean(row.hidden),
    readingStatus: (row.reading_status || 'none') as ReadingStatus,
    addedToTodoAt: row.added_to_todo_at ? String(row.added_to_todo_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    rating: typeof row.rating === 'number' ? row.rating : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    vellumBookId: row.vellum_book_id ? String(row.vellum_book_id) : undefined,
    vellumProgress:
      typeof row.vellum_progress === 'number' ? row.vellum_progress : undefined,
    vellumChapter: row.vellum_chapter ? String(row.vellum_chapter) : undefined,
    vellumLastReadAt: row.vellum_last_read_at
      ? String(row.vellum_last_read_at)
      : undefined,
    vellumFormat: row.vellum_format ? String(row.vellum_format) : undefined,
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function mapBookItemToSupabaseRow(b: BookItem) {
  return {
    id: b.id,
    source: b.source,
    external_id: b.externalId ?? null,
    title: b.title,
    author_name: b.authorName,
    author_id: b.authorId ?? null,
    cover_url: b.coverUrl ?? null,
    release_date: b.releaseDate ?? null,
    date_precision: b.datePrecision,
    description: b.description ?? null,
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
    vellum_book_id: b.vellumBookId ?? null,
    vellum_progress:
      typeof b.vellumProgress === 'number' ? b.vellumProgress : null,
    vellum_chapter: b.vellumChapter ?? null,
    vellum_last_read_at: b.vellumLastReadAt ?? null,
    vellum_format: b.vellumFormat ?? null,
    updated_at: b.updatedAt,
  };
}

function mapSupabaseChallengeRow(row: Record<string, unknown>): ReadingChallenge {
  return {
    id: String(row.id || ''),
    year: Number(row.year || new Date().getFullYear()),
    goalCount: Number(row.goal_count || 12),
    title: String(row.title || 'Reading Challenge'),
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function checkLocalBridgeAuth(headerToken: string): { ok: boolean; error?: string } {
  const requiredToken = process.env.FOLIO_BRIDGE_TOKEN?.trim();
  if (requiredToken) {
    return headerToken === requiredToken
      ? { ok: true }
      : { ok: false, error: 'Invalid Folio bridge token' };
  }
  if (isHostedServerlessEnv()) {
    return {
      ok: false,
      error:
        'Paste your personal Bridge Token from Folio → Settings → Vellum Ebook Reader Link to sync with a cloud Folio deployment.',
    };
  }
  return { ok: true };
}

function buildStats(books: BookItem[]) {
  const visible = books.filter((b) => !b.hidden);
  return {
    totalBooks: visible.length,
    todoCount: visible.filter((b) => b.readingStatus === 'todo').length,
    readCount: visible.filter((b) => b.readingStatus === 'read').length,
    activeReadsCount: visible.filter(
      (b) =>
        b.readingStatus !== 'read' &&
        typeof b.vellumProgress === 'number' &&
        b.vellumProgress >= 0.005 &&
        b.vellumProgress < 0.995
    ).length,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const headerToken = extractRequestToken(req);
  const supabase = getServerSupabaseClient();

  // Mode A: Personal Supabase Cloud Bridge Token (`fbr_...`)
  if (supabase && headerToken.startsWith('fbr_')) {
    const { data, error } = await supabase.rpc('vellum_bridge_get_state', {
      token_input: headerToken,
    });
    if (error || !data) {
      return NextResponse.json(
        {
          ok: false,
          error: error?.message || 'Invalid Folio bridge token',
        },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    const rawBooks = Array.isArray(data.books) ? data.books : [];
    const rawChallenges = Array.isArray(data.challenges) ? data.challenges : [];
    const books = rawBooks.map((r: Record<string, unknown>) => mapSupabaseBookRow(r));
    const challenges = rawChallenges.map((r: Record<string, unknown>) =>
      mapSupabaseChallengeRow(r)
    );
    const nowIso = new Date().toISOString();

    return NextResponse.json(
      {
        ok: true,
        mode: 'cloud',
        folioAppName: 'Folio',
        updatedAt: data.last_sync_at || nowIso,
        lastVellumSyncAt: data.last_sync_at || undefined,
        books: books.filter((b: BookItem) => !b.hidden),
        challenges,
        stats: buildStats(books),
      },
      { headers: CORS_HEADERS }
    );
  }

  // Mode B: Local Desktop / Single-Owner Bridge
  const authCheck = checkLocalBridgeAuth(headerToken);
  if (!authCheck.ok) {
    return NextResponse.json(
      { ok: false, error: authCheck.error || 'Invalid Folio bridge token' },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const ledger = await readLedger();
  return NextResponse.json(
    {
      ok: true,
      mode: 'local',
      folioAppName: 'Folio',
      updatedAt: ledger.updatedAt,
      lastVellumSyncAt: ledger.lastVellumSyncAt,
      vellumUrl: ledger.vellumUrl,
      books: ledger.books.filter((b) => !b.hidden),
      challenges: ledger.challenges,
      stats: buildStats(ledger.books),
    },
    { headers: CORS_HEADERS }
  );
}

export async function POST(req: NextRequest) {
  const headerToken = extractRequestToken(req);
  const supabase = getServerSupabaseClient();

  try {
    const body = await req.json();
    const action = body?.action as string | undefined;

    // ------------------------------------------------------------------
    // Mode A: Personal Supabase Cloud Bridge Token (`fbr_...`)
    // Works on Vercel serverless + multi-user Reading Circles!
    // ------------------------------------------------------------------
    if (supabase && headerToken.startsWith('fbr_')) {
      if (action !== 'vellum-sync') {
        return NextResponse.json(
          { ok: false, error: 'Unsupported cloud bridge action' },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      const { data, error } = await supabase.rpc('vellum_bridge_get_state', {
        token_input: headerToken,
      });
      if (error || !data) {
        return NextResponse.json(
          {
            ok: false,
            error: error?.message || 'Invalid Folio bridge token',
          },
          { status: 401, headers: CORS_HEADERS }
        );
      }

      const existingBooks: BookItem[] = (
        Array.isArray(data.books) ? data.books : []
      ).map((r: Record<string, unknown>) => mapSupabaseBookRow(r));
      const challenges: ReadingChallenge[] = (
        Array.isArray(data.challenges) ? data.challenges : []
      ).map((r: Record<string, unknown>) => mapSupabaseChallengeRow(r));

      const vellumOrigin =
        typeof body.vellumOrigin === 'string' && body.vellumOrigin.trim()
          ? body.vellumOrigin.trim().replace(/\/+$/, '')
          : undefined;
      const mutations: VellumStatusMutation[] = Array.isArray(body.statusMutations)
        ? body.statusMutations
        : [];
      const vellumBooks: VellumSyncBookPayload[] = Array.isArray(body.books)
        ? body.books
        : [];

      const nowIso = new Date().toISOString();
      const { books: mergedBooks, touchedBooks } = applyVellumSyncToBooks({
        existingBooks,
        vellumBooks,
        statusMutations: mutations,
        vellumOrigin,
        nowIso,
      });

      const payloadRows = touchedBooks.map(mapBookItemToSupabaseRow);
      const { data: syncedTs, error: saveErr } = await supabase.rpc(
        'vellum_bridge_save_books',
        {
          token_input: headerToken,
          books_json: payloadRows,
        }
      );

      if (saveErr) {
        return NextResponse.json(
          { ok: false, error: saveErr.message },
          { status: 500, headers: CORS_HEADERS }
        );
      }

      const stampedIso = typeof syncedTs === 'string' ? syncedTs : nowIso;

      return NextResponse.json(
        {
          ok: true,
          mode: 'cloud',
          folioAppName: 'Folio',
          updatedAt: stampedIso,
          lastVellumSyncAt: stampedIso,
          books: mergedBooks.filter((b) => !b.hidden),
          challenges,
          stats: buildStats(mergedBooks),
        },
        { headers: CORS_HEADERS }
      );
    }

    // ------------------------------------------------------------------
    // Mode B: Local Desktop / Single-Owner Ledger Bridge
    // ------------------------------------------------------------------
    const authCheck = checkLocalBridgeAuth(headerToken);
    if (!authCheck.ok) {
      return NextResponse.json(
        { ok: false, error: authCheck.error || 'Invalid Folio bridge token' },
        { status: 401, headers: CORS_HEADERS }
      );
    }

    return await withLedgerLock(async () => {
      const nowIso = new Date().toISOString();
      const ledger = await readLedger();

      // 1. Folio Browser Client Sync (pushes local Folio state & pulls Vellum updates)
      if (action === 'folio-sync') {
        const deletedBookIds = new Set<string>(
          Array.isArray(body.deletedBookIds) ? body.deletedBookIds : []
        );
        const deletedChallengeIds = new Set<string>(
          Array.isArray(body.deletedChallengeIds) ? body.deletedChallengeIds : []
        );

        const baseBooks = ledger.books.filter((b) => !deletedBookIds.has(b.id));
        const incomingBooks: BookItem[] = Array.isArray(body.books) ? body.books : [];
        const mergedBooks = mergeBookLists(baseBooks, incomingBooks);

        const baseChallenges = ledger.challenges.filter(
          (c) => !deletedChallengeIds.has(c.id)
        );
        const incomingChallenges = Array.isArray(body.challenges)
          ? body.challenges
          : [];
        const mergedChallenges = mergeChallengeLists(
          baseChallenges,
          incomingChallenges
        );

        const nextVellumUrl =
          typeof body.vellumUrl === 'string' && body.vellumUrl.trim()
            ? body.vellumUrl.trim().replace(/\/+$/, '')
            : ledger.vellumUrl;

        const nextLedger: VellumBridgeLedger = {
          ...ledger,
          updatedAt: nowIso,
          vellumUrl: nextVellumUrl,
          books: mergedBooks,
          challenges: mergedChallenges,
        };
        await writeLedger(nextLedger);

        return NextResponse.json(
          {
            ok: true,
            mode: 'local',
            updatedAt: nextLedger.updatedAt,
            lastVellumSyncAt: nextLedger.lastVellumSyncAt,
            vellumUrl: nextLedger.vellumUrl,
            books: nextLedger.books,
            challenges: nextLedger.challenges,
            stats: buildStats(nextLedger.books),
          },
          { headers: CORS_HEADERS }
        );
      }

      // 2. Vellum Ebook Reader Sync (pushes active reads, finished books & list mutations)
      if (action === 'vellum-sync') {
        const vellumOrigin =
          typeof body.vellumOrigin === 'string' && body.vellumOrigin.trim()
            ? body.vellumOrigin.trim().replace(/\/+$/, '')
            : ledger.vellumUrl;

        const mutations: VellumStatusMutation[] = Array.isArray(body.statusMutations)
          ? body.statusMutations
          : [];
        const vellumBooks: VellumSyncBookPayload[] = Array.isArray(body.books)
          ? body.books
          : [];

        const { books: workingBooks, appliedMutationIds } = applyVellumSyncToBooks({
          existingBooks: ledger.books,
          vellumBooks,
          statusMutations: mutations,
          vellumOrigin,
          appliedMutationIds: ledger.appliedMutationIds,
          nowIso,
        });

        const nextLedger: VellumBridgeLedger = {
          version: 1,
          updatedAt: nowIso,
          vellumUrl: vellumOrigin,
          lastVellumSyncAt: nowIso,
          books: workingBooks,
          challenges: ledger.challenges,
          appliedMutationIds,
        };
        await writeLedger(nextLedger);

        return NextResponse.json(
          {
            ok: true,
            mode: 'local',
            folioAppName: 'Folio',
            updatedAt: nextLedger.updatedAt,
            lastVellumSyncAt: nextLedger.lastVellumSyncAt,
            books: nextLedger.books.filter((b) => !b.hidden),
            challenges: nextLedger.challenges,
            stats: buildStats(nextLedger.books),
          },
          { headers: CORS_HEADERS }
        );
      }

      return NextResponse.json(
        { ok: false, error: 'Unsupported action' },
        { status: 400, headers: CORS_HEADERS }
      );
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Vellum bridge error',
      },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
