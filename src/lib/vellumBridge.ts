import { BookItem, ReadingChallenge, ReadingStatus } from '@/types/books';

export interface VellumSyncBookPayload {
  vellumBookId: string;
  title: string;
  author: string;
  coverUrl?: string;
  description?: string;
  publishedYear?: string;
  format?: string;
  progress: number; // 0..1
  currentChapter?: string;
  isFinished?: boolean;
  lastReadAt?: number;
}

export interface VellumStatusMutation {
  mutationId: string;
  vellumBookId?: string;
  folioBookId?: string;
  title: string;
  author: string;
  coverUrl?: string;
  description?: string;
  publishedYear?: string;
  readingStatus: ReadingStatus;
  finishedAt?: string; // YYYY-MM-DD
  rating?: number;
  notes?: string;
  progress?: number;
  currentChapter?: string;
  updatedAt: string; // ISO
}

export interface VellumBridgeLedger {
  version: 1;
  updatedAt: string;
  vellumUrl: string;
  lastVellumSyncAt?: string;
  books: BookItem[];
  challenges: ReadingChallenge[];
  appliedMutationIds: string[];
}

export function normBookMatchKey(title: string, authorName: string): string {
  const cleanTitle = (title || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .split(':')[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const cleanAuthor = (authorName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${cleanTitle}::${cleanAuthor}`;
}

function toTimestamp(iso?: string): number {
  if (!iso) return 0;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

export function mergeBookPair(a: BookItem, b: BookItem): BookItem {
  const aTs = toTimestamp(a.updatedAt);
  const bTs = toTimestamp(b.updatedAt);
  const primary = bTs >= aTs ? b : a;
  const secondary = bTs >= aTs ? a : b;

  const aVelTs = toTimestamp(a.vellumLastReadAt);
  const bVelTs = toTimestamp(b.vellumLastReadAt);
  const velSource = bVelTs >= aVelTs ? b : a;

  return {
    ...secondary,
    ...primary,
    id: a.id, // preserve stable original ID in Folio
    authorId: primary.authorId || secondary.authorId,
    coverUrl: primary.coverUrl || secondary.coverUrl,
    releaseDate:
      primary.releaseDate && primary.releaseDate.length >= (secondary.releaseDate?.length || 0)
        ? primary.releaseDate
        : secondary.releaseDate || primary.releaseDate,
    datePrecision:
      primary.datePrecision !== 'unknown' ? primary.datePrecision : secondary.datePrecision,
    description: primary.description || secondary.description,
    pageCount: primary.pageCount || secondary.pageCount,
    isbn: primary.isbn || secondary.isbn,
    rating: primary.rating ?? secondary.rating,
    notes: primary.notes ?? secondary.notes,
    finishedAt:
      primary.readingStatus === 'read'
        ? primary.finishedAt || secondary.finishedAt
        : undefined,
    addedToTodoAt:
      primary.readingStatus === 'todo'
        ? primary.addedToTodoAt || secondary.addedToTodoAt
        : undefined,
    vellumBookId: velSource.vellumBookId || a.vellumBookId || b.vellumBookId,
    vellumProgress: velSource.vellumProgress ?? a.vellumProgress ?? b.vellumProgress,
    vellumChapter: velSource.vellumChapter || a.vellumChapter || b.vellumChapter,
    vellumLastReadAt: velSource.vellumLastReadAt || a.vellumLastReadAt || b.vellumLastReadAt,
    vellumFormat: velSource.vellumFormat || a.vellumFormat || b.vellumFormat,
    updatedAt: bTs >= aTs ? b.updatedAt : a.updatedAt,
  };
}

export function mergeBookLists(base: BookItem[], incoming: BookItem[]): BookItem[] {
  const byId = new Map<string, BookItem>();
  const normToId = new Map<string, string>();
  const vellumToId = new Map<string, string>();

  for (const item of base) {
    byId.set(item.id, item);
    normToId.set(normBookMatchKey(item.title, item.authorName), item.id);
    if (item.vellumBookId) vellumToId.set(item.vellumBookId, item.id);
  }

  for (const inc of incoming) {
    const norm = normBookMatchKey(inc.title, inc.authorName);
    const matchedId =
      (byId.has(inc.id) ? inc.id : undefined) ||
      (inc.vellumBookId ? vellumToId.get(inc.vellumBookId) : undefined) ||
      normToId.get(norm);

    if (matchedId && byId.has(matchedId)) {
      const merged = mergeBookPair(byId.get(matchedId)!, inc);
      byId.set(matchedId, merged);
      if (merged.vellumBookId) vellumToId.set(merged.vellumBookId, matchedId);
    } else {
      byId.set(inc.id, inc);
      normToId.set(norm, inc.id);
      if (inc.vellumBookId) vellumToId.set(inc.vellumBookId, inc.id);
    }
  }

  return Array.from(byId.values());
}

export function mergeChallengeLists(
  base: ReadingChallenge[],
  incoming: ReadingChallenge[]
): ReadingChallenge[] {
  const byYear = new Map<number, ReadingChallenge>();
  for (const c of base) byYear.set(c.year, c);
  for (const inc of incoming) {
    const existing = byYear.get(inc.year);
    if (!existing || toTimestamp(inc.updatedAt) >= toTimestamp(existing.updatedAt)) {
      byYear.set(inc.year, inc);
    }
  }
  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}

export function isLocalNetworkHost(hostname?: string): boolean {
  const host = (hostname || '').trim().toLowerCase();
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

export function canOpenVellumWebUrl(vellumUrl?: string): boolean {
  const clean = (vellumUrl || '').trim();
  if (!clean || typeof window === 'undefined') return false;
  const pointsToLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(clean);
  if (!pointsToLoopback) return true;
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return true;
  }
  const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  return !isMobileUa;
}

export function resolveVellumCoverUrl(coverUrl?: string, vellumOrigin?: string): string | undefined {
  if (!coverUrl) return undefined;
  if (coverUrl.startsWith('http://') || coverUrl.startsWith('https://')) {
    return coverUrl;
  }
  if (coverUrl.startsWith('data:')) {
    return coverUrl.length <= 250_000 ? coverUrl : undefined;
  }
  if (
    coverUrl.startsWith('/') &&
    vellumOrigin &&
    /^https?:\/\//i.test(vellumOrigin) &&
    !/^https?:\/\/localhost$/i.test(vellumOrigin.trim())
  ) {
    return `${vellumOrigin.replace(/\/+$/, '')}${coverUrl}`;
  }
  return undefined;
}

function formatDateYmd(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function applyVellumSyncToBooks(params: {
  existingBooks: BookItem[];
  vellumBooks: VellumSyncBookPayload[];
  statusMutations: VellumStatusMutation[];
  vellumOrigin?: string;
  appliedMutationIds?: Iterable<string>;
  nowIso?: string;
}): {
  books: BookItem[];
  touchedBooks: BookItem[];
  appliedMutationIds: string[];
} {
  const nowIso = params.nowIso || new Date().toISOString();
  const workingBooks = [...params.existingBooks];
  const touchedIds = new Set<string>();
  const appliedSet = new Set<string>(params.appliedMutationIds || []);

  const findBookIdx = (opts: {
    folioBookId?: string;
    vellumBookId?: string;
    title: string;
    author: string;
  }): number => {
    if (opts.folioBookId) {
      const idx = workingBooks.findIndex((b) => b.id === opts.folioBookId);
      if (idx >= 0) return idx;
    }
    if (opts.vellumBookId) {
      const idx = workingBooks.findIndex((b) => b.vellumBookId === opts.vellumBookId);
      if (idx >= 0) return idx;
    }
    const norm = normBookMatchKey(opts.title, opts.author);
    return workingBooks.findIndex(
      (b) => normBookMatchKey(b.title, b.authorName) === norm
    );
  };

  for (const mut of params.statusMutations) {
    if (mut.mutationId && appliedSet.has(mut.mutationId)) continue;
    if (mut.mutationId) appliedSet.add(mut.mutationId);

    const idx = findBookIdx({
      folioBookId: mut.folioBookId,
      vellumBookId: mut.vellumBookId,
      title: mut.title,
      author: mut.author,
    });

    const mutTime = mut.updatedAt || nowIso;
    const resolvedCover = resolveVellumCoverUrl(mut.coverUrl, params.vellumOrigin);

    if (idx >= 0) {
      const cur = workingBooks[idx];
      const next: BookItem = {
        ...cur,
        hidden: false,
        coverUrl: cur.coverUrl || resolvedCover,
        description: cur.description || mut.description,
        readingStatus: mut.readingStatus,
        addedToTodoAt:
          mut.readingStatus === 'todo' ? cur.addedToTodoAt || mutTime : undefined,
        finishedAt:
          mut.readingStatus === 'read'
            ? mut.finishedAt || cur.finishedAt || formatDateYmd()
            : undefined,
        rating: mut.rating !== undefined ? mut.rating : cur.rating,
        notes: mut.notes !== undefined ? mut.notes : cur.notes,
        vellumBookId: mut.vellumBookId || cur.vellumBookId,
        vellumProgress:
          mut.readingStatus === 'read'
            ? 1
            : mut.progress !== undefined
            ? mut.progress
            : cur.vellumProgress,
        vellumChapter: mut.currentChapter || cur.vellumChapter,
        vellumLastReadAt: mutTime,
        updatedAt: mutTime,
      };
      workingBooks[idx] = next;
      touchedIds.add(next.id);
    } else {
      const newBook: BookItem = {
        id: `vellum:${mut.vellumBookId || Date.now().toString(36)}`,
        source: 'manual',
        title: mut.title,
        authorName: mut.author || 'Unknown Author',
        coverUrl: resolvedCover,
        releaseDate:
          mut.publishedYear && /^\d{4}$/.test(mut.publishedYear)
            ? mut.publishedYear
            : undefined,
        datePrecision:
          mut.publishedYear && /^\d{4}$/.test(mut.publishedYear) ? 'year' : 'unknown',
        description: mut.description,
        isOneOff: true,
        isManual: true,
        readingStatus: mut.readingStatus,
        addedToTodoAt: mut.readingStatus === 'todo' ? mutTime : undefined,
        finishedAt:
          mut.readingStatus === 'read'
            ? mut.finishedAt || formatDateYmd()
            : undefined,
        rating: mut.rating,
        notes: mut.notes,
        vellumBookId: mut.vellumBookId,
        vellumProgress: mut.readingStatus === 'read' ? 1 : mut.progress,
        vellumChapter: mut.currentChapter,
        vellumLastReadAt: mutTime,
        updatedAt: mutTime,
      };
      workingBooks.push(newBook);
      touchedIds.add(newBook.id);
    }
  }

  for (const vb of params.vellumBooks) {
    if (!vb.title) continue;
    const idx = findBookIdx({
      vellumBookId: vb.vellumBookId,
      title: vb.title,
      author: vb.author,
    });

    const isCompletedInVellum = Boolean(vb.isFinished || vb.progress >= 0.992);
    const hasActiveProgress = vb.progress >= 0.005;
    const readIso = vb.lastReadAt ? new Date(vb.lastReadAt).toISOString() : nowIso;
    const resolvedCover = resolveVellumCoverUrl(vb.coverUrl, params.vellumOrigin);

    if (idx >= 0) {
      const cur = workingBooks[idx];
      const shouldPromoteToRead = isCompletedInVellum && cur.readingStatus !== 'read';
      const nextProgress = isCompletedInVellum ? 1 : vb.progress;
      const nextChapter = vb.currentChapter || cur.vellumChapter;
      const nextLastRead =
        hasActiveProgress || isCompletedInVellum ? readIso : cur.vellumLastReadAt;
      const nextFormat = vb.format || cur.vellumFormat;
      const nextCover = cur.coverUrl || resolvedCover;
      const nextDesc = cur.description || vb.description;
      const nextVellumId = vb.vellumBookId || cur.vellumBookId;

      const progressChanged =
        cur.vellumBookId !== nextVellumId ||
        Math.abs((cur.vellumProgress ?? -1) - nextProgress) >= 0.002 ||
        cur.vellumChapter !== nextChapter ||
        cur.vellumFormat !== nextFormat ||
        shouldPromoteToRead;

      if (progressChanged) {
        const next: BookItem = {
          ...cur,
          coverUrl: nextCover,
          description: nextDesc,
          vellumBookId: nextVellumId,
          vellumProgress: nextProgress,
          vellumChapter: nextChapter,
          vellumLastReadAt: nextLastRead,
          vellumFormat: nextFormat,
          readingStatus: shouldPromoteToRead ? 'read' : cur.readingStatus,
          finishedAt: shouldPromoteToRead
            ? cur.finishedAt || formatDateYmd(vb.lastReadAt)
            : cur.finishedAt,
          updatedAt: nowIso,
        };
        workingBooks[idx] = next;
        touchedIds.add(next.id);
      }
    } else if (isCompletedInVellum || vb.progress >= 0.01) {
      const created: BookItem = {
        id: `vellum:${vb.vellumBookId}`,
        source: 'manual',
        title: vb.title,
        authorName: vb.author || 'Unknown Author',
        coverUrl: resolvedCover,
        releaseDate:
          vb.publishedYear && /^\d{4}$/.test(vb.publishedYear)
            ? vb.publishedYear
            : undefined,
        datePrecision:
          vb.publishedYear && /^\d{4}$/.test(vb.publishedYear) ? 'year' : 'unknown',
        description: vb.description,
        isOneOff: true,
        isManual: true,
        readingStatus: isCompletedInVellum ? 'read' : 'todo',
        addedToTodoAt: !isCompletedInVellum ? readIso : undefined,
        finishedAt: isCompletedInVellum ? formatDateYmd(vb.lastReadAt) : undefined,
        vellumBookId: vb.vellumBookId,
        vellumProgress: isCompletedInVellum ? 1 : vb.progress,
        vellumChapter: vb.currentChapter,
        vellumLastReadAt: readIso,
        vellumFormat: vb.format,
        updatedAt: nowIso,
      };
      workingBooks.push(created);
      touchedIds.add(created.id);
    }
  }

  return {
    books: workingBooks,
    touchedBooks: workingBooks.filter((b) => touchedIds.has(b.id)),
    appliedMutationIds: Array.from(appliedSet).slice(-500),
  };
}

export async function syncFolioStateWithBridge(params: {
  books: BookItem[];
  challenges: ReadingChallenge[];
  deletedBookIds?: string[];
  deletedChallengeIds?: string[];
  vellumUrl?: string;
}): Promise<{
  books: BookItem[];
  challenges: ReadingChallenge[];
  vellumUrl: string;
  lastVellumSyncAt?: string;
} | null> {
  try {
    const res = await fetch('/api/vellum-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'folio-sync',
        books: params.books,
        challenges: params.challenges,
        deletedBookIds: params.deletedBookIds || [],
        deletedChallengeIds: params.deletedChallengeIds || [],
        vellumUrl: params.vellumUrl,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;
    return {
      books: data.books || [],
      challenges: data.challenges || [],
      vellumUrl: data.vellumUrl || 'http://localhost:3030',
      lastVellumSyncAt: data.lastVellumSyncAt,
    };
  } catch {
    return null;
  }
}
