import {
  areSameCanonicalWork,
  cleanDisplayBookTitle,
  getCanonicalWorkKey,
  hasEditionDecorationInTitle,
  isLikelyNoiseTitle,
  isStrictSecondaryReissueTitle,
  mergeCanonicalBookPair,
  normalizeAuthorCanonicalKey,
  parseCanonicalWorkParts,
  pickCanonicalReleaseDate,
  pickCleanerTitle,
  sanitizeCatalogReleaseDate,
} from '@/lib/bookDedupe';
import {
  cleanGoogleCoverUrl,
  CoverCandidateMeta,
  pickBestHeadOnCoverUrl,
  scoreCoverCandidate,
} from '@/lib/coverArt';
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
const GOOGLE_QUOTA_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes after HTTP 429/403
const MAX_CACHE_ENTRIES = 250;
const serverCatalogCache = new Map<string, CacheEntry<unknown>>();
let googleQuotaExhaustedUntilMs = 0;

function isGoogleBooksAvailable(): boolean {
  return Date.now() >= googleQuotaExhaustedUntilMs;
}

async function fetchGoogleBooksVolumeList(url: string): Promise<GoogleVolumeItem[]> {
  if (!isGoogleBooksAvailable()) return [];
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 429 || res.status === 403) {
      googleQuotaExhaustedUntilMs = Date.now() + GOOGLE_QUOTA_COOLDOWN_MS;
      return [];
    }
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.items) ? json.items : [];
  } catch {
    return [];
  }
}

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

function normalizeAuthorKey(name: string): string {
  return normalizeAuthorCanonicalKey(name);
}

function isLikelyNoiseEdition(title: string, filterUntitled = false): boolean {
  return isLikelyNoiseTitle(title, filterUntitled);
}

function daysBetweenYmd(earlierYmd: string, laterYmd: string): number {
  const a = Date.parse(`${earlierYmd}T00:00:00Z`);
  const b = Date.parse(`${laterYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function isPlaceholderDayDate(ymd: string, currentYear: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const yearNum = Number(ymd.slice(0, 4));
  const md = ymd.slice(5);
  return (
    (md === '01-01' && yearNum >= 2020) ||
    (md === '12-31' && yearNum > currentYear)
  );
}

function parseCatalogReleaseDate(
  releaseDate?: string | null,
  releaseYear?: number | null
): { releaseDate?: string; datePrecision: DatePrecision } {
  const parsed = parseReleaseDateInput(releaseDate, releaseYear);
  const currentYear = new Date().getFullYear();
  return sanitizeCatalogReleaseDate(
    parsed.releaseDate,
    parsed.datePrecision,
    currentYear
  );
}

function parseHardcoverReleaseDate(
  releaseDate?: string | null,
  releaseYear?: number | null
): { releaseDate?: string; datePrecision: DatePrecision } {
  return parseCatalogReleaseDate(releaseDate, releaseYear);
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
  const maxAttempts = 3;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleepMs(1100 * attempt);
    }
    const res = await fetch(HARDCOVER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: buildHardcoverAuthHeader(rawToken),
      },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    });

    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Hardcover HTTP ${res.status}: ${text.slice(0, 180)}`);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hardcover HTTP ${res.status}: ${text.slice(0, 180)}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      const errMsg = String(json.errors[0]?.message || 'Hardcover GraphQL error');
      if (/rate\s*limit|too\s*many/i.test(errMsg) && attempt + 1 < maxAttempts) {
        lastErr = new Error(errMsg);
        continue;
      }
      throw new Error(errMsg);
    }
    return json.data as T;
  }

  throw lastErr || new Error('Hardcover GraphQL request failed after retries');
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

interface HardcoverEditionCoverNode {
  title?: string | null;
  edition_format?: string | null;
  edition_information?: string | null;
  reading_format_id?: number | null;
  isbn_13?: string | null;
  isbn_10?: string | null;
  release_date?: string | null;
  users_count?: number | null;
  publisher?: { name?: string | null } | null;
  image?: { url?: string | null } | null;
}

function selectBestCoverAndIsbnFromHardcoverNode(node: {
  title?: string | null;
  users_count?: number | null;
  image?: { url?: string | null } | null;
  editions?: HardcoverEditionCoverNode[] | null;
}): { coverUrl?: string; isbn?: string } {
  const candidates: CoverCandidateMeta[] = [];

  if (node.image?.url) {
    candidates.push({
      url: node.image.url,
      isCanonicalBookImage: true,
      editionTitle: node.title,
      usersCount: node.users_count,
    });
  }

  let bestIsbn13: string | undefined;
  let bestIsbn10: string | undefined;

  for (const ed of node.editions || []) {
    if (!bestIsbn13 && ed.isbn_13 && ed.reading_format_id !== 2) {
      bestIsbn13 = ed.isbn_13;
    }
    if (!bestIsbn10 && ed.isbn_10 && ed.reading_format_id !== 2) {
      bestIsbn10 = ed.isbn_10;
    }
    if (ed.image?.url) {
      candidates.push({
        url: ed.image.url,
        isCanonicalBookImage: false,
        editionTitle: ed.title || node.title,
        editionFormat: ed.edition_format,
        editionInfo: ed.edition_information,
        readingFormatId: ed.reading_format_id,
        isbn13: ed.isbn_13,
        isbn10: ed.isbn_10,
      });
    }
  }

  const coverUrl = pickBestHeadOnCoverUrl(candidates) || node.image?.url || undefined;
  return {
    coverUrl,
    isbn: bestIsbn13 || bestIsbn10,
  };
}

/**
 * Resolves a Hardcover book's true original publication date (or exact forthcoming street date)
 * by inspecting its English print/ebook editions alongside `release_date` and `release_year`.
 * Fixes trade paperbacks/Book Club reissues whose `books.release_date` was overwritten to a later
 * edition date (e.g. 2025 hardcovers showing as 2026 paperbacks), as well as `null` or `YYYY-01-01`
 * book-level placeholders when an edition already carries the exact release date.
 */
