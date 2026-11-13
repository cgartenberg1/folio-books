import { getLocalTodayStr, parseReleaseDateInput } from '@/lib/dates';
import {
  BookItem,
  DataSource,
  DatePrecision,
  SearchAuthorResult,
  SearchBookResult,
} from '@/types/books';

const HARDCOVER_ENDPOINT = 'https://api.hardcover.app/v1/graphql';
const GOOGLE_BOOKS_ENDPOINT = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY_AUTHORS_ENDPOINT = 'https://openlibrary.org/search/authors.json';

/**
 * Hasura `books` filter limiting results to English-language releases.
 * Hardcover files translations as editions (and sometimes as separate book records),
 * so a book qualifies if it has at least one English edition, or if none of its
 * editions have a language recorded yet (typical for freshly announced titles).
 */
const HARDCOVER_ENGLISH_BOOK_FILTER = `_or: [
  { editions: { language: { code2: { _eq: "en" } } } }
  { _not: { editions: { language_id: { _is_null: false } } } }
]`;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 250;
const serverCatalogCache = new Map<string, CacheEntry<unknown>>();

function getCachedValue<T>(key: string): T | null {
  const hit = serverCatalogCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    serverCatalogCache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCachedValue<T>(key: string, value: T, ttlMs = CATALOG_CACHE_TTL_MS): void {
  if (serverCatalogCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = serverCatalogCache.keys().next().value;
    if (oldestKey) serverCatalogCache.delete(oldestKey);
  }
  serverCatalogCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .split(':')[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeAuthorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isLikelyNoiseEdition(title: string, filterUntitled = false): boolean {
  const lower = title.toLowerCase().trim();
  if (filterUntitled && /^untitled\b/.test(lower)) {
    return true;
  }
  const noisePatterns = [
    /\bsummary of\b/,
    /\bstudy guide\b/,
    /\bworkbook for\b/,
    /\banalysis of\b/,
    /\btrivia\b/,
    /\bboxed set\b/,
    /\bbox set\b/,
    /\b\d+-book bundle\b/,
    /\bcollection:\s*books\b/,
    /\bomnibus\b/,
    /\bsampler\b/,
    /\bcoloring book\b/,
    /\bdramatized adaptation\b/,
    /\bgraphicaudio\b/,
    /\broleplaying game\b/,
    /\(\d+\s+of\s+\d+\)/,
    /,\s*part\s+\d+\b/,
  ];
  return noisePatterns.some((re) => re.test(lower));
}

function parseHardcoverReleaseDate(
  releaseDate?: string | null,
  releaseYear?: number | null,
  hasCover?: boolean
): { releaseDate?: string; datePrecision: DatePrecision } {
  const parsed = parseReleaseDateInput(releaseDate, releaseYear);
  const currentYear = new Date().getFullYear();

  // Hardcover uses YYYY-01-01 or YYYY-12-31 as placeholders when only a future year is known
  if (
    parsed.datePrecision === 'day' &&
    parsed.releaseDate &&
    !hasCover
  ) {
    const yearNum = Number(parsed.releaseDate.slice(0, 4));
    const md = parsed.releaseDate.slice(5);
    if (yearNum > currentYear && (md === '01-01' || md === '12-31')) {
      return {
        releaseDate: String(yearNum),
        datePrecision: 'year',
      };
    }
  }

  return parsed;
}

function cleanGoogleCoverUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined;
  return rawUrl
    .replace(/^http:\/\//i, 'https://')
    .replace('&edge=curl', '');
}

function buildHardcoverAuthHeader(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed;
  }
  return `Bearer ${trimmed}`;
}

async function queryHardcoverGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  rawToken: string
): Promise<T> {
  const res = await fetch(HARDCOVER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildHardcoverAuthHeader(rawToken),
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Hardcover HTTP ${res.status}: ${text.slice(0, 180)}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0]?.message || 'Hardcover GraphQL error');
  }
  return json.data as T;
}

interface HardcoverSearchAuthorDoc {
  id: string | number;
  name?: string;
  books?: string[];
  books_count?: number;
  image?: { url?: string | null } | null;
}

interface HardcoverSearchBookDoc {
  id: string | number;
  title?: string;
  author_names?: string[];
  compilation?: boolean;
  description?: string | null;
  pages?: number | null;
  release_date?: string | null;
  release_year?: number | null;
  isbns?: string[];
  image?: { url?: string | null } | null;
  contributions?: Array<{
    author?: {
      id?: number | string;
      name?: string;
      image?: { url?: string | null } | null;
    } | null;
    primary?: boolean;
  }>;
}

function extractSearchHits<TDoc>(rawResults: unknown): TDoc[] {
  if (!rawResults) return [];
  const parsed =
    typeof rawResults === 'string'
      ? (() => {
          try {
            return JSON.parse(rawResults);
          } catch {
            return null;
          }
        })()
      : rawResults;

  if (!parsed || typeof parsed !== 'object') return [];
  const hits = (parsed as { hits?: Array<{ document?: TDoc }> }).hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => h.document).filter((d): d is TDoc => Boolean(d));
}