function resolveHardcoverBookOriginalDate(
  node: {
    title?: string | null;
    release_date?: string | null;
    release_year?: number | null;
    users_count?: number | null;
    editions?: Array<{
      title?: string | null;
      release_date?: string | null;
      reading_format_id?: number | null;
      edition_format?: string | null;
      edition_information?: string | null;
      isbn_13?: string | null;
      isbn_10?: string | null;
      users_count?: number | null;
      publisher?: { name?: string | null } | null;
    }> | null;
  },
  todayStr: string = getLocalTodayStr()
): { releaseDate?: string; datePrecision: DatePrecision } {
  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();
  const rawDate = node.release_date?.trim() || null;
  const rawYear = typeof node.release_year === 'number' ? node.release_year : null;
  const usersCount = typeof node.users_count === 'number' ? node.users_count : 0;

  const ARC_PROOF_RE =
    /\b(arc|advance\s+reader|advance\s+reading|uncorrected\s+proof|galley|netgalley|sampler|excerpt|free\s+preview)\b/i;
  const SECONDARY_FORMAT_RE =
    /\b(paperback|mass\s+market|large\s+print|anniversary|reissue|repackage|book\s+club|tie-?in|library\s+binding)\b/i;
  const DELUXE_SPECIAL_RE =
    /\b(deluxe|collector'?s?|limited\s+edition|special\s+edition|signed|autographed|sprayed\s+edges?|stenciled\s+edges?|fairyloot|illumicrate|owlcrate|litjoy|broken\s+binding|subterranean|goldsboro)\b/i;
  const UK_PUBLISHER_RE =
    /\b(uk|hachette\s+uk|gollancz|hodder|pan\s+macmillan|penguin\s+uk|transworld|headline|orion|cornerstone|little,\s*brown\s+book\s+group|bloomsbury\s+uk|harpercollins\s+uk|michael\s+joseph|bantam\s+press|fourth\s+estate|faber|vintage\s+uk|sceptre|jo\s+fletcher|viper|titan\s+books)\b/i;
  const UK_EDITION_INFO_RE =
    /\b(uk\s+edition|u\.k\.\s+edition|british\s+edition|international\s+edition|export\s+edition|commonwealth|anz\s+edition|waterstones)\b/i;
  const UK_ISBN13_PREFIX_RE =
    /^978(?:000[78]|0241|0349|0571|0575|07181|07475|07515|0857|1035|1398|1399|14059|14071|14087|14088|14091|14447|14711|14721|14722|14732|14736|15098|15266|1529[0-9]|178[0-9]{2}|180[0-9]{2}|183[89][0-9]|191[0-9]{2})/;

  const BOGUS_EPOCH_DATES = new Set([
    '1900-01-01',
    '1901-01-01',
    '1969-12-31',
    '1970-01-01',
  ]);

  const cleanEditions = (node.editions || []).filter((ed) => {
    const d = ed.release_date?.trim();
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < '1900-01-01') return false;
    if (BOGUS_EPOCH_DATES.has(d)) return false;
    if (d.endsWith('-01-01') || isPlaceholderDayDate(d, currentYear)) return false;
    const edLabel = `${ed.title || ''} ${ed.edition_information || ''} ${
      ed.edition_format || ''
    }`;
    if (ARC_PROOF_RE.test(edLabel)) return false;
    return true;
  });

  const isSecondaryEdition = (ed: (typeof cleanEditions)[number]): boolean =>
    ed.reading_format_id === 2 ||
    SECONDARY_FORMAT_RE.test(
      `${ed.edition_format || ''} ${ed.edition_information || ''} ${ed.title || ''}`
    );

  const isDeluxeEdition = (ed: (typeof cleanEditions)[number]): boolean =>
    DELUXE_SPECIAL_RE.test(
      `${ed.edition_format || ''} ${ed.edition_information || ''} ${ed.title || ''}`
    );

  const isUkOrExportEdition = (ed: (typeof cleanEditions)[number]): boolean => {
    const pubName = ed.publisher?.name || '';
    const infoLabel = `${ed.edition_information || ''} ${ed.title || ''}`;
    const cleanIsbn13 = (ed.isbn_13 || '').replace(/[^0-9]/g, '');
    return (
      UK_PUBLISHER_RE.test(pubName) ||
      UK_EDITION_INFO_RE.test(infoLabel) ||
      (cleanIsbn13.length === 13 && UK_ISBN13_PREFIX_RE.test(cleanIsbn13))
    );
  };

  const extractSortedDates = (
    filterFn: (ed: (typeof cleanEditions)[number]) => boolean
  ): string[] =>
    Array.from(
      new Set(
        cleanEditions
          .filter(filterFn)
          .map((ed) => ed.release_date!.trim())
      )
    ).sort();

  const primaryUsFirstDates = extractSortedDates(
    (ed) =>
      !isSecondaryEdition(ed) &&
      !isDeluxeEdition(ed) &&
      !isUkOrExportEdition(ed) &&
      Boolean(ed.isbn_13 || ed.isbn_10 || ed.edition_format)
  );
  const primaryAnyFirstDates = extractSortedDates((ed) => !isSecondaryEdition(ed));
  const nonAudioIsbnDates = extractSortedDates(
    (ed) => ed.reading_format_id !== 2 && Boolean(ed.isbn_13 || ed.isbn_10)
  );
  const nonAudioDates = extractSortedDates((ed) => ed.reading_format_id !== 2);
  const validEditionDates =
    nonAudioIsbnDates.length > 0
      ? nonAudioIsbnDates
      : nonAudioDates.length > 0
      ? nonAudioDates
      : extractSortedDates(() => true);

  const preTodayEditionUsers = cleanEditions
    .filter((ed) => ed.release_date!.trim() <= todayStr)
    .reduce(
      (sum, ed) => sum + (typeof ed.users_count === 'number' ? ed.users_count : 0),
      0
    );

  const pickBestOriginalPublishedDate = (maxYmd: string): string | undefined =>
    primaryUsFirstDates.find((d) => d <= maxYmd) ||
    primaryAnyFirstDates.find((d) => d <= maxYmd) ||
    validEditionDates.find((d) => d <= maxYmd);

  const isSecondaryEditionOnDate = (targetYmd: string): boolean => {
    const matching = cleanEditions.filter(
      (ed) => ed.release_date?.trim() === targetYmd
    );
    if (matching.length === 0) return false;
    return matching.every((ed) => isSecondaryEdition(ed) || isDeluxeEdition(ed));
  };

  if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    const rawYearFromStr = Number(rawDate.slice(0, 4));
    const rawIsPlaceholder =
      BOGUS_EPOCH_DATES.has(rawDate) || isPlaceholderDayDate(rawDate, currentYear);

    // Pre-2020 `YYYY-01-01` MARC/library year-placeholder handling (e.g. The Perks of Being a Wallflower `1999-01-01`)
    if (rawDate.endsWith('-01-01') && rawYearFromStr < 2020) {
      const yearPrefix = rawDate.slice(0, 4);
      const sameYearRealEd =
        primaryUsFirstDates.find(
          (d) => d.startsWith(yearPrefix) && !d.endsWith('-01-01')
        ) ||
        primaryAnyFirstDates.find(
          (d) => d.startsWith(yearPrefix) && !d.endsWith('-01-01')
        );
      if (sameYearRealEd) {
        return { releaseDate: sameYearRealEd, datePrecision: 'day' };
      }
      return { releaseDate: yearPrefix, datePrecision: 'year' };
    }

    if (rawDate <= todayStr) {
      const earliestPublishedEd = pickBestOriginalPublishedDate(todayStr);

      if (rawIsPlaceholder && earliestPublishedEd) {
        if (earliestPublishedEd.slice(0, 4) <= rawDate.slice(0, 4)) {
          return { releaseDate: earliestPublishedEd, datePrecision: 'day' };
        }
      }

      // Modern UK-first / pre-delay placeholder check (e.g. The Wolf and His King: UK Nov 27, 2025 -> US 1st Edition Jan 27, 2026)
      if (!rawIsPlaceholder && rawDate >= '2020-01-01') {
        const hasPrimaryUsOnOrBeforeRaw = primaryUsFirstDates.some(
          (d) => d <= rawDate
        );
        if (!hasPrimaryUsOnOrBeforeRaw) {
          const usFirstRelease = primaryUsFirstDates.find(
            (d) =>
              d > rawDate &&
              d <= todayStr &&
              daysBetweenYmd(rawDate, d) >= 1 &&
              daysBetweenYmd(rawDate, d) <= 150
          );
          if (usFirstRelease) {
            return { releaseDate: usFirstRelease, datePrecision: 'day' };
          }
        }
      }

      if (!rawIsPlaceholder && earliestPublishedEd && earliestPublishedEd < rawDate) {
        const gapDays = daysBetweenYmd(earliestPublishedEd, rawDate);
        // Restore original publication date when `rawDate` was bumped to a 6+ month later
        // paperback/deluxe/book-club reissue (e.g. Atmosphere Jun 2025 -> Jun 2026,
        // Emily Wilde Feb 2025 -> Nov 2025, City of Brass 2017 -> 2025), or when format/year proves it.
        if (
          gapDays >= 180 ||
          (rawYear !== null && rawYear >= 1900 && rawYear < rawYearFromStr) ||
          isSecondaryEditionOnDate(rawDate) ||
          hasEditionDecorationInTitle(node.title || '')
        ) {
          return { releaseDate: earliestPublishedEd, datePrecision: 'day' };
        }
      }

      // Conversely, if EVERY English edition in Hardcover is 14-550 days AFTER `books.release_date`
      // on a modern title (publisher street-date pushback where `books.release_date` stayed stale),
      // use the actual earliest English edition release date (including when pushed into the future!).
      const earliestAnyEd = validEditionDates.find((d) => d <= todayStr);
      if (
        !rawIsPlaceholder &&
        earliestAnyEd &&
        earliestAnyEd > rawDate &&
        rawDate >= '2020-01-01'
      ) {
        const slipDays = daysBetweenYmd(rawDate, earliestAnyEd);
        const edYr = Number(earliestAnyEd.slice(0, 4));
        if (
          slipDays >= 14 &&
          slipDays <= 400 &&
          (rawYear === null || rawYear >= edYr || rawYear > rawYearFromStr)
        ) {
          return { releaseDate: earliestAnyEd, datePrecision: 'day' };
        }
      }

      if (
        !earliestAnyEd &&
        preTodayEditionUsers === 0 &&
        rawDate >= `${currentYear - 1}-01-01`
      ) {
        const futurePushedEd =
          primaryUsFirstDates.find((d) => d > todayStr) ||
          primaryAnyFirstDates.find((d) => d > todayStr);
        if (futurePushedEd && daysBetweenYmd(rawDate, futurePushedEd) <= 550) {
          return { releaseDate: futurePushedEd, datePrecision: 'day' };
        }
      }

      if (rawYear && rawYear >= 1900 && rawYear < rawYearFromStr) {
        return { releaseDate: String(rawYear), datePrecision: 'year' };
      }

      return parseHardcoverReleaseDate(rawDate, rawYear);
    }

    // `rawDate > todayStr`: check if this work was actually already published earlier.
    // Guard against unreleased delayed books whose `books.users_count` reflects Want-to-Read shelves
    // and whose old pre-delay edition stub has ~0 actual edition users.
    const earliestPublishedEd = [
      ...primaryUsFirstDates,
      ...primaryAnyFirstDates,
      ...validEditionDates,
    ].find((d) => d <= todayStr && daysBetweenYmd(d, rawDate) >= 150);

    if (
      earliestPublishedEd &&
      (preTodayEditionUsers >= 6 ||
        isStrictSecondaryReissueTitle(node.title || '') ||
        hasEditionDecorationInTitle(node.title || '') ||
        Boolean(rawYear && rawYear >= 1900 && rawYear <= currentYear - 2) ||
        (usersCount >= 300 &&
          daysBetweenYmd(earliestPublishedEd, rawDate) >= 320))
    ) {
      return { releaseDate: earliestPublishedEd, datePrecision: 'day' };
    }

    if (
      rawYear &&
      rawYear >= 1900 &&
      rawYear <= currentYear - 2 &&
      (preTodayEditionUsers >= 6 ||
        usersCount >= 50 ||
        isStrictSecondaryReissueTitle(node.title || '') ||
        hasEditionDecorationInTitle(node.title || ''))
    ) {
      return { releaseDate: String(rawYear), datePrecision: 'year' };
    }

    if (rawIsPlaceholder) {
      const futureValidEd =
        primaryUsFirstDates.find((d) => d > todayStr) ||
        primaryAnyFirstDates.find((d) => d > todayStr) ||
        validEditionDates.find((d) => d > todayStr);
      if (futureValidEd) {
        return { releaseDate: futureValidEd, datePrecision: 'day' };
      }
    }

    return parseHardcoverReleaseDate(rawDate, rawYear);
  }

  // `rawDate` is null or non-YYYY-MM-DD: use earliest valid edition date if available
  const pool =
    primaryUsFirstDates.length > 0
      ? primaryUsFirstDates
      : primaryAnyFirstDates.length > 0
      ? primaryAnyFirstDates
      : validEditionDates;
  if (pool.length > 0) {
    const chosenEd =
      rawYear && rawYear >= 1900
        ? pool.find((d) => Math.abs(Number(d.slice(0, 4)) - rawYear) <= 1) ||
          pool[0]
        : pool[0];
    return { releaseDate: chosenEd, datePrecision: 'day' };
  }

  return parseHardcoverReleaseDate(rawDate, rawYear);
}

/**
 * Given Hardcover book IDs (e.g. from Typesense search hits, which carry no language or edition cover data),
 * returns the subset that are English-language releases along with each book's best flat head-on edition cover
 * and edition-verified original/exact release date.
 * Degrades gracefully to bare ID check or null if the lookup fails.
 */