/**
 * Given Hardcover book IDs (e.g. from Typesense search hits, which carry no language data),
 * returns the subset that are English-language releases. Returns null if the lookup fails,
 * so callers can degrade gracefully rather than dropping every result.
 */
async function fetchEnglishHardcoverBookIds(
  ids: Array<string | number>,
  token: string
): Promise<Set<string> | null> {
  const numericIds = Array.from(
    new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );
  if (numericIds.length === 0) return new Set();

  try {
    const data = await queryHardcoverGraphQL<{ books?: Array<{ id: number }> }>(
      `query EnglishBooks($ids: [Int!]!) {
        books(where: { id: { _in: $ids }, ${HARDCOVER_ENGLISH_BOOK_FILTER} }, limit: ${numericIds.length}) {
          id
        }
      }`,
      { ids: numericIds },
      token
    );
    return new Set((data.books || []).map((b) => String(b.id)));
  } catch {
    return null;
  }
}

export async function searchHardcoverCatalog(
  query: string,
  token: string,
  mode: 'all' | 'authors' | 'books' = 'all'
): Promise<{
  authors: SearchAuthorResult[];
  books: SearchBookResult[];
}> {
  const trimmed = query.trim();

  const gql = `
    query SearchHardcover($q: String!, $includeAuthors: Boolean!, $includeBooks: Boolean!) {
      authorSearch: search(
        query: $q
        query_type: "Author"
        per_page: 12
        page: 1
      ) @include(if: $includeAuthors) {
        results
      }
      bookSearch: search(
        query: $q
        query_type: "Book"
        per_page: 24
        page: 1
      ) @include(if: $includeBooks) {
        results
      }
    }
  `;

  const data = await queryHardcoverGraphQL<{
    authorSearch?: { results?: unknown };
    bookSearch?: { results?: unknown };
  }>(
    gql,
    {
      q: trimmed,
      includeAuthors: mode === 'all' || mode === 'authors',
      includeBooks: mode === 'all' || mode === 'books',
    },
    token
  );

  const authorDocs = extractSearchHits<HardcoverSearchAuthorDoc>(
    data.authorSearch?.results
  );
  const authors: SearchAuthorResult[] = authorDocs
    .filter((doc) => Boolean(doc.name && doc.id !== undefined))
    .map((doc) => ({
      id: `hc:author:${doc.id}`,
      source: 'hardcover' as const,
      externalId: String(doc.id),
      name: doc.name!,
      topWork: doc.books?.[0] || undefined,
      booksCount:
        typeof doc.books_count === 'number' ? doc.books_count : undefined,
      imageUrl: doc.image?.url || undefined,
    }));

  const bookDocs = extractSearchHits<HardcoverSearchBookDoc>(
    data.bookSearch?.results
  );

  // Drop translations / foreign-only records before de-duplicating, so the English
  // record is the one that claims each title.
  const englishIds = await fetchEnglishHardcoverBookIds(
    bookDocs.map((d) => d.id),
    token
  );

  const seenBookKeys = new Set<string>();
  const books: SearchBookResult[] = [];

  for (const doc of bookDocs) {
    if (!doc.title || doc.id === undefined) continue;
    if (englishIds && !englishIds.has(String(doc.id))) continue;
    if (doc.compilation) continue;
    if (isLikelyNoiseEdition(doc.title, false)) continue;

    const primaryAuthor =
      doc.contributions?.find((c) => c.primary)?.author ||
      doc.contributions?.[0]?.author;
    const authorName =
      primaryAuthor?.name || doc.author_names?.[0] || 'Unknown Author';

    const dedupeKey = `${normalizeTitleKey(doc.title)}::${normalizeAuthorKey(
      authorName
    )}`;
    if (seenBookKeys.has(dedupeKey)) continue;
    seenBookKeys.add(dedupeKey);

    const coverUrl = doc.image?.url || undefined;
    const parsedDate = parseHardcoverReleaseDate(
      doc.release_date,
      doc.release_year,
      Boolean(coverUrl)
    );

    books.push({
      id: `hc:book:${doc.id}`,
      source: 'hardcover',
      externalId: String(doc.id),
      title: doc.title,
      authorName,
      authorExternalId:
        primaryAuthor?.id !== undefined ? String(primaryAuthor.id) : undefined,
      authorSource: primaryAuthor?.id !== undefined ? 'hardcover' : undefined,
      coverUrl,
      releaseDate: parsedDate.releaseDate,
      datePrecision: parsedDate.datePrecision,
      description: doc.description || undefined,
      pageCount: doc.pages || undefined,
      isbn: doc.isbns?.find((i) => i.length === 13) || doc.isbns?.[0],
    });
  }

  return { authors, books };
}

interface GoogleVolumeItem {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publishedDate?: string;
    description?: string;
    pageCount?: number;
    language?: string;
    imageLinks?: {
      thumbnail?: string;
      smallThumbnail?: string;
    };
    industryIdentifiers?: Array<{
      type?: string;
      identifier?: string;
    }>;
  };
}