async function fetchEnglishHardcoverBooksMeta(
  ids: Array<string | number>,
  token: string,
  todayOverride?: string
): Promise<{
  englishIds: Set<string>;
  bestCovers: Map<string, string>;
  bestDates: Map<string, { releaseDate?: string; datePrecision: DatePrecision }>;
  usersCounts: Map<string, number>;
} | null> {
  const numericIds = Array.from(
    new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  );
  if (numericIds.length === 0) {
    return {
      englishIds: new Set(),
      bestCovers: new Map(),
      bestDates: new Map(),
      usersCounts: new Map(),
    };
  }

  const todayStr =
    todayOverride && /^\d{4}-\d{2}-\d{2}$/.test(todayOverride)
      ? todayOverride
      : getLocalTodayStr();

  try {
    const data = await queryHardcoverGraphQL<{
      books?: Array<{
        id: number;
        title?: string | null;
        release_date?: string | null;
        release_year?: number | null;
        users_count?: number | null;
        image?: { url?: string | null } | null;
        editions?: HardcoverEditionCoverNode[] | null;
      }>;
    }>(
      `query EnglishBooksWithCovers($ids: [Int!]!) {
        books(where: { id: { _in: $ids }, ${HARDCOVER_ENGLISH_BOOK_FILTER} }, limit: ${numericIds.length}) {
          id
          title
          release_date
          release_year
          users_count
          image {
            url
          }
          editions(
            where: {
              _or: [
                { language: { code2: { _eq: "en" } } }
                { language_id: { _is_null: true } }
              ]
            }
            order_by: { release_date: asc_nulls_last }
            limit: 30
          ) {
            title
            edition_format
            edition_information
            reading_format_id
            isbn_13
            isbn_10
            release_date
            users_count
            publisher {
              name
            }
            image {
              url
            }
          }
        }
      }`,
      { ids: numericIds },
      token
    );

    const englishIds = new Set<string>();
    const bestCovers = new Map<string, string>();
    const bestDates = new Map<
      string,
      { releaseDate?: string; datePrecision: DatePrecision }
    >();
    const usersCounts = new Map<string, number>();
    for (const b of data.books || []) {
      const idStr = String(b.id);
      englishIds.add(idStr);
      usersCounts.set(idStr, typeof b.users_count === 'number' ? b.users_count : 0);
      const { coverUrl } = selectBestCoverAndIsbnFromHardcoverNode(b);
      if (coverUrl) {
        bestCovers.set(idStr, coverUrl);
      }
      bestDates.set(idStr, resolveHardcoverBookOriginalDate(b, todayStr));
    }
    return { englishIds, bestCovers, bestDates, usersCounts };
  } catch {
    try {
      const fallback = await queryHardcoverGraphQL<{ books?: Array<{ id: number }> }>(
        `query EnglishBooks($ids: [Int!]!) {
          books(where: { id: { _in: $ids }, ${HARDCOVER_ENGLISH_BOOK_FILTER} }, limit: ${numericIds.length}) {
            id
          }
        }`,
        { ids: numericIds },
        token
      );
      return {
        englishIds: new Set((fallback.books || []).map((b) => String(b.id))),
        bestCovers: new Map(),
        bestDates: new Map(),
        usersCounts: new Map(),
      };
    } catch {
      return null;
    }
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
  // record is the one that claims each title, and resolve flat head-on edition covers + dates.
  const englishMeta = await fetchEnglishHardcoverBooksMeta(
    bookDocs.map((d) => d.id),
    token
  );
  const englishIds = englishMeta?.englishIds ?? null;
  const bestCovers = englishMeta?.bestCovers;
  const bestDates = englishMeta?.bestDates;

  const books: SearchBookResult[] = [];

  for (const doc of bookDocs) {
    if (!doc.title || doc.id === undefined) continue;
    const docIdStr = String(doc.id);
    if (englishIds && !englishIds.has(docIdStr)) continue;
    if (doc.compilation) continue;
    if (isLikelyNoiseEdition(doc.title, false)) continue;

    const primaryAuthor =
      doc.contributions?.find((c) => c.primary)?.author ||
      doc.contributions?.[0]?.author;
    const authorName =
      primaryAuthor?.name || doc.author_names?.[0] || 'Unknown Author';

    const coverUrl = bestCovers?.get(docIdStr) || doc.image?.url || undefined;
    const resolvedMetaDate = bestDates?.get(docIdStr);
    const parsedDate =
      resolvedMetaDate && resolvedMetaDate.datePrecision !== 'unknown'
        ? resolvedMetaDate
        : parseHardcoverReleaseDate(doc.release_date, doc.release_year);

    const candidate: SearchBookResult = {
      id: `hc:book:${doc.id}`,
      source: 'hardcover',
      externalId: docIdStr,
      title: cleanDisplayBookTitle(doc.title),
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
    };

    const existingIdx = books.findIndex((existing) =>
      areSameCanonicalWork(existing, { title: doc.title!, authorName })
    );
    if (existingIdx >= 0) {
      const existing = books[existingIdx];
      const mergedDate = pickCanonicalReleaseDate(
        {
          id: existing.id,
          source: existing.source,
          title: existing.title,
          authorName: existing.authorName,
          releaseDate: existing.releaseDate,
          datePrecision: existing.datePrecision,
          isOneOff: false,
          isManual: false,
          readingStatus: 'none',
          updatedAt: '',
        },
        {
          id: candidate.id,
          source: candidate.source,
          title: doc.title,
          authorName: candidate.authorName,
          releaseDate: candidate.releaseDate,
          datePrecision: candidate.datePrecision,
          isOneOff: false,
          isManual: false,
          readingStatus: 'none',
          updatedAt: '',
        },
        getLocalTodayStr()
      );
      books[existingIdx] = {
        ...existing,
        title: pickCleanerTitle(existing.title, doc.title),
        coverUrl: existing.coverUrl || candidate.coverUrl,
        releaseDate: mergedDate.releaseDate,
        datePrecision: mergedDate.datePrecision,
        description: existing.description || candidate.description,
        pageCount: existing.pageCount || candidate.pageCount,
        isbn: existing.isbn || candidate.isbn,
      };
      continue;
    }

    books.push(candidate);
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
      extraLarge?: string;
      large?: string;
      medium?: string;
      small?: string;
      thumbnail?: string;
      smallThumbnail?: string;
    };
    industryIdentifiers?: Array<{
      type?: string;
      identifier?: string;
    }>;
  };
}

function pickGoogleVolumeCoverUrl(
  imageLinks?: NonNullable<GoogleVolumeItem['volumeInfo']>['imageLinks']
): string | undefined {
  if (!imageLinks) return undefined;
  return cleanGoogleCoverUrl(
    imageLinks.large ||
      imageLinks.medium ||
      imageLinks.small ||
      imageLinks.thumbnail ||
      imageLinks.smallThumbnail
  );
}

function composeGoogleVolumeFullTitle(
  info: NonNullable<GoogleVolumeItem['volumeInfo']>
): string {
  const base = (info.title || '').trim();
  const sub = (info.subtitle || '').trim();
  if (!sub) return base;
  if (base.toLowerCase().includes(sub.toLowerCase())) return base;
  return `${base}: ${sub}`;
}

function pickGoogleVolumeDisplayTitle(
  info: NonNullable<GoogleVolumeItem['volumeInfo']>
): string {
  const base = cleanDisplayBookTitle(info.title || '');
  const sub = (info.subtitle || '').trim();
  if (!sub) return base;
  const full = `${info.title}: ${sub}`;
  // Preserve distinct sequel/volume subtitles, but drop marketing subtitles like "A Novel" or "Reese's Book Club"
  if (
    isStrictSecondaryReissueTitle(full) ||
    /\b(a\s+novel|a\s+memoir|a\s+thriller|book\s+club|bestseller|edition|paperback|hardcover)\b/i.test(
      sub
    )
  ) {
    return base;
  }
  return cleanDisplayBookTitle(full);
}

function precisionRank(p: DatePrecision): number {
  if (p === 'day') return 3;
  if (p === 'month') return 2;
  if (p === 'year') return 1;
  return 0;
}