export async function searchFallbackCatalog(
  query: string,
  mode: 'all' | 'authors' | 'books' = 'all',
  googleApiKey?: string
): Promise<{
  authors: SearchAuthorResult[];
  books: SearchBookResult[];
}> {
  const trimmed = query.trim();
  const tasks: Promise<void>[] = [];
  const authorsMap = new Map<string, SearchAuthorResult>();
  const books: SearchBookResult[] = [];

  if (mode === 'all' || mode === 'authors') {
    tasks.push(
      (async () => {
        try {
          const olUrl = `${OPEN_LIBRARY_AUTHORS_ENDPOINT}?q=${encodeURIComponent(
            trimmed
          )}&limit=10`;
          const res = await fetch(olUrl, { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          for (const doc of data.docs || []) {
            if (!doc.name || !doc.key) continue;
            const olid = String(doc.key).replace('/authors/', '');
            const normKey = normalizeAuthorKey(doc.name);
            if (authorsMap.has(normKey)) continue;
            authorsMap.set(normKey, {
              id: `ol:author:${olid}`,
              source: 'openlibrary',
              externalId: olid,
              name: doc.name,
              topWork: doc.top_work || undefined,
              booksCount:
                typeof doc.work_count === 'number' ? doc.work_count : undefined,
              imageUrl: `https://covers.openlibrary.org/a/olid/${olid}-M.jpg?default=false`,
            });
          }
        } catch {
          // Ignore OpenLibrary transient error
        }
      })()
    );
  }

  tasks.push(
    (async () => {
      try {
        const keyParam = googleApiKey
          ? `&key=${encodeURIComponent(googleApiKey)}`
          : '';
        const gbUrl = `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
          trimmed
        )}&maxResults=25&printType=books&langRestrict=en${keyParam}`;
        const res = await fetch(gbUrl, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const items: GoogleVolumeItem[] = data.items || [];

        const seenBookKeys = new Set<string>();

        for (const item of items) {
          const info = item.volumeInfo;
          if (!info?.title) continue;
          if (info.language && info.language !== 'en') continue;
          if (isLikelyNoiseEdition(info.title)) continue;

          const authorName = info.authors?.[0] || 'Unknown Author';

          if ((mode === 'all' || mode === 'authors') && info.authors?.length) {
            for (const candidateAuthor of info.authors) {
              if (
                candidateAuthor.toLowerCase().includes(trimmed.toLowerCase()) ||
                trimmed.toLowerCase().includes(candidateAuthor.toLowerCase())
              ) {
                const normAuthor = normalizeAuthorKey(candidateAuthor);
                if (!authorsMap.has(normAuthor)) {
                  const slug = normAuthor.replace(/\s+/g, '-');
                  authorsMap.set(normAuthor, {
                    id: `gb:author:${slug}`,
                    source: 'google',
                    externalId: candidateAuthor,
                    name: candidateAuthor,
                    topWork: info.title,
                  });
                }
              }
            }
          }

          if (mode === 'authors') continue;

          const dedupeKey = `${normalizeTitleKey(
            info.title
          )}::${normalizeAuthorKey(authorName)}`;
          if (seenBookKeys.has(dedupeKey)) continue;
          seenBookKeys.add(dedupeKey);

          const parsedDate = parseReleaseDateInput(info.publishedDate);
          const isbn13 = info.industryIdentifiers?.find(
            (id) => id.type === 'ISBN_13'
          )?.identifier;
          const isbn10 = info.industryIdentifiers?.find(
            (id) => id.type === 'ISBN_10'
          )?.identifier;

          books.push({
            id: `gb:book:${item.id}`,
            source: 'google',
            externalId: item.id,
            title: info.title,
            authorName,
            authorExternalId: authorName,
            authorSource: 'google',
            coverUrl: cleanGoogleCoverUrl(
              info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail
            ),
            releaseDate: parsedDate.releaseDate,
            datePrecision: parsedDate.datePrecision,
            description: info.description || undefined,
            pageCount: info.pageCount || undefined,
            isbn: isbn13 || isbn10,
          });
        }
      } catch {
        // Ignore transient Google Books error
      }
    })()
  );

  await Promise.all(tasks);

  return {
    authors: Array.from(authorsMap.values()).slice(0, 12),
    books,
  };
}

export async function searchCatalog(params: {
  query: string;
  mode?: 'all' | 'authors' | 'books';
  hardcoverToken?: string;
  googleApiKey?: string;
}): Promise<{
  authors: SearchAuthorResult[];
  books: SearchBookResult[];
  providerUsed: 'hardcover' | 'google-fallback' | 'hybrid';
  hardcoverError?: string;
}> {
  const { query, mode = 'all', hardcoverToken, googleApiKey } = params;
  const cacheKey = `search:en:${mode}::${Boolean(hardcoverToken?.trim())}::${query
    .trim()
    .toLowerCase()}`;
  const cached = getCachedValue<{
    authors: SearchAuthorResult[];
    books: SearchBookResult[];
    providerUsed: 'hardcover' | 'google-fallback' | 'hybrid';
    hardcoverError?: string;
  }>(cacheKey);
  if (cached) {
    return cached;
  }

  if (hardcoverToken?.trim()) {
    try {
      const hcResult = await searchHardcoverCatalog(
        query,
        hardcoverToken,
        mode
      );
      if (hcResult.authors.length > 0 || hcResult.books.length > 0) {
        const out = {
          ...hcResult,
          providerUsed: 'hardcover' as const,
        };
        setCachedValue(cacheKey, out);
        return out;
      }
      const fallback = await searchFallbackCatalog(query, mode, googleApiKey);
      const out = {
        ...fallback,
        providerUsed: 'hybrid' as const,
      };
      setCachedValue(cacheKey, out);
      return out;
    } catch (err) {
      const fallback = await searchFallbackCatalog(query, mode, googleApiKey);
      return {
        ...fallback,
        providerUsed: 'google-fallback',
        hardcoverError:
          err instanceof Error ? err.message : 'Hardcover request failed',
      };
    }
  }

  const fallback = await searchFallbackCatalog(query, mode, googleApiKey);
  const out = {
    ...fallback,
    providerUsed: 'google-fallback' as const,
  };
  setCachedValue(cacheKey, out);
  return out;
}

interface HardcoverBibBookNode {
  id: number;
  title: string;
  release_date?: string | null;
  release_year?: number | null;
  pages?: number | null;
  description?: string | null;
  users_count?: number | null;
  image?: { url?: string | null } | null;
}

async function fetchHardcoverAuthorBooks(params: {
  authorId: string;
  authorName: string;
  externalId?: string;
  source: DataSource;
  token: string;
}): Promise<BookItem[]> {
  const { authorId, authorName, externalId, source, token } = params;
  let numericAuthorId: number | null =
    source === 'hardcover' && externalId && /^\d+$/.test(externalId)
      ? Number(externalId)
      : null;

  // Resolve Hardcover author ID via Hardcover search if originally followed via fallback/manual
  if (!numericAuthorId) {
    const lookupGql = `
      query LookupAuthor($q: String!) {
        authorSearch: search(query: $q, query_type: "Author", per_page: 5, page: 1) {
          results
        }
      }
    `;
    const found = await queryHardcoverGraphQL<{
      authorSearch?: { results?: unknown };
    }>(lookupGql, { q: authorName.trim() }, token);

    const docs = extractSearchHits<HardcoverSearchAuthorDoc>(
      found.authorSearch?.results
    );
    const exact = docs.find(
      (a) => a.name && normalizeAuthorKey(a.name) === normalizeAuthorKey(authorName)
    );
    if (exact && /^\d+$/.test(String(exact.id))) {
      numericAuthorId = Number(exact.id);
    }
  }

  if (!numericAuthorId) {
    return [];
  }

  const todayStr = getLocalTodayStr();

  const bibQuery = `
    query AuthorBibliography($hcAuthorId: Int!, $today: date!) {
      upcoming: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            contribution: { _eq: "Author" }
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _gt: $today }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: { release_date: asc }
        limit: 40
      ) {
        id
        title
        release_date
        release_year
        pages
        description
        users_count
        image {
          url
        }
      }
      released: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            contribution: { _eq: "Author" }
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _lte: $today }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: [{ release_date: desc_nulls_last }, { users_count: desc_nulls_last }]
        limit: 80
      ) {
        id
        title
        release_date
        release_year
        pages
        description
        users_count
        image {
          url
        }
      }
    }
  `;

  const data = await queryHardcoverGraphQL<{
    upcoming?: HardcoverBibBookNode[];
    released?: HardcoverBibBookNode[];
  }>(bibQuery, { hcAuthorId: numericAuthorId, today: todayStr }, token);

  const combined = [...(data.upcoming || []), ...(data.released || [])];
  const nowIso = new Date().toISOString();
  const deduped = new Map<string, BookItem>();

  for (const b of combined) {
    if (!b.title || isLikelyNoiseEdition(b.title, true)) continue;
    const normTitle = normalizeTitleKey(b.title);
    if (!normTitle) continue;

    const coverUrl = b.image?.url || undefined;
    const parsedDate = parseHardcoverReleaseDate(
      b.release_date,
      b.release_year,
      Boolean(coverUrl)
    );

    const candidate: BookItem = {
      id: `hc:book:${b.id}`,
      source: 'hardcover',
      externalId: String(b.id),
      title: b.title,
      authorName,
      authorId,
      coverUrl,
      releaseDate: parsedDate.releaseDate,
      datePrecision: parsedDate.datePrecision,
      description: b.description || undefined,
      pageCount: b.pages || undefined,
      isOneOff: false,
      isManual: false,
      readingStatus: 'none',
      updatedAt: nowIso,
    };

    const existing = deduped.get(normTitle);
    if (!existing) {
      deduped.set(normTitle, candidate);
    } else {
      const existingScore =
        (existing.coverUrl ? 2 : 0) +
        (existing.datePrecision === 'day' ? 2 : existing.releaseDate ? 1 : 0);
      const candidateScore =
        (candidate.coverUrl ? 2 : 0) +
        (candidate.datePrecision === 'day' ? 2 : candidate.releaseDate ? 1 : 0);
      if (candidateScore > existingScore) {
        deduped.set(normTitle, candidate);
      }
    }
  }

  return Array.from(deduped.values());
}

function authorMatchesName(
  volumeAuthors: string[] | undefined,
  targetAuthor: string
): boolean {
  if (!volumeAuthors || volumeAuthors.length === 0) return false;
  const targetNorm = normalizeAuthorKey(targetAuthor);
  const targetTokens = targetNorm.split(' ').filter(Boolean);
  const lastToken = targetTokens[targetTokens.length - 1];

  return volumeAuthors.some((va) => {
    const vaNorm = normalizeAuthorKey(va);
    if (vaNorm === targetNorm) return true;
    if (vaNorm.includes(targetNorm) || targetNorm.includes(vaNorm)) return true;
    if (
      targetTokens.length >= 2 &&
      vaNorm.startsWith(targetTokens[0]) &&
      vaNorm.endsWith(lastToken)
    ) {
      return true;
    }
    return false;
  });
}

async function fetchGoogleFallbackAuthorBooks(params: {
  authorId: string;
  authorName: string;
  googleApiKey?: string;
}): Promise<BookItem[]> {
  const { authorId, authorName, googleApiKey } = params;
  const keyParam = googleApiKey
    ? `&key=${encodeURIComponent(googleApiKey)}`
    : '';
  const exactAuthorQuery = `inauthor:"${authorName.trim()}"`;

  const urls = [
    `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      exactAuthorQuery
    )}&orderBy=newest&maxResults=40&printType=books&langRestrict=en${keyParam}`,
    `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      exactAuthorQuery
    )}&orderBy=relevance&maxResults=40&printType=books&langRestrict=en${keyParam}`,
  ];

  const responses = await Promise.all(
    urls.map((u) =>
      fetch(u, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .catch(() => ({ items: [] }))
    )
  );

  const rawItems: GoogleVolumeItem[] = [
    ...(responses[0]?.items || []),
    ...(responses[1]?.items || []),
  ];

  const nowIso = new Date().toISOString();
  const deduped = new Map<string, BookItem>();

  for (const item of rawItems) {
    const info = item.volumeInfo;
    if (!info?.title) continue;
    if (info.language && info.language !== 'en') continue;
    if (!authorMatchesName(info.authors, authorName)) continue;
    if (isLikelyNoiseEdition(info.title, true)) continue;

    const normTitle = normalizeTitleKey(info.title);
    if (!normTitle || normTitle.length < 2) continue;

    const parsedDate = parseReleaseDateInput(info.publishedDate);
    const coverUrl = cleanGoogleCoverUrl(
      info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail
    );
    if (!parsedDate.releaseDate && !coverUrl) continue;

    const isbn13 = info.industryIdentifiers?.find(
      (i) => i.type === 'ISBN_13'
    )?.identifier;
    const candidate: BookItem = {
      id: `gb:book:${item.id}`,
      source: 'google',
      externalId: item.id,
      title: info.title,
      authorName,
      authorId,
      coverUrl,
      releaseDate: parsedDate.releaseDate,
      datePrecision: parsedDate.datePrecision,
      description: info.description || undefined,
      pageCount: info.pageCount || undefined,
      isbn: isbn13,
      isOneOff: false,
      isManual: false,
      readingStatus: 'none',
      updatedAt: nowIso,
    };

    const existing = deduped.get(normTitle);
    if (!existing) {
      deduped.set(normTitle, candidate);
    } else {
      const existingHasCover = Boolean(existing.coverUrl);
      const candidateHasCover = Boolean(candidate.coverUrl);
      if (!existingHasCover && candidateHasCover) {
        deduped.set(normTitle, {
          ...candidate,
          releaseDate: candidate.releaseDate || existing.releaseDate,
          datePrecision:
            candidate.datePrecision !== 'unknown'
              ? candidate.datePrecision
              : existing.datePrecision,
        });
      } else if (
        existing.datePrecision !== 'day' &&
        candidate.datePrecision === 'day'
      ) {
        deduped.set(normTitle, {
          ...existing,
          releaseDate: candidate.releaseDate,
          datePrecision: 'day',
        });
      }
    }
  }

  return Array.from(deduped.values());
}

export async function fetchAuthorBibliography(params: {
  authorId: string;
  authorName: string;
  source: DataSource;
  externalId?: string;
  hardcoverToken?: string;
  googleApiKey?: string;
}): Promise<{
  books: BookItem[];
  providerUsed: 'hardcover' | 'google-fallback' | 'manual';
}> {
  const {
    authorId,
    authorName,
    source,
    externalId,
    hardcoverToken,
    googleApiKey,
  } = params;

  const bibCacheKey = `bib:en:${source}::${externalId || ''}::${authorName
    .trim()
    .toLowerCase()}::${Boolean(hardcoverToken?.trim())}`;
  const cachedBib = getCachedValue<{
    books: BookItem[];
    providerUsed: 'hardcover' | 'google-fallback' | 'manual';
  }>(bibCacheKey);
  if (cachedBib) {
    return {
      providerUsed: cachedBib.providerUsed,
      books: cachedBib.books.map((b) => ({ ...b, authorId })),
    };
  }

  if (hardcoverToken?.trim()) {
    try {
      const hcBooks = await fetchHardcoverAuthorBooks({
        authorId,
        authorName,
        externalId,
        source,
        token: hardcoverToken,
      });
      if (hcBooks.length > 0) {
        const out = { books: hcBooks, providerUsed: 'hardcover' as const };
        setCachedValue(bibCacheKey, out);
        return out;
      }
    } catch {
      // Fall through to Google Books fallback seamlessly
    }
  }

  const fallbackBooks = await fetchGoogleFallbackAuthorBooks({
    authorId,
    authorName,
    googleApiKey,
  });

  const out = {
    books: fallbackBooks,
    providerUsed: 'google-fallback' as const,
  };
  setCachedValue(bibCacheKey, out);
  return out;
}

export interface BatchBookEnrichInput {
  clientKey: string;
  title: string;
  authorName?: string;
  isbn13?: string;
  isbn10?: string;
}

export interface BatchBookEnrichMatch {
  clientKey: string;
  id: string;
  source: DataSource;
  externalId: string;
  title: string;
  authorName: string;
  authorExternalId?: string;
  coverUrl?: string;
  releaseDate?: string;
  datePrecision: DatePrecision;
  pageCount?: number;
  isbn?: string;
}

interface HardcoverEditionBatchNode {
  isbn_13?: string | null;
  isbn_10?: string | null;
  release_date?: string | null;
  image?: { url?: string | null } | null;
  book?: {
    id: number;
    title: string;
    release_date?: string | null;
    release_year?: number | null;
    pages?: number | null;
    image?: { url?: string | null } | null;
    contributions?: Array<{
      author?: { id: number; name: string } | null;
    }> | null;
  } | null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enrichBooksBatch(params: {
  items: BatchBookEnrichInput[];
  hardcoverToken?: string;
  googleApiKey?: string;
}): Promise<{
  matches: Record<string, BatchBookEnrichMatch>;
}> {
  const { items, hardcoverToken, googleApiKey } = params;
  const matches: Record<string, BatchBookEnrichMatch> = {};

  if (items.length === 0) {
    return { matches };
  }

  // Pass 1: Fast Batch ISBN Lookup on Hardcover editions (resolves up to 80 ISBNs per GraphQL query)
  if (hardcoverToken?.trim()) {
    const isbn13Set = new Set<string>();
    const isbn10Set = new Set<string>();

    for (const item of items) {
      if (item.isbn13) isbn13Set.add(item.isbn13);
      if (item.isbn10) isbn10Set.add(item.isbn10);
    }

    if (isbn13Set.size > 0 || isbn10Set.size > 0) {
      try {
        const isbnGql = `
          query BatchIsbnLookup($isbn13s: [String!]!, $isbn10s: [String!]!) {
            editions(
              where: {
                _or: [
                  { isbn_13: { _in: $isbn13s } }
                  { isbn_10: { _in: $isbn10s } }
                ]
              }
              limit: 200
            ) {
              isbn_13
              isbn_10
              release_date
              image {
                url
              }
              book {
                id
                title
                release_date
                release_year
                pages
                image {
                  url
                }
                contributions {
                  author {
                    id
                    name
                  }
                }
              }
            }
          }
        `;

        const data = await queryHardcoverGraphQL<{
          editions?: HardcoverEditionBatchNode[];
        }>(
          isbnGql,
          {
            isbn13s: Array.from(isbn13Set),
            isbn10s: Array.from(isbn10Set),
          },
          hardcoverToken
        );

        const byIsbn = new Map<string, HardcoverEditionBatchNode>();
        for (const ed of data.editions || []) {
          if (!ed.book?.id) continue;
          if (ed.isbn_13) {
            const existing = byIsbn.get(ed.isbn_13);
            if (!existing || (!existing.book?.image?.url && ed.book.image?.url)) {
              byIsbn.set(ed.isbn_13, ed);
            }
          }
          if (ed.isbn_10) {
            const existing = byIsbn.get(ed.isbn_10);
            if (!existing || (!existing.book?.image?.url && ed.book.image?.url)) {
              byIsbn.set(ed.isbn_10, ed);
            }
          }
        }

        for (const item of items) {
          const ed =
            (item.isbn13 ? byIsbn.get(item.isbn13) : undefined) ||
            (item.isbn10 ? byIsbn.get(item.isbn10) : undefined);

          if (ed?.book) {
            const coverUrl = ed.book.image?.url || ed.image?.url || undefined;
            // Prefer edition release_date when canonical book date is a generic YYYY-01-01 in the same year
            let bestRawDate = ed.book.release_date;
            if (
              bestRawDate?.endsWith('-01-01') &&
              ed.release_date &&
              !ed.release_date.endsWith('-01-01') &&
              ed.release_date.slice(0, 4) === bestRawDate.slice(0, 4)
            ) {
              bestRawDate = ed.release_date;
            } else if (!bestRawDate && ed.release_date) {
              bestRawDate = ed.release_date;
            }

            const parsedDate = parseHardcoverReleaseDate(
              bestRawDate,
              ed.book.release_year,
              Boolean(coverUrl)
            );
            const primaryAuthor = ed.book.contributions?.[0]?.author;

            matches[item.clientKey] = {
              clientKey: item.clientKey,
              id: `hc:book:${ed.book.id}`,
              source: 'hardcover',
              externalId: String(ed.book.id),
              title: ed.book.title || item.title,
              authorName: primaryAuthor?.name || item.authorName || 'Unknown Author',
              authorExternalId: primaryAuthor ? String(primaryAuthor.id) : undefined,
              coverUrl,
              releaseDate: parsedDate.releaseDate,
              datePrecision: parsedDate.datePrecision,
              pageCount: ed.book.pages || undefined,
              isbn: ed.isbn_13 || ed.isbn_10 || item.isbn13 || item.isbn10,
            };
          }
        }
      } catch {
        // Continue to Pass 2 search fallback if batch ISBN query fails
      }
    }

    // Pass 2: Aliased GraphQL Multi-Search for items without ISBN matches (e.g. Kindle editions or pasted lines)
    const unmatched = items.filter((it) => !matches[it.clientKey]);
    const aliasChunkSize = 6;

    for (let i = 0; i < unmatched.length; i += aliasChunkSize) {
      const slice = unmatched.slice(i, i + aliasChunkSize);
      const varDefs = slice.map((_, idx) => `$q${idx}: String!`).join(', ');
      const aliasBlocks = slice
        .map(
          (_, idx) =>
            `b${idx}: search(query: $q${idx}, query_type: "Book", per_page: 4, page: 1) { results }`
        )
        .join('\n');

      const variables: Record<string, string> = {};
      slice.forEach((item, idx) => {
        const searchStr = item.isbn13
          ? item.isbn13
          : item.isbn10
          ? item.isbn10
          : item.authorName
          ? `${item.title} ${item.authorName}`
          : item.title;
        variables[`q${idx}`] = searchStr.trim();
      });

      try {
        const gql = `query MultiBookSearch(${varDefs}) {\n${aliasBlocks}\n}`;
        const resData = await queryHardcoverGraphQL<
          Record<string, { results?: unknown }>
        >(gql, variables, hardcoverToken);

        const docsByAlias = slice.map((_, idx) =>
          extractSearchHits<HardcoverSearchBookDoc>(resData[`b${idx}`]?.results).filter(
            (d) => Boolean(d.title && !d.compilation)
          )
        );
        const englishIds = await fetchEnglishHardcoverBookIds(
          docsByAlias.flat().map((d) => d.id),
          hardcoverToken
        );

        slice.forEach((item, idx) => {
          const allDocs = docsByAlias[idx];
          // Prefer English records; only fall back to a translation if it's the sole match
          const englishDocs = englishIds
            ? allDocs.filter((d) => englishIds.has(String(d.id)))
            : allDocs;
          const docs = englishDocs.length > 0 ? englishDocs : allDocs;

          if (docs.length === 0) return;

          // Pick best match preferring author match if authorName was given
          let chosen = docs[0];
          if (item.authorName) {
            const authorMatch = docs.find((d) => {
              const candAuthors = [
                ...(d.author_names || []),
                ...(d.contributions?.map((c) => c.author?.name || '') || []),
              ].filter(Boolean);
              return authorMatchesName(candAuthors, item.authorName!);
            });
            if (authorMatch) {
              chosen = authorMatch;
            }
          }

          const primaryAuthor =
            chosen.contributions?.find((c) => c.primary)?.author ||
            chosen.contributions?.[0]?.author;
          const resolvedAuthor =
            primaryAuthor?.name ||
            chosen.author_names?.[0] ||
            item.authorName ||
            'Unknown Author';
          const coverUrl = chosen.image?.url || undefined;
          const parsedDate = parseHardcoverReleaseDate(
            chosen.release_date,
            chosen.release_year,
            Boolean(coverUrl)
          );

          matches[item.clientKey] = {
            clientKey: item.clientKey,
            id: `hc:book:${chosen.id}`,
            source: 'hardcover',
            externalId: String(chosen.id),
            title: chosen.title || item.title,
            authorName: resolvedAuthor,
            authorExternalId:
              primaryAuthor?.id !== undefined
                ? String(primaryAuthor.id)
                : undefined,
            coverUrl,
            releaseDate: parsedDate.releaseDate,
            datePrecision: parsedDate.datePrecision,
            pageCount: chosen.pages || undefined,
            isbn:
              chosen.isbns?.find((x) => x.length === 13) ||
              item.isbn13 ||
              item.isbn10,
          };
        });
      } catch {
        // Ignore transient batch search error
      }

      if (i + aliasChunkSize < unmatched.length) {
        await sleepMs(180);
      }
    }
  }

  // Pass 3: Google Books fallback for any still-unmatched items (capped at 12 per request for speed)
  const stillUnmatched = items
    .filter((it) => !matches[it.clientKey])
    .slice(0, 12);

  if (stillUnmatched.length > 0) {
    const keyParam = googleApiKey
      ? `&key=${encodeURIComponent(googleApiKey)}`
      : '';

    await Promise.all(
      stillUnmatched.map(async (item) => {
        try {
          const q = item.isbn13
            ? `isbn:${item.isbn13}`
            : item.isbn10
            ? `isbn:${item.isbn10}`
            : item.authorName
            ? `intitle:${item.title} inauthor:${item.authorName}`
            : item.title;
          const url = `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
            q
          )}&maxResults=3&printType=books&langRestrict=en${keyParam}`;
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) return;
          const json = await res.json();
          const hit: GoogleVolumeItem | undefined = json.items?.[0];
          if (!hit?.volumeInfo?.title) return;

          const info = hit.volumeInfo;
          const parsedDate = parseReleaseDateInput(info.publishedDate);
          const isbn13 = info.industryIdentifiers?.find(
            (id) => id.type === 'ISBN_13'
          )?.identifier;

          matches[item.clientKey] = {
            clientKey: item.clientKey,
            id: `gb:book:${hit.id}`,
            source: 'google',
            externalId: hit.id,
            title: info.title || item.title,
            authorName: info.authors?.[0] || item.authorName || 'Unknown Author',
            coverUrl: cleanGoogleCoverUrl(
              info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail
            ),
            releaseDate: parsedDate.releaseDate,
            datePrecision: parsedDate.datePrecision,
            pageCount: info.pageCount || undefined,
            isbn: isbn13 || item.isbn13 || item.isbn10,
          };
        } catch {
          // Ignore fallback error
        }
      })
    );
  }

  return { matches };
}

export async function resolveAuthorsBatch(params: {
  names: string[];
  hardcoverToken?: string;
}): Promise<{
  authors: SearchAuthorResult[];
}> {
  const { names, hardcoverToken } = params;
  const cleanedNames = Array.from(
    new Set(names.map((n) => n.trim()).filter(Boolean))
  );
  if (cleanedNames.length === 0) {
    return { authors: [] };
  }

  const resolvedMap = new Map<string, SearchAuthorResult>();

  if (hardcoverToken?.trim()) {
    const aliasChunkSize = 8;
    for (let i = 0; i < cleanedNames.length; i += aliasChunkSize) {
      const slice = cleanedNames.slice(i, i + aliasChunkSize);
      const varDefs = slice.map((_, idx) => `$a${idx}: String!`).join(', ');
      const aliasBlocks = slice
        .map(
          (_, idx) =>
            `a${idx}: search(query: $a${idx}, query_type: "Author", per_page: 3, page: 1) { results }`
        )
        .join('\n');

      const variables: Record<string, string> = {};
      slice.forEach((name, idx) => {
        variables[`a${idx}`] = name;
      });

      try {
        const gql = `query MultiAuthorSearch(${varDefs}) {\n${aliasBlocks}\n}`;
        const resData = await queryHardcoverGraphQL<
          Record<string, { results?: unknown }>
        >(gql, variables, hardcoverToken);

        slice.forEach((inputName, idx) => {
          const docs = extractSearchHits<HardcoverSearchAuthorDoc>(
            resData[`a${idx}`]?.results
          ).filter((d) => Boolean(d.name && d.id !== undefined));

          if (docs.length === 0) return;

          const exact =
            docs.find(
              (d) =>
                d.name &&
                normalizeAuthorKey(d.name) === normalizeAuthorKey(inputName)
            ) || docs[0];

          if (exact?.name) {
            resolvedMap.set(inputName.toLowerCase(), {
              id: `hc:author:${exact.id}`,
              source: 'hardcover',
              externalId: String(exact.id),
              name: exact.name,
              topWork: exact.books?.[0] || undefined,
              booksCount:
                typeof exact.books_count === 'number'
                  ? exact.books_count
                  : undefined,
              imageUrl: exact.image?.url || undefined,
            });
          }
        });
      } catch {
        // Fall through to fallback for unresolved authors
      }

      if (i + aliasChunkSize < cleanedNames.length) {
        await sleepMs(180);
      }
    }
  }

  // Fallback for any author not resolved via Hardcover
  for (const name of cleanedNames) {
    const key = name.toLowerCase();
    if (resolvedMap.has(key)) continue;

    try {
      const olUrl = `${OPEN_LIBRARY_AUTHORS_ENDPOINT}?q=${encodeURIComponent(
        name
      )}&limit=3`;
      const res = await fetch(olUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const doc = data.docs?.[0];
        if (doc?.name && doc?.key) {
          const olid = String(doc.key).replace('/authors/', '');
          resolvedMap.set(key, {
            id: `ol:author:${olid}`,
            source: 'openlibrary',
            externalId: olid,
            name: doc.name,
            topWork: doc.top_work || undefined,
            booksCount:
              typeof doc.work_count === 'number' ? doc.work_count : undefined,
            imageUrl: `https://covers.openlibrary.org/a/olid/${olid}-M.jpg?default=false`,
          });
          continue;
        }
      }
    } catch {
      // Ignore OpenLibrary transient error
    }

    const slug = normalizeAuthorKey(name).replace(/\s+/g, '-');
    resolvedMap.set(key, {
      id: `gb:author:${slug}`,
      source: 'google',
      externalId: name,
      name,
    });
  }

  return {
    authors: cleanedNames
      .map((n) => resolvedMap.get(n.toLowerCase()))
      .filter((a): a is SearchAuthorResult => Boolean(a)),
  };
}