function mergeGoogleDateIntoHardcoverItem(
  hcDate: { releaseDate?: string; datePrecision: DatePrecision },
  gb: {
    releaseDate?: string;
    datePrecision: DatePrecision;
    isbn?: string;
    pageCount?: number;
  },
  todayStr: string
): { releaseDate?: string; datePrecision: DatePrecision } {
  if (!gb.releaseDate || gb.datePrecision === 'unknown') {
    return hcDate;
  }

  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();

  // 1. Upgrade missing, year-only, or month-only Hardcover dates when Google Books has higher precision
  if (
    precisionRank(hcDate.datePrecision) < 3 &&
    precisionRank(gb.datePrecision) > precisionRank(hcDate.datePrecision)
  ) {
    if (!hcDate.releaseDate) {
      return { releaseDate: gb.releaseDate, datePrecision: gb.datePrecision };
    }
    const hcYear = Number(hcDate.releaseDate.slice(0, 4));
    const gbYear = Number(gb.releaseDate.slice(0, 4));
    if (
      Math.abs(gbYear - hcYear) <= 1 ||
      (gb.datePrecision === 'day' && gb.releaseDate <= todayStr && gbYear < hcYear)
    ) {
      return { releaseDate: gb.releaseDate, datePrecision: gb.datePrecision };
    }
  }

  // 2. Restore original publication date ONLY for genuine multi-year backlist reissues (gap >= 550 days)
  // or explicit secondary/deluxe reissue titles — never let stale pre-delay Google Books ONIX stubs
  // (e.g. a 9-12 month delayed debut's cancelled solicitation date) override Hardcover's edition-verified street date.
  if (
    hcDate.releaseDate &&
    hcDate.releaseDate >= '2018' &&
    gb.datePrecision === 'day' &&
    gb.releaseDate <= todayStr &&
    gb.releaseDate >= '1950-01-01' &&
    !isPlaceholderDayDate(gb.releaseDate, currentYear) &&
    Boolean(gb.isbn || (gb.pageCount && gb.pageCount >= 40))
  ) {
    const hcComparable =
      hcDate.datePrecision === 'day'
        ? hcDate.releaseDate
        : hcDate.datePrecision === 'month'
        ? `${hcDate.releaseDate}-15`
        : `${hcDate.releaseDate}-06-15`;
    const gapDays = daysBetweenYmd(gb.releaseDate, hcComparable);
    if (gapDays >= 550 && gapDays <= 365 * 40) {
      return { releaseDate: gb.releaseDate, datePrecision: 'day' };
    }
  }

  return hcDate;
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
  const todayStr = getLocalTodayStr();

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
        const items = await fetchGoogleBooksVolumeList(gbUrl);
        if (items.length === 0) return;

        for (const item of items) {
          const info = item.volumeInfo;
          if (!info?.title) continue;
          if (info.language && info.language !== 'en') continue;
          const fullTitle = composeGoogleVolumeFullTitle(info);
          if (isLikelyNoiseEdition(fullTitle)) continue;

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
                    topWork: cleanDisplayBookTitle(info.title),
                  });
                }
              }
            }
          }

          if (mode === 'authors') continue;

          const parsedDate = parseCatalogReleaseDate(info.publishedDate);
          const isbn13 = info.industryIdentifiers?.find(
            (id) => id.type === 'ISBN_13'
          )?.identifier;
          const isbn10 = info.industryIdentifiers?.find(
            (id) => id.type === 'ISBN_10'
          )?.identifier;

          const candidate: SearchBookResult = {
            id: `gb:book:${item.id}`,
            source: 'google',
            externalId: item.id,
            title: pickGoogleVolumeDisplayTitle(info),
            authorName,
            authorExternalId: authorName,
            authorSource: 'google',
            coverUrl: pickGoogleVolumeCoverUrl(info.imageLinks),
            releaseDate: parsedDate.releaseDate,
            datePrecision: parsedDate.datePrecision,
            description: info.description || undefined,
            pageCount: info.pageCount || undefined,
            isbn: isbn13 || isbn10,
          };

          const existingIdx = books.findIndex((existing) =>
            areSameCanonicalWork(existing, { title: fullTitle, authorName })
          );
          if (existingIdx >= 0) {
            const existing = books[existingIdx];
            const bestDate = pickCanonicalReleaseDate(
              {
                id: existing.id,
                source: existing.source,
                title: existing.title,
                authorName: existing.authorName,
                releaseDate: existing.releaseDate,
                datePrecision: existing.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              {
                id: candidate.id,
                source: candidate.source,
                title: fullTitle,
                authorName: candidate.authorName,
                releaseDate: candidate.releaseDate,
                datePrecision: candidate.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              todayStr
            );
            books[existingIdx] = {
              ...existing,
              title: pickCleanerTitle(existing.title, candidate.title),
              coverUrl: existing.coverUrl || candidate.coverUrl,
              releaseDate: bestDate.releaseDate,
              datePrecision: bestDate.datePrecision,
              description: existing.description || candidate.description,
              pageCount: existing.pageCount || candidate.pageCount,
              isbn: existing.isbn || candidate.isbn,
            };
            continue;
          }

          books.push(candidate);
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
  const cacheKey = `search:v5:en:${mode}::${Boolean(hardcoverToken?.trim())}::${query
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

  const todayStr = getLocalTodayStr();

  if (hardcoverToken?.trim()) {
    try {
      const [hcResult, gbSupplementary] = await Promise.all([
        searchHardcoverCatalog(query, hardcoverToken, mode),
        mode !== 'authors'
          ? searchFallbackCatalog(query, 'books', googleApiKey)
          : Promise.resolve({ authors: [], books: [] as SearchBookResult[] }),
      ]);

      if (hcResult.authors.length > 0 || hcResult.books.length > 0) {
        const mergedBooks = hcResult.books.map((hcBook) => {
          const gbMatch = gbSupplementary.books.find((gb) =>
            areSameCanonicalWork(hcBook, gb)
          );
          if (!gbMatch) return hcBook;
          const mergedDate = mergeGoogleDateIntoHardcoverItem(
            {
              releaseDate: hcBook.releaseDate,
              datePrecision: hcBook.datePrecision,
            },
            gbMatch,
            todayStr
          );
          return {
            ...hcBook,
            coverUrl: hcBook.coverUrl || gbMatch.coverUrl,
            releaseDate: mergedDate.releaseDate,
            datePrecision: mergedDate.datePrecision,
            description: hcBook.description || gbMatch.description,
            pageCount: hcBook.pageCount || gbMatch.pageCount,
            isbn: hcBook.isbn || gbMatch.isbn,
          };
        });

        let addedFromGoogle = 0;
        for (const gbBook of gbSupplementary.books) {
          if (addedFromGoogle >= 6) break;
          if (isStrictSecondaryReissueTitle(gbBook.title)) continue;
          if (mergedBooks.some((b) => areSameCanonicalWork(b, gbBook))) continue;
          mergedBooks.push(gbBook);
          addedFromGoogle += 1;
        }

        const out = {
          authors: hcResult.authors,
          books: mergedBooks,
          providerUsed:
            addedFromGoogle > 0 ? ('hybrid' as const) : ('hardcover' as const),
        };
        setCachedValue(cacheKey, out);
        return out;
      }

      const fallback =
        mode === 'books'
          ? gbSupplementary
          : await searchFallbackCatalog(query, mode, googleApiKey);
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
  editions?: HardcoverEditionCoverNode[] | null;
}

const HARDCOVER_EDITION_COVER_FRAGMENT = `
  editions(
    where: {
      _or: [
        { language: { code2: { _eq: "en" } } }
        { language_id: { _is_null: true } }
      ]
    }
    order_by: { release_date: asc_nulls_last }
    limit: 30
  ) {
    title
    edition_format
    edition_information
    reading_format_id
    isbn_13
    isbn_10
    release_date
    users_count
    publisher {
      name
    }
    image {
      url
    }
  }
`;

async function fetchHardcoverAuthorBooks(params: {
  authorId: string;
  authorName: string;
  externalId?: string;
  source: DataSource;
  token: string;
  todayStr?: string;
}): Promise<
  Array<{ book: BookItem; usersCount: number; fromUnscheduled: boolean }>
> {
  const { authorId, authorName, externalId, source, token, todayStr: todayOverride } = params;
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

  const todayStr =
    todayOverride && /^\d{4}-\d{2}-\d{2}$/.test(todayOverride)
      ? todayOverride
      : getLocalTodayStr();

  const bibQueryWithEditionCovers = `
    query AuthorBibliography($hcAuthorId: Int!, $today: date!) {
      upcoming: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
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
        ${HARDCOVER_EDITION_COVER_FRAGMENT}
      }
      unscheduled: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _is_null: true }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: { id: desc }
        limit: 25
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
        ${HARDCOVER_EDITION_COVER_FRAGMENT}
      }
      released: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _lte: $today }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: [{ users_count: desc_nulls_last }, { release_date: asc_nulls_last }]
        limit: 150
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
        ${HARDCOVER_EDITION_COVER_FRAGMENT}
      }
    }
  `;

  const fallbackBibQuery = `
    query AuthorBibliographyBasic($hcAuthorId: Int!, $today: date!) {
      upcoming: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
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
        editions(
          where: {
            release_date: { _is_null: false }
            _or: [
              { language: { code2: { _eq: "en" } } }
              { language_id: { _is_null: true } }
            ]
          }
          order_by: { release_date: asc }
          limit: 5
        ) {
          release_date
        }
      }
      unscheduled: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _is_null: true }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: { id: desc }
        limit: 20
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
        editions(
          where: {
            release_date: { _is_null: false }
            _or: [
              { language: { code2: { _eq: "en" } } }
              { language_id: { _is_null: true } }
            ]
          }
          order_by: { release_date: asc }
          limit: 5
        ) {
          release_date
        }
      }
      released: books(
        where: {
          contributions: {
            author_id: { _eq: $hcAuthorId }
            _or: [
              { contribution: { _is_null: true } }
              { contribution: { _eq: "Author" } }
              { contribution: { _eq: "Writer" } }
            ]
          }
          canonical_id: { _is_null: true }
          compilation: { _eq: false }
          release_date: { _lte: $today }
          ${HARDCOVER_ENGLISH_BOOK_FILTER}
        }
        order_by: [{ users_count: desc_nulls_last }, { release_date: asc_nulls_last }]
        limit: 150
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
        editions(
          where: {
            release_date: { _is_null: false }
            _or: [
              { language: { code2: { _eq: "en" } } }
              { language_id: { _is_null: true } }
            ]
          }
          order_by: { release_date: asc_nulls_last }
          limit: 12
        ) {
          release_date
          reading_format_id
          edition_format
        }
      }
    }
  `;

  let data: {
    upcoming?: HardcoverBibBookNode[];
    unscheduled?: HardcoverBibBookNode[];
    released?: HardcoverBibBookNode[];
  };
  try {
    data = await queryHardcoverGraphQL<{
      upcoming?: HardcoverBibBookNode[];
      unscheduled?: HardcoverBibBookNode[];
      released?: HardcoverBibBookNode[];
    }>(bibQueryWithEditionCovers, { hcAuthorId: numericAuthorId, today: todayStr }, token);
  } catch {
    data = await queryHardcoverGraphQL<{
      upcoming?: HardcoverBibBookNode[];
      unscheduled?: HardcoverBibBookNode[];
      released?: HardcoverBibBookNode[];
    }>(fallbackBibQuery, { hcAuthorId: numericAuthorId, today: todayStr }, token);
  }

  // Process already-released books FIRST so self-pub / first-edition releases establish
  // the canonical work before any upcoming paperback or traditional retail re-releases.
  const orderedNodes: Array<{
    node: HardcoverBibBookNode;
    fromUpcoming: boolean;
    fromUnscheduled: boolean;
  }> = [
    ...(data.released || []).map((node) => ({
      node,
      fromUpcoming: false,
      fromUnscheduled: false,
    })),
    ...(data.upcoming || []).map((node) => ({
      node,
      fromUpcoming: true,
      fromUnscheduled: false,
    })),
    ...(data.unscheduled || []).map((node) => ({
      node,
      fromUpcoming: true,
      fromUnscheduled: true,
    })),
  ];

  const nowIso = new Date().toISOString();
  const deduped: Array<{
    book: BookItem;
    usersCount: number;
    fromUnscheduled: boolean;
  }> = [];

  for (const { node: b, fromUpcoming, fromUnscheduled } of orderedNodes) {
    if (!b.title || isLikelyNoiseEdition(b.title, true)) continue;

    // Skip secondary format reissues (Trade Paperback, Mass Market, Large Print, Anniversary, Book Club, Tie-In, etc.)
    // when they show up as upcoming or unscheduled releases.
    if (fromUpcoming && isStrictSecondaryReissueTitle(b.title)) {
      continue;
    }

    const workKey = getCanonicalWorkKey(b.title, authorName);
    if (!workKey || workKey.startsWith('::')) continue;

    const { coverUrl, isbn } = selectBestCoverAndIsbnFromHardcoverNode(b);
    const usersCount = typeof b.users_count === 'number' ? b.users_count : 0;

    // Inspect English editions + release_year on BOTH released AND upcoming/unscheduled nodes so
    // trade paperbacks (e.g. Atmosphere 2026 paperback vs 2025 hardcover) and null-date books resolve accurately.
    const parsedDate = resolveHardcoverBookOriginalDate(b, todayStr);

    const candidate: BookItem = {
      id: `hc:book:${b.id}`,
      source: 'hardcover',
      externalId: String(b.id),
      title: cleanDisplayBookTitle(b.title),
      authorName,
      authorId,
      coverUrl,
      releaseDate: parsedDate.releaseDate,
      datePrecision: parsedDate.datePrecision,
      description: b.description || undefined,
      pageCount: b.pages || undefined,
      isbn,
      isOneOff: false,
      isManual: false,
      readingStatus: 'none',
      updatedAt: nowIso,
    };

    const existingIdx = deduped.findIndex((entry) =>
      areSameCanonicalWork(entry.book, candidate)
    );

    if (existingIdx < 0) {
      deduped.push({ book: candidate, usersCount, fromUnscheduled });
    } else {
      const existing = deduped[existingIdx];
      const merged = mergeCanonicalBookPair(existing.book, candidate, todayStr, {
        aUsersCount: existing.usersCount,
        bUsersCount: usersCount,
      });
      deduped[existingIdx] = {
        book: merged,
        usersCount: Math.max(existing.usersCount, usersCount),
        fromUnscheduled: existing.fromUnscheduled && fromUnscheduled,
      };
    }
  }

  return deduped;
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
      vaNorm.startsWith(targetTokens[0][0]) &&
      vaNorm.endsWith(lastToken)
    ) {
      return true;
    }
    return false;
  });
}

async function lookupBestGoogleBookMatch(params: {
  title: string;
  authorName?: string;
  isbn13?: string;
  isbn10?: string;
  googleApiKey?: string;
  todayStr?: string;
}): Promise<{
  id: string;
  externalId: string;
  title: string;
  authorName: string;
  coverUrl?: string;
  releaseDate?: string;
  datePrecision: DatePrecision;
  description?: string;
  pageCount?: number;
  isbn?: string;
} | null> {
  const {
    title,
    authorName,
    isbn13,
    isbn10,
    googleApiKey,
    todayStr = getLocalTodayStr(),
  } = params;
  const cleanedTitle = cleanDisplayBookTitle(title);
  const parsedWork = parseCanonicalWorkParts(cleanedTitle);
  const hasDistinctSubtitle = Boolean(
    parsedWork.subKey && !parsedWork.isDescriptiveSub
  );
  const cleanFullSearchTitle = cleanedTitle
    .replace(/\([^)]*\)/g, '')
    .replace(/['’‘`]/g, "'")
    .replace(/"/g, '')
    .trim();
  const rawHead = (
    cleanedTitle.split(/\s*[:—–(]\s*/)[0].trim() ||
    cleanedTitle ||
    title.trim()
  )
    .replace(/['’‘`]/g, "'")
    .replace(/"/g, '');
  if (!rawHead) return null;

  const primarySearchPhrase =
    hasDistinctSubtitle && cleanFullSearchTitle ? cleanFullSearchTitle : rawHead;

  const cleanAuthor = (authorName || '').replace(/"/g, '').trim();
  const normAuthor = normalizeAuthorKey(authorName || '');
  const authorTokens = normAuthor.split(' ').filter(Boolean);
  const lastAuthorToken = authorTokens[authorTokens.length - 1] || '';

  const keyParam = googleApiKey
    ? `&key=${encodeURIComponent(googleApiKey)}`
    : '';

  const fetchVolumes = async (q: string): Promise<GoogleVolumeItem[]> => {
    const url = `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      q
    )}&maxResults=20&printType=books&langRestrict=en${keyParam}`;
    return fetchGoogleBooksVolumeList(url);
  };

  // Query by quoted phrase + full author name first so single-word titles with common
  // surnames (e.g. "Atmosphere" by Taylor Jenkins Reid) and subtitled companion works resolve accurately.
  const primaryQuery = cleanAuthor
    ? `"${primarySearchPhrase}" inauthor:"${cleanAuthor}"`
    : `"${primarySearchPhrase}"`;

  let rawItems = await fetchVolumes(primaryQuery);

  const filterMatchingVolumes = (items: GoogleVolumeItem[]): BookItem[] => {
    const rawMatched: Array<{ item: BookItem; isSecondaryReissue: boolean }> = [];
    const nowIso = new Date().toISOString();

    for (const item of items) {
      const info = item.volumeInfo;
      if (!info?.title) continue;
      if (info.language && info.language !== 'en') continue;
      if (authorName && !authorMatchesName(info.authors, authorName)) continue;

      const fullTitle = composeGoogleVolumeFullTitle(info);
      if (isLikelyNoiseEdition(fullTitle, false)) continue;

      const resolvedAuthor = info.authors?.[0] || authorName || 'Unknown Author';
      if (
        !areSameCanonicalWork(
          { title: fullTitle, authorName: resolvedAuthor },
          { title, authorName: authorName || resolvedAuthor }
        )
      ) {
        continue;
      }

      const parsedDate = parseCatalogReleaseDate(info.publishedDate);
      const isSecondaryReissue = isStrictSecondaryReissueTitle(fullTitle);
      if (
        parsedDate.releaseDate &&
        parsedDate.releaseDate > todayStr &&
        isSecondaryReissue
      ) {
        continue;
      }

      const volIsbn13 = info.industryIdentifiers?.find(
        (id) => id.type === 'ISBN_13'
      )?.identifier;
      const volIsbn10 = info.industryIdentifiers?.find(
        (id) => id.type === 'ISBN_10'
      )?.identifier;

      rawMatched.push({
        isSecondaryReissue,
        item: {
          id: `gb:book:${item.id}`,
          source: 'google',
          externalId: item.id,
          title: pickGoogleVolumeDisplayTitle(info),
          authorName: resolvedAuthor,
          coverUrl: pickGoogleVolumeCoverUrl(info.imageLinks),
          releaseDate: parsedDate.releaseDate,
          datePrecision: parsedDate.datePrecision,
          description: info.description || undefined,
          pageCount: info.pageCount || undefined,
          isbn: volIsbn13 || volIsbn10,
          isOneOff: false,
          isManual: false,
          readingStatus: 'none',
          updatedAt: nowIso,
        },
      });
    }

    const nonReissues = rawMatched.filter((x) => !x.isSecondaryReissue);
    return (nonReissues.length > 0 ? nonReissues : rawMatched).map(
      (x) => x.item
    );
  };

  let candidates = filterMatchingVolumes(rawItems);

  if (candidates.length === 0 && lastAuthorToken) {
    rawItems = await fetchVolumes(`"${rawHead}" inauthor:${lastAuthorToken}`);
    candidates = filterMatchingVolumes(rawItems);
  }

  if (candidates.length === 0) {
    const looseQuery = cleanAuthor ? `${rawHead} ${cleanAuthor}` : rawHead;
    rawItems = await fetchVolumes(looseQuery);
    candidates = filterMatchingVolumes(rawItems);
  }

  if (candidates.length === 0 && (isbn13 || isbn10)) {
    rawItems = await fetchVolumes(`isbn:${isbn13 || isbn10}`);
    candidates = filterMatchingVolumes(rawItems);
  }

  if (candidates.length === 0) {
    return null;
  }

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    best = mergeCanonicalBookPair(best, candidates[i], todayStr);
  }

  return {
    id: best.id,
    externalId: best.externalId || best.id.replace(/^gb:book:/, ''),
    title: best.title,
    authorName: best.authorName,
    coverUrl: best.coverUrl,
    releaseDate: best.releaseDate,
    datePrecision: best.datePrecision,
    description: best.description,
    pageCount: best.pageCount,
    isbn: best.isbn,
  };
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
  const trimmedAuthor = authorName.trim();
  const exactAuthorQuery = `inauthor:"${trimmedAuthor}"`;

  const urls = [
    `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      exactAuthorQuery
    )}&orderBy=newest&maxResults=40&printType=books&langRestrict=en${keyParam}`,
    `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
      exactAuthorQuery
    )}&orderBy=relevance&maxResults=40&printType=books&langRestrict=en${keyParam}`,
  ];

  // Publishers frequently space author initials differently on Google Books ("A. K. Larkwood" vs "A.K. Larkwood")
  const normTokens = normalizeAuthorKey(trimmedAuthor).split(' ').filter(Boolean);
  const lastToken = normTokens[normTokens.length - 1] || '';
  if (/\b[A-Za-z]\./.test(trimmedAuthor) && lastToken.length >= 4) {
    urls.push(
      `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
        `inauthor:${lastToken}`
      )}&orderBy=newest&maxResults=40&printType=books&langRestrict=en${keyParam}`
    );
  }

  const responses = await Promise.all(
    urls.map((u) => fetchGoogleBooksVolumeList(u))
  );

  const rawItems: GoogleVolumeItem[] = responses.flat();

  const todayStr = getLocalTodayStr();
  const nowIso = new Date().toISOString();
  const deduped: BookItem[] = [];

  for (const item of rawItems) {
    const info = item.volumeInfo;
    if (!info?.title) continue;
    if (info.language && info.language !== 'en') continue;
    if (!authorMatchesName(info.authors, authorName)) continue;

    const fullTitle = composeGoogleVolumeFullTitle(info);
    if (isLikelyNoiseEdition(fullTitle, true)) continue;

    const parsedDate = parseCatalogReleaseDate(info.publishedDate);
    if (
      parsedDate.releaseDate &&
      parsedDate.releaseDate > todayStr &&
      isStrictSecondaryReissueTitle(fullTitle)
    ) {
      continue;
    }

    const workKey = getCanonicalWorkKey(fullTitle, authorName);
    if (!workKey || workKey.startsWith('::')) continue;

    const coverUrl = pickGoogleVolumeCoverUrl(info.imageLinks);
    if (!parsedDate.releaseDate && !coverUrl) continue;

    const isbn13 = info.industryIdentifiers?.find(
      (i) => i.type === 'ISBN_13'
    )?.identifier;
    const isbn10 = info.industryIdentifiers?.find(
      (i) => i.type === 'ISBN_10'
    )?.identifier;

    const candidate: BookItem = {
      id: `gb:book:${item.id}`,
      source: 'google',
      externalId: item.id,
      title: pickGoogleVolumeDisplayTitle(info),
      authorName,
      authorId,
      coverUrl,
      releaseDate: parsedDate.releaseDate,
      datePrecision: parsedDate.datePrecision,
      description: info.description || undefined,
      pageCount: info.pageCount || undefined,
      isbn: isbn13 || isbn10,
      isOneOff: false,
      isManual: false,
      readingStatus: 'none',
      updatedAt: nowIso,
    };

    const existingIdx = deduped.findIndex((existing) =>
      areSameCanonicalWork(existing, { title: fullTitle, authorName })
    );
    if (existingIdx < 0) {
      deduped.push(candidate);
    } else {
      deduped[existingIdx] = mergeCanonicalBookPair(
        deduped[existingIdx],
        candidate,
        todayStr
      );
    }
  }

  return deduped;
}

export async function fetchAuthorBibliography(params: {
  authorId: string;
  authorName: string;
  source: DataSource;
  externalId?: string;
  hardcoverToken?: string;
  googleApiKey?: string;
  forceRefresh?: boolean;
  todayStr?: string;
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
    forceRefresh = false,
    todayStr: todayOverride,
  } = params;

  const todayStr =
    todayOverride && /^\d{4}-\d{2}-\d{2}$/.test(todayOverride)
      ? todayOverride
      : getLocalTodayStr();

  const bibCacheKey = `bib:v9:en:${todayStr}::${source}::${externalId || ''}::${authorName
    .trim()
    .toLowerCase()}::${Boolean(hardcoverToken?.trim())}`;
  if (!forceRefresh) {
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
  }

  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();

  if (hardcoverToken?.trim()) {
    try {
      const [hcEntries, gbBooks] = await Promise.all([
        fetchHardcoverAuthorBooks({
          authorId,
          authorName,
          externalId,
          source,
          token: hardcoverToken,
          todayStr,
        }),
        fetchGoogleFallbackAuthorBooks({
          authorId,
          authorName,
          googleApiKey,
        }).catch(() => [] as BookItem[]),
      ]);

      if (hcEntries.length > 0) {
        // 1. Merge Google Books exact release dates & original hardcover dates onto Hardcover entries
        let mergedEntries = hcEntries.map((entry) => {
          const gbMatch = gbBooks.find((gb) =>
            areSameCanonicalWork(entry.book, gb)
          );
          if (!gbMatch) return entry;
          const mergedDate = mergeGoogleDateIntoHardcoverItem(
            {
              releaseDate: entry.book.releaseDate,
              datePrecision: entry.book.datePrecision,
            },
            gbMatch,
            todayStr
          );
          return {
            ...entry,
            book: {
              ...entry.book,
              coverUrl: entry.book.coverUrl || gbMatch.coverUrl,
              releaseDate: mergedDate.releaseDate,
              datePrecision: mergedDate.datePrecision,
              description: entry.book.description || gbMatch.description,
              pageCount: entry.book.pageCount || gbMatch.pageCount,
              isbn: entry.book.isbn || gbMatch.isbn,
            },
          };
        });

        // 2. Targeted Google Books title lookup for recent/upcoming/unscheduled Hardcover books
        // that still lack an exact day date (e.g. when the broad `inauthor` top-40 missed them)
        const needsTargetedDateIndices = mergedEntries
          .map((entry, idx) => ({ entry, idx }))
          .filter(
            ({ entry }) =>
              entry.book.datePrecision !== 'day' &&
              (!entry.book.releaseDate ||
                entry.book.releaseDate >= String(currentYear - 1))
          )
          .slice(0, 8);

        if (needsTargetedDateIndices.length > 0) {
          await Promise.all(
            needsTargetedDateIndices.map(async ({ entry, idx }) => {
              const gbTargeted = await lookupBestGoogleBookMatch({
                title: entry.book.title,
                authorName,
                isbn13:
                  entry.book.isbn?.length === 13 ? entry.book.isbn : undefined,
                isbn10:
                  entry.book.isbn?.length === 10 ? entry.book.isbn : undefined,
                googleApiKey,
                todayStr,
              });
              if (!gbTargeted) return;
              const mergedDate = mergeGoogleDateIntoHardcoverItem(
                {
                  releaseDate: entry.book.releaseDate,
                  datePrecision: entry.book.datePrecision,
                },
                gbTargeted,
                todayStr
              );
              mergedEntries[idx] = {
                ...entry,
                book: {
                  ...entry.book,
                  coverUrl: entry.book.coverUrl || gbTargeted.coverUrl,
                  releaseDate: mergedDate.releaseDate,
                  datePrecision: mergedDate.datePrecision,
                  description: entry.book.description || gbTargeted.description,
                  pageCount: entry.book.pageCount || gbTargeted.pageCount,
                  isbn: entry.book.isbn || gbTargeted.isbn,
                },
              };
            })
          );
        }

        // 3. Drop undated unscheduled Hardcover stubs that still have no release date and low readership
        mergedEntries = mergedEntries.filter(
          (entry) =>
            !entry.fromUnscheduled ||
            Boolean(entry.book.releaseDate) ||
            (entry.usersCount >= 15 && Boolean(entry.book.coverUrl))
        );

        const finalBooks = mergedEntries.map((e) => e.book);

        // 4. Include recent/forthcoming English releases on Google Books that aren't yet on Hardcover
        // (e.g. publisher ONIX feeds that hit Google Books before Hardcover)
        for (const gbBook of gbBooks) {
          if (!gbBook.releaseDate || gbBook.releaseDate < String(currentYear - 1)) {
            continue;
          }
          if (!gbBook.isbn && !gbBook.coverUrl) continue;
          if (isStrictSecondaryReissueTitle(gbBook.title)) continue;
          if (finalBooks.some((b) => areSameCanonicalWork(b, gbBook))) continue;
          finalBooks.push(gbBook);
        }

        const out = { books: finalBooks, providerUsed: 'hardcover' as const };
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
  if (fallbackBooks.length > 0) {
    setCachedValue(bibCacheKey, out);
  }
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
  title?: string | null;
  edition_format?: string | null;
  edition_information?: string | null;
  reading_format_id?: number | null;
  isbn_13?: string | null;
  isbn_10?: string | null;
  release_date?: string | null;
  publisher?: { name?: string | null } | null;
  image?: { url?: string | null } | null;
  book?: {
    id: number;
    title: string;
    release_date?: string | null;
    release_year?: number | null;
    pages?: number | null;
    users_count?: number | null;
    image?: { url?: string | null } | null;
    editions?: Array<{
      title?: string | null;
      release_date?: string | null;
      reading_format_id?: number | null;
      edition_format?: string | null;
      edition_information?: string | null;
      isbn_13?: string | null;
      isbn_10?: string | null;
      users_count?: number | null;
      publisher?: { name?: string | null } | null;
    }> | null;
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
  todayStr?: string;
}): Promise<{
  matches: Record<string, BatchBookEnrichMatch>;
}> {
  const { items, hardcoverToken, googleApiKey, todayStr: todayOverride } = params;
  const matches: Record<string, BatchBookEnrichMatch> = {};
  const pass1UsersCount = new Map<string, number>();

  if (items.length === 0) {
    return { matches };
  }

  const todayStr =
    todayOverride && /^\d{4}-\d{2}-\d{2}$/.test(todayOverride)
      ? todayOverride
      : getLocalTodayStr();

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
              title
              edition_format
              edition_information
              reading_format_id
              isbn_13
              isbn_10
              release_date
              publisher {
                name
              }
              image {
                url
              }
              book {
                id
                title
                release_date
                release_year
                pages
                users_count
                image {
                  url
                }
                editions(
                  where: {
                    release_date: { _is_null: false }
                    _or: [
                      { language: { code2: { _eq: "en" } } }
                      { language_id: { _is_null: true } }
                    ]
                  }
                  order_by: { release_date: asc_nulls_last }
                  limit: 30
                ) {
                  title
                  release_date
                  reading_format_id
                  edition_format
                  edition_information
                  isbn_13
                  isbn_10
                  users_count
                  publisher {
                    name
                  }
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
            const coverUrl =
              pickBestHeadOnCoverUrl([
                {
                  url: ed.book.image?.url,
                  isCanonicalBookImage: true,
                  editionTitle: ed.book.title,
                },
                {
                  url: ed.image?.url,
                  editionTitle: ed.title || ed.book.title,
                  editionFormat: ed.edition_format,
                  editionInfo: ed.edition_information,
                  readingFormatId: ed.reading_format_id,
                  isbn13: ed.isbn_13,
                  isbn10: ed.isbn_10,
                },
              ]) ||
              ed.book.image?.url ||
              ed.image?.url ||
              undefined;

            const combinedEditions = [
              ...(ed.book.editions || []),
              ...(ed.release_date
                ? [
                    {
                      title: ed.title,
                      release_date: ed.release_date,
                      reading_format_id: ed.reading_format_id,
                      edition_format: ed.edition_format,
                      edition_information: ed.edition_information,
                      isbn_13: ed.isbn_13,
                      isbn_10: ed.isbn_10,
                      publisher: ed.publisher,
                    },
                  ]
                : []),
            ];

            const parsedDate = resolveHardcoverBookOriginalDate(
              {
                title: ed.book.title,
                release_date: ed.book.release_date,
                release_year: ed.book.release_year,
                users_count: ed.book.users_count,
                editions: combinedEditions,
              },
              todayStr
            );
            const primaryAuthor = ed.book.contributions?.[0]?.author;
            pass1UsersCount.set(
              item.clientKey,
              typeof ed.book.users_count === 'number' ? ed.book.users_count : 0
            );

            matches[item.clientKey] = {
              clientKey: item.clientKey,
              id: `hc:book:${ed.book.id}`,
              source: 'hardcover',
              externalId: String(ed.book.id),
              title: cleanDisplayBookTitle(ed.book.title || item.title),
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

    // Pass 2: Aliased GraphQL Multi-Search for unmatched items AND edition-decorated / standalone reissue ISBN stubs
    // (e.g. "The City of Brass Deluxe Collector's Edition" or a standalone paperback book stub on Hardcover)
    const needsHardcoverSearch = items.filter((it) => {
      const m = matches[it.clientKey];
      if (!m) return true;
      if (hasEditionDecorationInTitle(it.title)) return true;
      if (
        (!m.releaseDate || m.releaseDate >= '2024') &&
        (pass1UsersCount.get(it.clientKey) ?? 0) < 400
      ) {
        return true;
      }
      return false;
    });
    const aliasChunkSize = 6;

    for (let i = 0; i < needsHardcoverSearch.length; i += aliasChunkSize) {
      const slice = needsHardcoverSearch.slice(i, i + aliasChunkSize);
      const varDefs = slice.map((_, idx) => `$q${idx}: String!`).join(', ');
      const aliasBlocks = slice
        .map(
          (_, idx) =>
            `b${idx}: search(query: $q${idx}, query_type: "Book", per_page: 6, page: 1) { results }`
        )
        .join('\n');

      const variables: Record<string, string> = {};
      slice.forEach((item, idx) => {
        const cleanedTitle = cleanDisplayBookTitle(item.title);
        const searchStr = item.authorName
          ? `${cleanedTitle} ${item.authorName}`
          : item.isbn13 || item.isbn10 || cleanedTitle;
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
        const englishMeta = await fetchEnglishHardcoverBooksMeta(
          docsByAlias.flat().map((d) => d.id),
          hardcoverToken,
          todayStr
        );
        const englishIds = englishMeta?.englishIds ?? null;
        const bestCovers = englishMeta?.bestCovers;
        const bestDates = englishMeta?.bestDates;
        const usersCounts = englishMeta?.usersCounts;

        slice.forEach((item, idx) => {
          const allDocs = docsByAlias[idx];
          const englishDocs = englishIds
            ? allDocs.filter((d) => englishIds.has(String(d.id)))
            : allDocs;
          const docs = englishDocs.length > 0 ? englishDocs : allDocs;

          if (docs.length === 0) return;

          const canonicalDocs = (
            item.authorName
              ? docs.filter((d) => {
                  const candAuthors = [
                    ...(d.author_names || []),
                    ...(d.contributions?.map((c) => c.author?.name || '') || []),
                  ].filter(Boolean);
                  return (
                    authorMatchesName(candAuthors, item.authorName!) &&
                    areSameCanonicalWork(
                      { title: d.title || '', authorName: item.authorName! },
                      { title: item.title, authorName: item.authorName! }
                    )
                  );
                })
              : []
          ).sort(
            (a, b) =>
              (usersCounts?.get(String(b.id)) ?? 0) -
              (usersCounts?.get(String(a.id)) ?? 0)
          );

          const existingPass1 = matches[item.clientKey];
          if (item.authorName && canonicalDocs.length === 0) {
            return;
          }
          if (existingPass1 && canonicalDocs.length === 0) {
            return;
          }

          const candidateDocs =
            canonicalDocs.length > 0
              ? canonicalDocs
              : item.authorName
              ? docs.filter((d) => {
                  const candAuthors = [
                    ...(d.author_names || []),
                    ...(d.contributions?.map((c) => c.author?.name || '') || []),
                  ].filter(Boolean);
                  return authorMatchesName(candAuthors, item.authorName!);
                })
              : [docs[0]];

          const chosen = candidateDocs[0] || docs[0];
          if (!chosen) return;

          const chosenUsers = usersCounts?.get(String(chosen.id)) ?? 0;

          const primaryAuthor =
            chosen.contributions?.find((c) => c.primary)?.author ||
            chosen.contributions?.[0]?.author;
          const resolvedAuthor =
            primaryAuthor?.name ||
            chosen.author_names?.[0] ||
            item.authorName ||
            'Unknown Author';

          const resolveDocDate = (doc: HardcoverSearchBookDoc) => {
            const idStr = String(doc.id);
            const md = bestDates?.get(idStr);
            return md && md.datePrecision !== 'unknown'
              ? md
              : parseHardcoverReleaseDate(doc.release_date, doc.release_year);
          };

          let mergedDate = resolveDocDate(chosen);
          let mergedTitle = cleanDisplayBookTitle(chosen.title || item.title);
          let mergedCover =
            bestCovers?.get(String(chosen.id)) || chosen.image?.url || undefined;
          let mergedUsers = chosenUsers;

          // Merge across all canonical search hits so an earlier standard hardcover beats a Deluxe/paperback duplicate record
          for (let k = 1; k < canonicalDocs.length; k++) {
            const alt = canonicalDocs[k];
            const altDate = resolveDocDate(alt);
            const altUsers = usersCounts?.get(String(alt.id)) ?? 0;
            mergedDate = pickCanonicalReleaseDate(
              {
                id: `hc:book:${chosen.id}`,
                source: 'hardcover',
                title: mergedTitle,
                authorName: resolvedAuthor,
                releaseDate: mergedDate.releaseDate,
                datePrecision: mergedDate.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              {
                id: `hc:book:${alt.id}`,
                source: 'hardcover',
                title: alt.title || mergedTitle,
                authorName: resolvedAuthor,
                releaseDate: altDate.releaseDate,
                datePrecision: altDate.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              todayStr,
              mergedUsers,
              altUsers
            );
            mergedTitle = pickCleanerTitle(mergedTitle, alt.title || mergedTitle);
            mergedUsers = Math.max(mergedUsers, altUsers);
            if (!mergedCover) {
              mergedCover =
                bestCovers?.get(String(alt.id)) || alt.image?.url || undefined;
            }
          }

          if (existingPass1) {
            const existingUsers = pass1UsersCount.get(item.clientKey) ?? 0;
            const combined = pickCanonicalReleaseDate(
              {
                id: existingPass1.id,
                source: existingPass1.source,
                title: existingPass1.title,
                authorName: existingPass1.authorName,
                releaseDate: existingPass1.releaseDate,
                datePrecision: existingPass1.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              {
                id: `hc:book:${chosen.id}`,
                source: 'hardcover',
                title: mergedTitle,
                authorName: resolvedAuthor,
                releaseDate: mergedDate.releaseDate,
                datePrecision: mergedDate.datePrecision,
                isOneOff: false,
                isManual: false,
                readingStatus: 'none',
                updatedAt: '',
              },
              todayStr,
              existingUsers,
              mergedUsers
            );
            const preferSearchCanonicalWork =
              mergedUsers >= Math.max(50, existingUsers * 5);
            pass1UsersCount.set(
              item.clientKey,
              Math.max(existingUsers, mergedUsers)
            );
            matches[item.clientKey] = {
              ...existingPass1,
              id: preferSearchCanonicalWork
                ? `hc:book:${chosen.id}`
                : existingPass1.id,
              externalId: preferSearchCanonicalWork
                ? String(chosen.id)
                : existingPass1.externalId,
              title: pickCleanerTitle(existingPass1.title, mergedTitle),
              coverUrl: preferSearchCanonicalWork
                ? mergedCover || existingPass1.coverUrl
                : existingPass1.coverUrl || mergedCover,
              releaseDate: combined.releaseDate,
              datePrecision: combined.datePrecision,
              pageCount: existingPass1.pageCount || chosen.pages || undefined,
              isbn:
                existingPass1.isbn ||
                chosen.isbns?.find((x) => x.length === 13) ||
                item.isbn13 ||
                item.isbn10,
            };
          } else {
            pass1UsersCount.set(item.clientKey, mergedUsers);
            matches[item.clientKey] = {
              clientKey: item.clientKey,
              id: `hc:book:${chosen.id}`,
              source: 'hardcover',
              externalId: String(chosen.id),
              title: mergedTitle,
              authorName: resolvedAuthor,
              authorExternalId:
                primaryAuthor?.id !== undefined
                  ? String(primaryAuthor.id)
                  : undefined,
              coverUrl: mergedCover,
              releaseDate: mergedDate.releaseDate,
              datePrecision: mergedDate.datePrecision,
              pageCount: chosen.pages || undefined,
              isbn:
                chosen.isbns?.find((x) => x.length === 13) ||
                item.isbn13 ||
                item.isbn10,
            };
          }
        });
      } catch {
        // Ignore transient batch search error
      }

      if (i + aliasChunkSize < needsHardcoverSearch.length) {
        await sleepMs(120);
      }
    }
  }

  // Pass 3: Google Books hybrid verification & fallback
  // Runs on unmatched items, items missing exact 'day' dates, edition-decorated titles,
  // and low-readership 2024+ stubs (skipping popular Hardcover edition-verified works to conserve quota).
  const needsGoogleVerify = !isGoogleBooksAvailable()
    ? []
    : items.filter((it) => {
        const m = matches[it.clientKey];
        if (!m) return true;
        if (m.datePrecision !== 'day' || !m.releaseDate) return true;
        if (hasEditionDecorationInTitle(it.title)) return true;
        if (
          m.releaseDate >= '2024' &&
          (m.source !== 'hardcover' || (pass1UsersCount.get(it.clientKey) ?? 0) < 25)
        ) {
          return true;
        }
        return false;
      });

  const googleChunkSize = 8;
  for (let i = 0; i < needsGoogleVerify.length; i += googleChunkSize) {
    const slice = needsGoogleVerify.slice(i, i + googleChunkSize);
    await Promise.all(
      slice.map(async (item) => {
        try {
          const existing = matches[item.clientKey];
          const gbMatch = await lookupBestGoogleBookMatch({
            title: existing?.title || item.title,
            authorName: existing?.authorName || item.authorName,
            isbn13: item.isbn13,
            isbn10: item.isbn10,
            googleApiKey,
            todayStr,
          });
          if (!gbMatch) return;

          if (!existing) {
            matches[item.clientKey] = {
              clientKey: item.clientKey,
              id: gbMatch.id,
              source: 'google',
              externalId: gbMatch.externalId,
              title: cleanDisplayBookTitle(gbMatch.title || item.title),
              authorName:
                gbMatch.authorName || item.authorName || 'Unknown Author',
              coverUrl: gbMatch.coverUrl,
              releaseDate: gbMatch.releaseDate,
              datePrecision: gbMatch.datePrecision,
              pageCount: gbMatch.pageCount,
              isbn: gbMatch.isbn || item.isbn13 || item.isbn10,
            };
          } else {
            const mergedDate = mergeGoogleDateIntoHardcoverItem(
              {
                releaseDate: existing.releaseDate,
                datePrecision: existing.datePrecision,
              },
              gbMatch,
              todayStr
            );
            matches[item.clientKey] = {
              ...existing,
              title: pickCleanerTitle(existing.title, gbMatch.title),
              coverUrl: existing.coverUrl || gbMatch.coverUrl,
              releaseDate: mergedDate.releaseDate,
              datePrecision: mergedDate.datePrecision,
              pageCount: existing.pageCount || gbMatch.pageCount,
              isbn: existing.isbn || gbMatch.isbn,
            };
          }
        } catch {
          // Ignore individual Google Books lookup error
        }
      })
    );
    if (i + googleChunkSize < needsGoogleVerify.length) {
      await sleepMs(80);
    }
  }

  // Pass 4: OpenLibrary first_publish_year fallback for undated backlist / MARC titles
  // AND multi-year special/deluxe reissues (e.g. a 2025 Deluxe Collector's Edition of a 2017 novel).
  const needsOpenLibraryCheck = items.filter((it) => {
    const m = matches[it.clientKey];
    if (!m?.releaseDate) return true;
    if (hasEditionDecorationInTitle(it.title)) return true;
    if (m.releaseDate >= '2025') return true;
    return false;
  });
  const olChunkSize = 8;

  for (let i = 0; i < needsOpenLibraryCheck.length; i += olChunkSize) {
    const slice = needsOpenLibraryCheck.slice(i, i + olChunkSize);
    await Promise.all(
      slice.map(async (item) => {
        try {
          const existing = matches[item.clientKey];
          const baseTitle = existing?.title || item.title;
          const baseAuthor = existing?.authorName || item.authorName || '';
          const cleanedTitle = cleanDisplayBookTitle(baseTitle);
          const rawHead = (
            cleanedTitle.split(/\s*[:—–(]\s*/)[0].trim() ||
            cleanedTitle ||
            baseTitle.trim()
          )
            .replace(/['’‘`]/g, "'")
            .replace(/"/g, '');
          if (!rawHead) return;

          const authorTokens = normalizeAuthorKey(baseAuthor)
            .split(' ')
            .filter(Boolean);
          const lastAuthorToken = authorTokens[authorTokens.length - 1] || '';
          const authorParam = lastAuthorToken
            ? `&author=${encodeURIComponent(lastAuthorToken)}`
            : '';
          const olUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(
            rawHead
          )}${authorParam}&limit=5&fields=key,title,author_name,first_publish_year,cover_i,isbn`;

          const res = await fetch(olUrl, { cache: 'no-store' });
          if (!res.ok) return;
          const json = await res.json();
          const docs: Array<{
            key?: string;
            title?: string;
            author_name?: string[];
            first_publish_year?: number;
            cover_i?: number;
            isbn?: string[];
          }> = Array.isArray(json?.docs) ? json.docs : [];

          for (const doc of docs) {
            if (!doc.title) continue;
            if (baseAuthor && !authorMatchesName(doc.author_name, baseAuthor)) {
              continue;
            }
            const resolvedAuthor =
              doc.author_name?.[0] || baseAuthor || 'Unknown Author';
            if (
              !areSameCanonicalWork(
                { title: doc.title, authorName: resolvedAuthor },
                { title: baseTitle, authorName: baseAuthor || resolvedAuthor }
              )
            ) {
              continue;
            }

            const yrNum =
              typeof doc.first_publish_year === 'number' &&
              doc.first_publish_year >= 1800 &&
              doc.first_publish_year <= 2100
                ? doc.first_publish_year
                : null;
            if (!yrNum) continue;
            const yr = String(yrNum);

            const olCover = doc.cover_i
              ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
              : undefined;
            const olIsbn = doc.isbn?.find(
              (code) => code.length === 13 || code.length === 10
            );
            const workKey = (doc.key || rawHead).replace(/^\/works\//, '');

            if (!existing) {
              matches[item.clientKey] = {
                clientKey: item.clientKey,
                id: `ol:book:${workKey}`,
                source: 'openlibrary',
                externalId: workKey,
                title: pickCleanerTitle(item.title, cleanDisplayBookTitle(doc.title)),
                authorName: resolvedAuthor,
                coverUrl: olCover,
                releaseDate: yr,
                datePrecision: 'year',
                isbn: olIsbn || item.isbn13 || item.isbn10,
              };
            } else if (!existing.releaseDate) {
              matches[item.clientKey] = {
                ...existing,
                title: pickCleanerTitle(
                  existing.title,
                  cleanDisplayBookTitle(doc.title)
                ),
                coverUrl: existing.coverUrl || olCover,
                releaseDate: yr,
                datePrecision: 'year',
                isbn: existing.isbn || olIsbn,
              };
            } else {
              // If OpenLibrary's canonical work first_publish_year is at least 2 full years earlier
              // (e.g. 2017 vs a 2025 Deluxe Collector's Edition), restore the original publication year!
              const existingYear = Number(existing.releaseDate.slice(0, 4));
              if (existingYear >= 2000 && yrNum <= existingYear - 2) {
                matches[item.clientKey] = {
                  ...existing,
                  title: pickCleanerTitle(
                    existing.title,
                    cleanDisplayBookTitle(doc.title)
                  ),
                  coverUrl: existing.coverUrl || olCover,
                  releaseDate: yr,
                  datePrecision: 'year',
                  isbn: existing.isbn || olIsbn,
                };
              }
            }
            break;
          }
        } catch {
          // Ignore individual OpenLibrary lookup error
        }
      })
    );
    if (i + olChunkSize < needsOpenLibraryCheck.length) {
      await sleepMs(80);
    }
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

export interface BookCoverOption {
  url: string;
  label: string;
  source: 'hardcover' | 'openlibrary' | 'google';
  score: number;
}

export async function fetchBookCoverCandidates(params: {
  title: string;
  authorName: string;
  isbn?: string;
  externalId?: string;
  source?: DataSource;
  hardcoverToken?: string;
  googleApiKey?: string;
}): Promise<BookCoverOption[]> {
  const {
    title,
    authorName,
    isbn,
    externalId,
    source,
    hardcoverToken,
    googleApiKey,
  } = params;

  const trimmedTitle = title.trim();
  const trimmedAuthor = authorName.trim();
  if (!trimmedTitle) return [];

  const rawOptions: Array<{
    meta: CoverCandidateMeta;
    label: string;
    source: 'hardcover' | 'openlibrary' | 'google';
  }> = [];

  const discoveredIsbns = new Set<string>();
  if (isbn) {
    const clean = isbn.replace(/[^0-9X]/gi, '');
    if (clean.length === 10 || clean.length === 13) {
      discoveredIsbns.add(clean);
    }
  }

  // 1. Hardcover editions (print & ebook covers)
  const hcTask = (async () => {
    if (!hardcoverToken?.trim()) return;
    try {
      const targetBookIds = new Set<number>();
      if (source === 'hardcover' && externalId && /^\d+$/.test(externalId)) {
        targetBookIds.add(Number(externalId));
      }

      if (targetBookIds.size === 0) {
        const searchGql = `
          query SearchCoverBooks($q: String!) {
            bookSearch: search(query: $q, query_type: "Book", per_page: 5, page: 1) {
              results
            }
          }
        `;
        const searchRes = await queryHardcoverGraphQL<{
          bookSearch?: { results?: unknown };
        }>(
          searchGql,
          { q: `${trimmedTitle} ${trimmedAuthor}`.trim() },
          hardcoverToken
        );
        const hits = extractSearchHits<HardcoverSearchBookDoc>(
          searchRes.bookSearch?.results
        );
        for (const h of hits) {
          if (!h.title || h.compilation) continue;
          const candAuthor =
            h.contributions?.[0]?.author?.name || h.author_names?.[0] || '';
          if (
            !trimmedAuthor ||
            areSameCanonicalWork(
              { title: trimmedTitle, authorName: trimmedAuthor },
              { title: h.title, authorName: candAuthor || trimmedAuthor }
            )
          ) {
            const numId = Number(h.id);
            if (Number.isInteger(numId) && numId > 0) {
              targetBookIds.add(numId);
            }
          }
        }
      }

      if (targetBookIds.size === 0) return;

      const idsArr = Array.from(targetBookIds).slice(0, 3);
      const editionsRes = await queryHardcoverGraphQL<{
        books?: Array<{
          id: number;
          title?: string | null;
          users_count?: number | null;
          image?: { url?: string | null } | null;
          editions?: HardcoverEditionCoverNode[] | null;
        }>;
      }>(
        `query BookCoverEditions($ids: [Int!]!) {
          books(where: { id: { _in: $ids } }, limit: 3) {
            id
            title
            users_count
            image {
              url
            }
            editions(
              where: {
                image: { url: { _is_null: false } }
                _or: [
                  { language: { code2: { _eq: "en" } } }
                  { language_id: { _is_null: true } }
                ]
              }
              order_by: { release_date: asc_nulls_last }
              limit: 16
            ) {
              title
              edition_format
              edition_information
              reading_format_id
              isbn_13
              isbn_10
              release_date
              image {
                url
              }
            }
          }
        }`,
        { ids: idsArr },
        hardcoverToken
      );

      for (const b of editionsRes.books || []) {
        if (b.image?.url) {
          rawOptions.push({
            source: 'hardcover',
            label: 'Hardcover · Main',
            meta: {
              url: b.image.url,
              isCanonicalBookImage: true,
              editionTitle: b.title,
              usersCount: b.users_count,
            },
          });
        }
        for (const ed of b.editions || []) {
          if (ed.isbn_13 && ed.reading_format_id !== 2) {
            discoveredIsbns.add(ed.isbn_13.replace(/[^0-9X]/gi, ''));
          }
          if (!ed.image?.url || ed.reading_format_id === 2) continue;
          const formatLabel =
            ed.edition_format?.trim() ||
            (ed.reading_format_id === 4
              ? 'E-Book'
              : ed.reading_format_id === 1
              ? 'Print'
              : 'Edition');
          rawOptions.push({
            source: 'hardcover',
            label: `Hardcover · ${formatLabel}`,
            meta: {
              url: ed.image.url,
              editionTitle: ed.title || b.title,
              editionFormat: ed.edition_format,
              editionInfo: ed.edition_information,
              readingFormatId: ed.reading_format_id,
              isbn13: ed.isbn_13,
              isbn10: ed.isbn_10,
            },
          });
        }
      }
    } catch {
      // Ignore Hardcover candidate error and continue with Google / Open Library
    }
  })();

  // 2. Google Books front covers
  const gbTask = (async () => {
    if (!isGoogleBooksAvailable()) return;
    try {
      const keyParam = googleApiKey
        ? `&key=${encodeURIComponent(googleApiKey)}`
        : '';
      const q = trimmedAuthor
        ? `intitle:"${trimmedTitle}" inauthor:"${trimmedAuthor}"`
        : `intitle:"${trimmedTitle}"`;
      const items = await fetchGoogleBooksVolumeList(
        `${GOOGLE_BOOKS_ENDPOINT}?q=${encodeURIComponent(
          q
        )}&maxResults=8&printType=books&langRestrict=en${keyParam}`
      );
      if (!items) return;
      for (const item of items) {
        const info = item.volumeInfo;
        if (!info?.title) continue;
        if (
          trimmedAuthor &&
          info.authors?.length &&
          !authorMatchesName(info.authors, trimmedAuthor)
        ) {
          continue;
        }
        const isbn13 = info.industryIdentifiers?.find(
          (i) => i.type === 'ISBN_13'
        )?.identifier;
        if (isbn13) {
          discoveredIsbns.add(isbn13.replace(/[^0-9X]/gi, ''));
        }
        const url = pickGoogleVolumeCoverUrl(info.imageLinks);
        if (!url) continue;
        rawOptions.push({
          source: 'google',
          label: 'Google Books',
          meta: {
            url,
            editionTitle: info.title,
            readingFormatId: 1,
            isbn13,
          },
        });
      }
    } catch {
      // Ignore Google Books candidate error
    }
  })();

  // 3. Open Library flat jacket scans
  const olTask = (async () => {
    try {
      const paramsOl = new URLSearchParams({
        title: trimmedTitle,
        limit: '6',
        fields: 'title,author_name,cover_i,isbn',
      });
      if (trimmedAuthor) {
        paramsOl.set('author', trimmedAuthor);
      }
      const res = await fetch(
        `https://openlibrary.org/search.json?${paramsOl.toString()}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const doc of data.docs || []) {
        if (doc.cover_i) {
          rawOptions.push({
            source: 'openlibrary',
            label: 'Open Library',
            meta: {
              url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
              editionTitle: doc.title,
              readingFormatId: 1,
            },
          });
        }
      }
    } catch {
      // Ignore Open Library transient error
    }
  })();

  await Promise.all([hcTask, gbTask, olTask]);

  for (const isbnVal of Array.from(discoveredIsbns).slice(0, 3)) {
    rawOptions.push({
      source: 'openlibrary',
      label: `ISBN ${isbnVal}`,
      meta: {
        url: `https://covers.openlibrary.org/b/isbn/${isbnVal}-L.jpg?default=false`,
        readingFormatId: 1,
        isbn13: isbnVal.length === 13 ? isbnVal : undefined,
        isbn10: isbnVal.length === 10 ? isbnVal : undefined,
      },
    });
  }

  const byUrl = new Map<string, BookCoverOption>();
  for (const item of rawOptions) {
    const cleanUrl = cleanGoogleCoverUrl(item.meta.url) || item.meta.url?.trim();
    if (!cleanUrl) continue;
    const score = scoreCoverCandidate({ ...item.meta, url: cleanUrl });
    if (score < -80) continue;

    const dedupeKey = cleanUrl.replace(/^https?:\/\//i, '');
    const existing = byUrl.get(dedupeKey);
    if (!existing || score > existing.score) {
      byUrl.set(dedupeKey, {
        url: cleanUrl,
        label: item.label,
        source: item.source,
        score,
      });
    }
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}
