import { pickPreferredCoverUrl } from '@/lib/coverArt';
import { BookItem, DatePrecision, ReadingStatus } from '@/types/books';

/**
 * Multi-book bundles, study guides, samplers, audio split parts, and explicit
 * foreign-language edition labels that should never appear in an English ledger.
 */
const NOISE_TITLE_PATTERNS: RegExp[] = [
  /\bsummary of\b/i,
  /\bstudy guide\b/i,
  /\bworkbook(\s+for)?\b/i,
  /\banalysis of\b/i,
  /\bcliff'?s?\s*notes\b/i,
  /\bsparknotes\b/i,
  /\bbook\s*club\s*kit\b/i,
  /\bdiscussion\s+guide\b/i,
  /\breading\s+guide\b/i,
  /\btrivia\b/i,
  /\bboxed\s+set\b/i,
  /\bbox\s+set\b/i,
  /\bslipcase\s+set\b/i,
  /\b\d+\s*-\s*book\s+(bundle|set|collection|pack)\b/i,
  /\b\d+\s*in\s*1\b/i,
  /\bbooks?\s+\d+\s*(?:-|–|—|to|through)\s*\d+\b/i,
  /\bvolumes?\s+\d+\s*(?:-|–|—|to|through)\s*\d+\b/i,
  /\bcomplete\s+(trilogy|duology|quartet|series|collection|saga)\b/i,
  /\bcollection:\s*books\b/i,
  /\bomnibus\b/i,
  /\bsampler\b/i,
  /\bfree\s+preview\b/i,
  /\bsneak\s+peek\b/i,
  /\bbonus\s+(chapter|epilogue|scene)s?\b/i,
  /\bexcerpt(\s+from)?\b/i,
  /\bcoloring\s+book\b/i,
  /\breading\s+journal\b/i,
  /\bdramatized\s+adaptation\b/i,
  /\bgraphicaudio\b/i,
  /\broleplaying\s+game\b/i,
  /\(\s*\d+\s+of\s+\d+\s*\)/i,
  /\bpart\s+\d+\s+of\s+\d+\b/i,
  /,\s*part\s+\d+\b/i,
  /\b(german|spanish|french|italian|portuguese|polish|russian|japanese|chinese|korean|dutch|turkish|swedish|czech|hungarian|romanian|ukrainian|hebrew|arabic)\s+edition\b/i,
  /\b(edición|édition|ausgabe|edizione|edição|wydanie)\b/i,
];

/**
 * Formats & reissues that ONLY exist after a work has already been published
 * (never a brand-new unreleased original work).
 */
const STRICT_SECONDARY_REISSUE_PATTERNS: RegExp[] = [
  /\btrade\s+paperback\b/i,
  /\bmass\s+market(\s+paperback)?\b/i,
  /\bpaperback\s+edition\b/i,
  /\(\s*(tpb|mmpb|paperback|mass\s+market|large\s+print)\s*\)/i,
  /(?::|-|–|—)\s*(?:trade\s+|mass\s+market\s+)?paperback$/i,
  /\blarge\s+print\b/i,
  /\blarge\s+type\b/i,
  /\bdyslexic\s+edition\b/i,
  /\b\d+(?:st|nd|rd|th)\s+anniversary\b/i,
  /\banniversary\s+edition\b/i,
  /\bcentennial\s+edition\b/i,
  /\bcentenary\s+edition\b/i,
  /\b(?:deluxe\s+)?collector'?s?\s+(?:hardcover\s+|paperback\s+)?edition\b/i,
  /\breissue(\s+edition)?\b/i,
  /\brepackage(\s+edition)?\b/i,
  /\bre-?release\b/i,
  /\brevised\s+edition\b/i,
  /\bupdated\s+edition\b/i,
  /\bexpanded\s+edition\b/i,
  /\brestored\s+edition\b/i,
  /\b(movie|film|tv|television|netflix|hbo|prime|apple\s+tv\+?|disney\+?)\s+tie-?in\b/i,
  /\bnow\s+a\s+major\s+motion\s+picture\b/i,
  /\bsoon\s+to\s+be\s+a\s+major\s+motion\s+picture\b/i,
  /\breese'?s\s+book\s+club(?:\s+(?:pick|edition|selection))?\b/i,
  /\boprah'?s\s+book\s+club(?:\s+(?:pick|edition|selection))?\b/i,
  /\b(?:read\s+with\s+jenna|jenna'?s\s+book\s+club)(?:\s+(?:pick|edition|selection))?\b/i,
  /\b(?:good\s+morning\s+america|gma)\s+book\s+club(?:\s+(?:pick|edition|selection))?\b/i,
  /\b(?:richard\s*(?:&|and)\s*judy|target|barnes\s*(?:&|and)\s*noble|b&n|waterstones|indie|spotify|service95|fallon|jimmy\s+fallon'?s?|dakota'?s|dua\s+lipa'?s)\s+book\s+club(?:\s+(?:pick|edition|selection))?\b/i,
  /\b[a-z]{2,18}(?:'s|’s)\s+book\s+club(?:\s+(?:pick|edition|selection))?\b/i,
  /\bbook\s+club\s+(?:edition|pick|selection|favorites?)\b/i,
  /\btiktok\s+made\s+me\s+buy\s+it\b/i,
  /\bleatherbound(\s+edition)?\b/i,
  /\bfolio\s+society\b/i,
  /\bpenguin\s+(classics|clothbound)\b/i,
  /\bmodern\s+library\b/i,
  /\beveryman'?s\s+library\b/i,
];

/**
 * Edition / retailer / format decorations stripped when computing a book's
 * canonical work title or cleaning display titles.
 */
const EDITION_DECORATION_PATTERNS: RegExp[] = [
  ...STRICT_SECONDARY_REISSUE_PATTERNS,
  /\bdeluxe(\s+limited)?(\s+hardcover)?\s+edition\b/i,
  /\blimited\s+edition\b/i,
  /\bcollector'?s?\s+edition\b/i,
  /\bspecial\s+edition\b/i,
  /\bsignature\s+edition\b/i,
  /\bheirloom\s+edition\b/i,
  /\bsigned(\s+edition)?\b/i,
  /\bautographed(\s+edition)?\b/i,
  /\billustrated(\s+edition)?\b/i,
  /\bannotated(\s+edition)?\b/i,
  /\bclothbound(\s+edition)?\b/i,
  /\bhardcover\s+edition\b/i,
  /\bhardback\s+edition\b/i,
  /\bkindle\s+edition\b/i,
  /\bebook\s+edition\b/i,
  /\blibrary\s+edition\b/i,
  /\bunabridged\b/i,
  /\babridged\b/i,
  /\bsprayed\s+edges?\b/i,
  /\bstenciled\s+edges?\b/i,
  /\b(uk|u\.k\.|us|u\.s\.|international|export)\s+edition\b/i,
  /\b(exclusive|indie\s+exclusive)\s+edition\b/i,
  /\b(waterstones|barnes\s*(?:&|and)\s*noble|b&n|target|walmart|indigo|amazon|books-a-million|bam)\s+exclusive(\s+edition)?\b/i,
  /\b(fairyloot|illumicrate|owlcrate|litjoy|broken\s+binding|subterranean\s+press|gold\s*sboro)(\s+edition)?\b/i,
  /\bfirst\s+edition\b/i,
  /\bnew\s+edition\b/i,
  /\bstandard\s+edition\b/i,
  /\bretail\s+edition\b/i,
];

const DESCRIPTIVE_SUBTITLE_RE =
  /\b(novel|novella|story|stories|tale|tales|thriller|mystery|romance|memoir|biography|autobiography|fantasy|litrpg|saga|chronicles|trilogy|duology|series|edition|paperback|hardcover|reissue|guide|handbook|history|life\s+and\s+times|book\s+club|pick|bestseller)\b/i;

export function isLikelyNoiseTitle(title: string, filterUntitled = false): boolean {
  const trimmed = (title || '').trim();
  if (!trimmed) return true;
  if (filterUntitled && /^untitled\b/i.test(trimmed)) {
    return true;
  }
  return NOISE_TITLE_PATTERNS.some((re) => re.test(trimmed));
}

const CHAINED_EDITION_SUFFIX_RE =
  /\b(?:(?:deluxe|collector'?s?|collectors|special|limited|anniversary|centennial|centenary|illustrated|annotated|signed|autographed|exclusive|indie\s+exclusive|heirloom|signature|clothbound|leatherbound|hardcover|hardback|paperback|trade\s+paperback|mass\s+market|large\s+print|unabridged|abridged|standard|retail|first|new|revised|updated|expanded|restored|library|kindle|ebook|dyslexic|sprayed\s+edges?|stenciled\s+edges?)\s+)+(?:edition|hardcover|paperback|hardback|printing|reissue)\b/i;

export function isStrictSecondaryReissueTitle(title: string): boolean {
  return STRICT_SECONDARY_REISSUE_PATTERNS.some((re) => re.test(title || ''));
}

export function hasEditionDecorationInTitle(title: string): boolean {
  const t = title || '';
  if (CHAINED_EDITION_SUFFIX_RE.test(t)) return true;
  if (EDITION_DECORATION_PATTERNS.some((re) => re.test(t))) return true;
  if (
    /\([^)]*(edition|paperback|hardcover|reissue|tie-?in|exclusive|print|book\s+club|#[0-9]+)[^)]*\)/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Strips trailing parenthetical/dashed/space-separated edition noise for cleaner display
 * when merging, while preserving genuine titles and subtitles.
 */
export function cleanDisplayBookTitle(rawTitle: string): string {
  let t = (rawTitle || '').trim();
  if (!t) return t;

  // Remove parenthetical/bracketed blocks that only contain edition, format, book club, or Goodreads series (#1) metadata
  t = t.replace(
    /\s*[\(\[][^\)\]]*(?:edition|paperback|hardcover|hardback|large\s+print|reissue|repackage|tie-?in|exclusive|sprayed\s+edges|leatherbound|clothbound|unabridged|anniversary|fairyloot|illumicrate|owlcrate|book\s+club|#\s*\d+|book\s+\d+|vol\.?\s*\d+)[^\)\]]*[\)\]]/gi,
    ''
  );

  // Strip explicit trailing ": Paperback", ": Trade Paperback", or ": Reese's Book Club" tags
  t = t.replace(
    /\s*(?::|—|–|-|\/)\s*(?:trade\s+|mass\s+market\s+)?paperback\s*$/i,
    ''
  );
  t = t.replace(
    /\s*(?::|—|–|-|\/)\s*(?:a\s+)?[a-z0-9'’&.\s]{0,28}\bbook\s+club(?:\s+(?:pick|edition|selection))?\s*$/i,
    ''
  );

  // Strip trailing chained edition phrases (with or without colon/dash, e.g. "The City of Brass Deluxe Collector's Edition")
  const chainedTailRe = new RegExp(
    `^(.*?\\S)\\s*(?:(?::|—|–|-|/)\\s*|\\s+)${CHAINED_EDITION_SUFFIX_RE.source}\\s*$`,
    'i'
  );
  const chainedMatch = t.match(chainedTailRe);
  if (chainedMatch?.[1] && chainedMatch[1].trim().length >= 3) {
    t = chainedMatch[1].trim();
  }

  // Remove trailing " - Trade Paperback", " : Deluxe Edition", or space-separated retailer/edition suffixes
  for (const pat of EDITION_DECORATION_PATTERNS) {
    const tailRe = new RegExp(`\\s*(?::|—|–|-|/)\\s*${pat.source}\\s*$`, 'i');
    t = t.replace(tailRe, '');
    if (/edition|paperback|large\s+print|book\s+club|tie-?in/i.test(pat.source)) {
      const spaceTailRe = new RegExp(`^(.*?\\S)\\s+${pat.source}\\s*$`, 'i');
      const spaceMatch = t.match(spaceTailRe);
      if (spaceMatch?.[1] && spaceMatch[1].trim().length >= 3) {
        t = spaceMatch[1].trim();
      }
    }
  }

  return t.replace(/\s{2,}/g, ' ').trim() || rawTitle.trim();
}

export function normalizeAuthorCanonicalKey(name: string): string {
  let s = (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '');

  // Collapse spaced initials like "v. e. schwab" or "j. r. r. tolkien" -> "ve schwab" / "jrr tolkien"
  s = s.replace(/\b([a-z])\.\s*(?=[a-z]\.)/g, '$1');
  s = s.replace(/\b([a-z])\./g, '$1');

  return s
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr|iii|ii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function romanToInt(roman: string): number | null {
  const map: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10,
  };
  return map[roman.toLowerCase()] ?? null;
}

function extractExplicitVolumeNumber(rawTitle: string): number | null {
  const t = rawTitle || '';
  const patterns = [
    /(?:volume|vol\.?|book|part|tome)\s+(\d{1,3})\b/i,
    /#\s*(\d{1,3})(?:\b|$)/i,
    /\b(?:volume|vol\.?|book|part)\s+(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      const asNum = Number(m[1]);
      if (!Number.isNaN(asNum) && asNum > 0) return asNum;
      const asRom = romanToInt(m[1]);
      if (asRom) return asRom;
    }
  }
  return null;
}

function normalizeSegmentTokens(raw: string, stripLeadingArticle: boolean): string {
  let s = (raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(new RegExp(CHAINED_EDITION_SUFFIX_RE.source, 'gi'), ' ')
    .replace(/['’‘`]/g, '')
    .replace(/&/g, ' and ');

  s = s.replace(new RegExp(CHAINED_EDITION_SUFFIX_RE.source, 'gi'), ' ');

  for (const pat of EDITION_DECORATION_PATTERNS) {
    s = s.replace(new RegExp(pat.source, 'gi'), ' ');
  }

  // Strip series/book numbering tokens ("book 1", "vol 2", "#1")
  s = s
    .replace(/\b(?:book|volume|vol|part)\s+\d+\b/gi, ' ')
    .replace(/#\s*\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip any leftover trailing standalone edition adjective if the core title precedes it
  const strippedTrailingAdj = s
    .replace(/\s+\b(?:deluxe|collectors?|unabridged)\s*$/i, '')
    .trim();
  if (strippedTrailingAdj.length >= 4) {
    s = strippedTrailingAdj;
  }

  if (stripLeadingArticle) {
    const withoutArticle = s.replace(/^(?:the|a|an)\s+/, '').trim();
    if (withoutArticle.length >= 4) {
      s = withoutArticle;
    }
  }

  return s;
}

export interface CanonicalWorkParts {
  headKey: string;
  subKey: string;
  fullKey: string;
  isDescriptiveSub: boolean;
  volumeNumber: number | null;
}

export function parseCanonicalWorkParts(rawTitle: string): CanonicalWorkParts {
  const volumeNumber = extractExplicitVolumeNumber(rawTitle);

  // Strip parenthetical / bracketed blocks unless doing so empties the title
  const strippedParens = (rawTitle || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .trim();
  const working = strippedParens.length >= 2 ? strippedParens : rawTitle || '';

  // Split head vs subtitle on `:`, `—`, `–`, or spaced ` - `
  const splitMatch = working.match(/^(.+?)(?:\s*[:—–]\s*|\s+-\s+)(.+)$/);
  const rawHead = splitMatch ? splitMatch[1] : working;
  const rawSub = splitMatch ? splitMatch[2] : '';

  const headKey = normalizeSegmentTokens(rawHead, true);
  let subKey = rawSub ? normalizeSegmentTokens(rawSub, false) : '';

  // Check if subtitle is a marketing/genre/edition descriptor rather than a distinct sequel title
  const subWords = subKey.split(' ').filter(Boolean);
  const isDescriptiveSub =
    !subKey ||
    DESCRIPTIVE_SUBTITLE_RE.test(rawSub) ||
    /^(?:a|an|the|how|why|what|when|where|notes|essays|memoir|poems)\b/i.test(
      rawSub.trim()
    ) ||
    subWords.length >= 5 ||
    subKey === headKey;

  if (subKey && subKey === headKey) {
    subKey = '';
  }

  const fullKey = subKey && !isDescriptiveSub ? `${headKey}::${subKey}` : headKey;

  return {
    headKey,
    subKey,
    fullKey,
    isDescriptiveSub,
    volumeNumber,
  };
}

/**
 * Fast string key for Map indexing (`canonicalTitle::canonicalAuthor`).
 */
export function getCanonicalWorkKey(title: string, authorName: string): string {
  const parts = parseCanonicalWorkParts(title);
  const authorKey = normalizeAuthorCanonicalKey(authorName);
  return `${parts.fullKey || parts.headKey}::${authorKey}`;
}

/**
 * Pairwise canonical work check: handles republications, trade paperbacks,
 * self-pub subtitles, and Goodreads series tags without collapsing distinct sequels.
 */
export function areSameCanonicalWork(
  a: { title: string; authorName: string },
  b: { title: string; authorName: string }
): boolean {
  const authorA = normalizeAuthorCanonicalKey(a.authorName);
  const authorB = normalizeAuthorCanonicalKey(b.authorName);
  if (authorA && authorB && authorA !== authorB) {
    // Allow one containing the other for pen-name middle initials ("Martha Wells" vs "Martha R Wells")
    const tokensA = authorA.split(' ');
    const tokensB = authorB.split(' ');
    const lastMatch =
      tokensA.length >= 2 &&
      tokensB.length >= 2 &&
      tokensA[0][0] === tokensB[0][0] &&
      tokensA[tokensA.length - 1] === tokensB[tokensB.length - 1];
    if (!lastMatch) return false;
  }

  const pa = parseCanonicalWorkParts(a.title);
  const pb = parseCanonicalWorkParts(b.title);

  if (!pa.headKey || !pb.headKey) return false;

  // Never collapse explicitly different numbered volumes ("Heartstopper Vol. 1" vs "Vol. 2")
  if (
    pa.volumeNumber !== null &&
    pb.volumeNumber !== null &&
    pa.volumeNumber !== pb.volumeNumber
  ) {
    return false;
  }

  if (pa.fullKey === pb.fullKey) {
    return true;
  }

  // Match "Title" against "Title: Marketing/Genre Subtitle"
  if (pa.headKey === pb.headKey && pa.headKey.length >= 4) {
    const aHasDistinctSub = Boolean(pa.subKey && !pa.isDescriptiveSub);
    const bHasDistinctSub = Boolean(pb.subKey && !pb.isDescriptiveSub);
    if (!aHasDistinctSub || !bHasDistinctSub) {
      return true;
    }
  }

  return false;
}

function normalizedSortableDate(
  releaseDate?: string,
  datePrecision?: DatePrecision
): string | null {
  if (!releaseDate) return null;
  if (datePrecision === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    return releaseDate;
  }
  if (datePrecision === 'month' && /^\d{4}-\d{2}$/.test(releaseDate)) {
    return `${releaseDate}-15`;
  }
  if (datePrecision === 'year' && /^\d{4}$/.test(releaseDate)) {
    return `${releaseDate}-06-15`;
  }
  return releaseDate;
}

function daysBetweenSortableDates(earlierYmd: string, laterYmd: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(earlierYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(laterYmd)) {
    return 0;
  }
  const a = Date.parse(`${earlierYmd}T00:00:00Z`);
  const b = Date.parse(`${laterYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Downgrades catalog placeholder dates (`YYYY-01-01` for >=2020 or `YYYY-12-31` for >=currentYear)
 * into year-only precision so they neither display as fake Jan 1 / Dec 31 dates nor block real dates.
 */
export function sanitizeCatalogReleaseDate(
  releaseDate?: string,
  datePrecision: DatePrecision = 'unknown',
  currentYear = new Date().getFullYear()
): { releaseDate?: string; datePrecision: DatePrecision } {
  if (!releaseDate) {
    return { releaseDate: undefined, datePrecision: 'unknown' };
  }
  if (datePrecision === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    const yearNum = Number(releaseDate.slice(0, 4));
    const md = releaseDate.slice(5);
    if (
      (md === '01-01' && yearNum >= 2020) ||
      (md === '12-31' && yearNum >= currentYear)
    ) {
      return {
        releaseDate: String(yearNum),
        datePrecision: 'year',
      };
    }
  }
  return { releaseDate, datePrecision };
}

function isAlreadyReleased(
  book: Pick<BookItem, 'releaseDate' | 'datePrecision'>,
  todayStr: string
): boolean {
  if (!book.releaseDate) return false;
  const todayYear = todayStr.slice(0, 4);
  const todayMonth = todayStr.slice(0, 7);
  if (book.datePrecision === 'day') return book.releaseDate <= todayStr;
  if (book.datePrecision === 'month') return book.releaseDate <= todayMonth;
  if (book.datePrecision === 'year') return book.releaseDate < todayYear;
  return false;
}

export function isProtectedUserManualBook(
  book: Pick<BookItem, 'id' | 'isManual' | 'userEdited'>
): boolean {
  return Boolean(
    book.userEdited || (book.isManual && book.id.startsWith('manual:book:'))
  );
}

export function pickCanonicalReleaseDate(
  rawA: BookItem,
  rawB: BookItem,
  todayStr: string,
  aUsersCount?: number,
  bUsersCount?: number
): { releaseDate?: string; datePrecision: DatePrecision } {
  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();
  const sanA = isProtectedUserManualBook(rawA)
    ? { releaseDate: rawA.releaseDate, datePrecision: rawA.datePrecision }
    : sanitizeCatalogReleaseDate(rawA.releaseDate, rawA.datePrecision, currentYear);
  const sanB = isProtectedUserManualBook(rawB)
    ? { releaseDate: rawB.releaseDate, datePrecision: rawB.datePrecision }
    : sanitizeCatalogReleaseDate(rawB.releaseDate, rawB.datePrecision, currentYear);

  const a: BookItem = { ...rawA, ...sanA };
  const b: BookItem = { ...rawB, ...sanB };

  if (!a.releaseDate) {
    return { releaseDate: b.releaseDate, datePrecision: b.datePrecision };
  }
  if (!b.releaseDate) {
    return { releaseDate: a.releaseDate, datePrecision: a.datePrecision };
  }

  const aReleased = isAlreadyReleased(a, todayStr);
  const bReleased = isAlreadyReleased(b, todayStr);

  // If one copy was ALREADY published and the other is a future republication/paperback:
  // keep the original published date unless the past entry is a tiny dead stub (<5 users vs >=50 users).
  if (aReleased !== bReleased) {
    const past = aReleased ? a : b;
    const future = aReleased ? b : a;
    const pastUsers = aReleased ? aUsersCount : bUsersCount;
    const futureUsers = aReleased ? bUsersCount : aUsersCount;

    const pastLooksLikeDeadStub =
      typeof pastUsers === 'number' &&
      typeof futureUsers === 'number' &&
      pastUsers < 5 &&
      futureUsers >= 50 &&
      !isStrictSecondaryReissueTitle(future.title);

    const chosen = pastLooksLikeDeadStub ? future : past;
    return {
      releaseDate: chosen.releaseDate,
      datePrecision: chosen.datePrecision,
    };
  }

  const yearA = a.releaseDate.slice(0, 4);
  const yearB = b.releaseDate.slice(0, 4);

  // Same publication year: prefer exact day precision over month/year
  if (yearA === yearB) {
    const rank = (p: DatePrecision) =>
      p === 'day' ? 3 : p === 'month' ? 2 : p === 'year' ? 1 : 0;
    if (rank(a.datePrecision) !== rank(b.datePrecision)) {
      const better = rank(a.datePrecision) > rank(b.datePrecision) ? a : b;
      return {
        releaseDate: better.releaseDate,
        datePrecision: better.datePrecision,
      };
    }
  }

  const sortA = normalizedSortableDate(a.releaseDate, a.datePrecision) || '9999';
  const sortB = normalizedSortableDate(b.releaseDate, b.datePrecision) || '9999';

  // Both released: earliest original publication date wins over 6+ month paperback/deluxe reissues,
  // while guarding against 1-5 month cancelled pre-delay street-date stubs (e.g. Nov 2025 delayed to Jan 2026).
  if (aReleased && bReleased) {
    const aIsEarlier = sortA <= sortB;
    const earlier = aIsEarlier ? a : b;
    const later = aIsEarlier ? b : a;
    const earlierSort = aIsEarlier ? sortA : sortB;
    const laterSort = aIsEarlier ? sortB : sortA;
    const earlierUsers = aIsEarlier ? aUsersCount : bUsersCount;
    const laterUsers = aIsEarlier ? bUsersCount : aUsersCount;

    const gapDays = daysBetweenSortableDates(earlierSort, laterSort);
    const earlierFinishedBeforeLater = Boolean(
      earlier.finishedAt &&
        /^\d{4}-\d{2}-\d{2}$/.test(earlier.finishedAt) &&
        earlier.finishedAt < laterSort
    );

    if (
      gapDays > 0 &&
      gapDays < 180 &&
      !earlierFinishedBeforeLater &&
      !hasEditionDecorationInTitle(later.title) &&
      !isStrictSecondaryReissueTitle(later.title)
    ) {
      const laterMuchMorePopular =
        typeof laterUsers === 'number' &&
        typeof earlierUsers === 'number' &&
        laterUsers >= Math.max(15, earlierUsers * 3);
      const hardcoverOverGoogleSlip =
        later.source === 'hardcover' &&
        earlier.source === 'google' &&
        later.datePrecision === 'day';

      if (laterMuchMorePopular || hardcoverOverGoogleSlip) {
        return {
          releaseDate: later.releaseDate,
          datePrecision: later.datePrecision,
        };
      }
    }

    return {
      releaseDate: earlier.releaseDate,
      datePrecision: earlier.datePrecision,
    };
  }

  // Both upcoming: prefer day precision, then higher readership or earlier date
  const rank = (p: DatePrecision) =>
    p === 'day' ? 3 : p === 'month' ? 2 : p === 'year' ? 1 : 0;
  if (rank(a.datePrecision) !== rank(b.datePrecision)) {
    const better = rank(a.datePrecision) > rank(b.datePrecision) ? a : b;
    return {
      releaseDate: better.releaseDate,
      datePrecision: better.datePrecision,
    };
  }
  if ((aUsersCount ?? 0) !== (bUsersCount ?? 0)) {
    const popular = (aUsersCount ?? 0) >= (bUsersCount ?? 0) ? a : b;
    return {
      releaseDate: popular.releaseDate,
      datePrecision: popular.datePrecision,
    };
  }
  const first = sortA <= sortB ? a : b;
  return {
    releaseDate: first.releaseDate,
    datePrecision: first.datePrecision,
  };
}

/**
 * Reconciles an existing tracked/catalog book's stored date with a freshly resolved
 * canonical catalog date from `/api/authors/books` or `/api/import/enrich`.
 * - Restores earlier original publication dates over later paperback/deluxe reissues.
 * - Accepts forward street-date pushbacks (<180 days, e.g. Nov 2025 delayed to Jan 2026)
 *   so stale pre-delay dates in local/cloud state update cleanly instead of staying stuck.
 */
export function reconcileRefreshedBookDate(
  existing: BookItem,
  refreshed: BookItem,
  todayStr: string
): { releaseDate?: string; datePrecision: DatePrecision } {
  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();
  const isUserManual = isProtectedUserManualBook(existing);
  if (isUserManual && existing.releaseDate && existing.datePrecision !== 'unknown') {
    return {
      releaseDate: existing.releaseDate,
      datePrecision: existing.datePrecision,
    };
  }

  const sanEx = sanitizeCatalogReleaseDate(
    existing.releaseDate,
    existing.datePrecision,
    currentYear
  );
  const sanRef = sanitizeCatalogReleaseDate(
    refreshed.releaseDate,
    refreshed.datePrecision,
    currentYear
  );

  if (!sanRef.releaseDate || sanRef.datePrecision === 'unknown') {
    return sanEx;
  }
  if (!sanEx.releaseDate || sanEx.datePrecision === 'unknown') {
    return sanRef;
  }

  const rank = (p: DatePrecision) =>
    p === 'day' ? 3 : p === 'month' ? 2 : p === 'year' ? 1 : 0;

  const exYear = sanEx.releaseDate.slice(0, 4);
  const refYear = sanRef.releaseDate.slice(0, 4);

  // Same publication year with different precision: prefer the more precise date
  // (unless existing's exact day is impossibly after finishedAt)
  if (exYear === refYear && rank(sanEx.datePrecision) !== rank(sanRef.datePrecision)) {
    const exAfterFinished = Boolean(
      existing.finishedAt &&
        /^\d{4}-\d{2}-\d{2}$/.test(existing.finishedAt) &&
        sanEx.datePrecision === 'day' &&
        sanEx.releaseDate > existing.finishedAt
    );
    if (!exAfterFinished) {
      return rank(sanRef.datePrecision) >= rank(sanEx.datePrecision) ? sanRef : sanEx;
    }
    return sanRef;
  }

  const sortEx = normalizedSortableDate(sanEx.releaseDate, sanEx.datePrecision) || '9999';
  const sortRef =
    normalizedSortableDate(sanRef.releaseDate, sanRef.datePrecision) || '9999';

  if (sortRef === sortEx) {
    return rank(sanRef.datePrecision) >= rank(sanEx.datePrecision) ? sanRef : sanEx;
  }

  // Fresh catalog date is EARLIER than stored date (e.g. 2025-06-03 vs 2026-06-09 paperback,
  // 2025-02-11 vs 2025-11-11 reissue, or 2017 vs 2025 Deluxe Collector's Edition)
  if (sortRef < sortEx) {
    const gapBackDays = daysBetweenSortableDates(sortRef, sortEx);
    // Guard against Google-only 1-5 month pre-delay stubs overwriting an exact Hardcover date
    if (
      gapBackDays > 0 &&
      gapBackDays < 180 &&
      refreshed.source === 'google' &&
      existing.source === 'hardcover' &&
      sanEx.datePrecision === 'day' &&
      !(existing.finishedAt && sanEx.releaseDate > existing.finishedAt)
    ) {
      return sanEx;
    }
    return sanRef;
  }

  // Fresh catalog date is LATER than stored date (`sortRef > sortEx`):
  // Allow publisher release-date pushbacks (<180 days, e.g. Nov 27, 2025 -> Jan 29, 2026)
  // while blocking 6+ month paperback/deluxe reissues from overwriting original hardcovers.
  const gapForwardDays = daysBetweenSortableDates(sortEx, sortRef);
  const finishedBeforeRef = Boolean(
    existing.finishedAt &&
      /^\d{4}-\d{2}-\d{2}$/.test(existing.finishedAt) &&
      existing.finishedAt < sortRef
  );

  if (
    gapForwardDays > 0 &&
    gapForwardDays < 180 &&
    !finishedBeforeRef &&
    rank(sanRef.datePrecision) >= 2 &&
    !hasEditionDecorationInTitle(refreshed.title) &&
    !isStrictSecondaryReissueTitle(refreshed.title)
  ) {
    return sanRef;
  }

  // Also trust fresh catalog schedules when both dates are still upcoming
  if (
    !isAlreadyReleased({ ...existing, ...sanEx }, todayStr) &&
    !isAlreadyReleased({ ...refreshed, ...sanRef }, todayStr) &&
    !isStrictSecondaryReissueTitle(refreshed.title)
  ) {
    return sanRef;
  }

  return sanEx;
}

function statusPriority(status: ReadingStatus): number {
  if (status === 'read') return 3;
  if (status === 'todo') return 2;
  return 1;
}

function countProperCapitalizedWords(title: string): number {
  const words = title.split(/\s+/).filter(Boolean);
  let count = 0;
  for (let i = 1; i < words.length; i++) {
    const cleanWord = words[i].replace(/^[^A-Za-z]+/, '');
    if (cleanWord.length >= 4 && /^[A-Z]/.test(cleanWord)) {
      count += 1;
    }
  }
  return count;
}

export function pickCleanerTitle(aTitle: string, bTitle: string): string {
  const cleanA = cleanDisplayBookTitle(aTitle);
  const cleanB = cleanDisplayBookTitle(bTitle);
  const aDecorated = hasEditionDecorationInTitle(aTitle);
  const bDecorated = hasEditionDecorationInTitle(bTitle);

  if (aDecorated && !bDecorated) return cleanB;
  if (bDecorated && !aDecorated) return cleanA;

  // Upgrade MARC/library sentence-case titles ("The pickle index", "Traitor's son")
  // to proper Title Case ("The Pickle Index", "Traitor's Son") when otherwise equivalent
  if (cleanA.toLowerCase() === cleanB.toLowerCase()) {
    return countProperCapitalizedWords(cleanB) >
      countProperCapitalizedWords(cleanA)
      ? cleanB
      : cleanA;
  }

  return cleanA.length <= cleanB.length ? cleanA : cleanB;
}

/**
 * Merges two BookItem records representing the same canonical work, preserving
 * all reading status, ratings, notes, Vellum progress, and earliest original release date.
 */
export function mergeCanonicalBookPair(
  a: BookItem,
  b: BookItem,
  todayStr: string,
  meta?: { aUsersCount?: number; bUsersCount?: number }
): BookItem {
  // Choose canonical primary ID: prefer user-engaged record, then Hardcover, then non-vellum catalog ID
  const aEngaged =
    a.readingStatus !== 'none' || Boolean(a.rating || a.notes || a.vellumBookId);
  const bEngaged =
    b.readingStatus !== 'none' || Boolean(b.rating || b.notes || b.vellumBookId);

  const scoreIdentity = (item: BookItem, engaged: boolean, users?: number) =>
    (engaged ? 100 : 0) +
    (item.source === 'hardcover' ? 30 : item.source === 'google' ? 15 : 5) +
    (!item.id.startsWith('vellum:') ? 10 : 0) +
    (!hasEditionDecorationInTitle(item.title) ? 8 : 0) +
    (item.coverUrl ? 5 : 0) +
    Math.min(20, Math.floor((users || 0) / 50));

  const keepAIdentity =
    scoreIdentity(a, aEngaged, meta?.aUsersCount) >=
    scoreIdentity(b, bEngaged, meta?.bUsersCount);

  const primary = keepAIdentity ? a : b;
  const secondary = keepAIdentity ? b : a;

  const bestStatus =
    statusPriority(a.readingStatus) >= statusPriority(b.readingStatus)
      ? a.readingStatus
      : b.readingStatus;

  const bestDate = pickCanonicalReleaseDate(
    a,
    b,
    todayStr,
    meta?.aUsersCount,
    meta?.bUsersCount
  );

  // Only keep hidden=true if BOTH copies were hidden (so hiding a duplicate paperback doesn't hide the main book!)
  const mergedHidden = Boolean(a.hidden) && Boolean(b.hidden);

  const aVelTs = a.vellumLastReadAt ? Date.parse(a.vellumLastReadAt) || 0 : 0;
  const bVelTs = b.vellumLastReadAt ? Date.parse(b.vellumLastReadAt) || 0 : 0;
  const velPrimary = bVelTs > aVelTs ? b : a;

  const updatedAt = a.updatedAt >= b.updatedAt ? a.updatedAt : b.updatedAt;

  return {
    ...secondary,
    ...primary,
    id: primary.id,
    title: pickCleanerTitle(primary.title, secondary.title),
    authorId: primary.authorId || secondary.authorId,
    coverUrl: pickPreferredCoverUrl(
      primary.coverUrl,
      secondary.coverUrl,
      primary.title,
      secondary.title
    ),
    releaseDate: bestDate.releaseDate,
    datePrecision: bestDate.datePrecision,
    description:
      (primary.description?.length || 0) >= (secondary.description?.length || 0)
        ? primary.description || secondary.description
        : secondary.description,
    pageCount: primary.pageCount || secondary.pageCount,
    isbn: primary.isbn || secondary.isbn,
    isOneOff:
      primary.authorId || secondary.authorId
        ? false
        : Boolean(primary.isOneOff || secondary.isOneOff),
    isManual: Boolean(primary.isManual && secondary.isManual),
    userEdited: Boolean(primary.userEdited || secondary.userEdited) || undefined,
    hidden: mergedHidden,
    readingStatus: bestStatus,
    addedToTodoAt:
      bestStatus === 'todo'
        ? a.addedToTodoAt || b.addedToTodoAt
        : undefined,
    finishedAt:
      bestStatus === 'read'
        ? a.finishedAt || b.finishedAt
        : undefined,
    rating: a.rating ?? b.rating,
    notes:
      (a.notes?.length || 0) >= (b.notes?.length || 0)
        ? a.notes ?? b.notes
        : b.notes,
    vellumBookId: velPrimary.vellumBookId || a.vellumBookId || b.vellumBookId,
    vellumProgress:
      velPrimary.vellumProgress ?? a.vellumProgress ?? b.vellumProgress,
    vellumChapter:
      velPrimary.vellumChapter || a.vellumChapter || b.vellumChapter,
    vellumLastReadAt:
      velPrimary.vellumLastReadAt || a.vellumLastReadAt || b.vellumLastReadAt,
    vellumFormat: velPrimary.vellumFormat || a.vellumFormat || b.vellumFormat,
    updatedAt,
  };
}

/**
 * Consolidates duplicate editions/republications already in a user's ledger
 * and returns both the deduplicated array and any absorbed book IDs to clean up in cloud storage.
 */
export function consolidateDuplicateBooks(
  books: BookItem[],
  todayStr: string
): { books: BookItem[]; removedIds: string[] } {
  const result: BookItem[] = [];
  const removedIds: string[] = [];

  // Bucket by normalized author last-token so pairwise work checks stay O(N) instead of O(N^2)
  const indicesByAuthorBucket = new Map<string, number[]>();

  const getBucketKey = (authorName: string): string => {
    const norm = normalizeAuthorCanonicalKey(authorName);
    const parts = norm.split(' ').filter(Boolean);
    return parts[parts.length - 1] || norm || '_unknown';
  };

  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();

  for (const rawItem of books) {
    const protectedManual = isProtectedUserManualBook(rawItem);
    let sanitizedDate = protectedManual
      ? { releaseDate: rawItem.releaseDate, datePrecision: rawItem.datePrecision }
      : sanitizeCatalogReleaseDate(
          rawItem.releaseDate,
          rawItem.datePrecision,
          currentYear
        );

    // If the user finished reading this book on an earlier date (e.g. Mar 8, 2025 vs a Nov 11, 2025 reissue,
    // or 2016 vs a 2024 reissue), never display a release date after the date the book was finished.
    if (
      !protectedManual &&
      rawItem.finishedAt &&
      /^\d{4}-\d{2}-\d{2}$/.test(rawItem.finishedAt) &&
      rawItem.finishedAt <= todayStr &&
      sanitizedDate.releaseDate
    ) {
      const finYear = Number(rawItem.finishedAt.slice(0, 4));
      const relYear = Number(sanitizedDate.releaseDate.slice(0, 4));
      const sameYearAfterFinish =
        relYear === finYear &&
        ((sanitizedDate.datePrecision === 'day' &&
          sanitizedDate.releaseDate > rawItem.finishedAt) ||
          (sanitizedDate.datePrecision === 'month' &&
            sanitizedDate.releaseDate > rawItem.finishedAt.slice(0, 7)));
      if (finYear >= 1900 && (relYear > finYear || sameYearAfterFinish)) {
        sanitizedDate = {
          releaseDate: String(finYear),
          datePrecision: 'year',
        };
      }
    }

    const item: BookItem = {
      ...rawItem,
      ...sanitizedDate,
      title: protectedManual ? rawItem.title : cleanDisplayBookTitle(rawItem.title),
    };

    // Drop pure un-engaged multi-book box sets / summaries / foreign-edition noise
    const isUnengagedCatalogItem =
      item.readingStatus === 'none' &&
      !protectedManual &&
      !item.isOneOff &&
      !item.rating &&
      !item.notes &&
      !item.vellumBookId;

    if (
      isUnengagedCatalogItem &&
      (isLikelyNoiseTitle(rawItem.title, true) ||
        (!isAlreadyReleased(item, todayStr) &&
          isStrictSecondaryReissueTitle(rawItem.title)))
    ) {
      removedIds.push(item.id);
      continue;
    }

    const bucket = getBucketKey(item.authorName);
    const candidateIndices = indicesByAuthorBucket.get(bucket) || [];

    let matchedIdx = -1;
    for (const idx of candidateIndices) {
      const existing = result[idx];
      if (
        existing.id === item.id ||
        (existing.vellumBookId &&
          item.vellumBookId &&
          existing.vellumBookId === item.vellumBookId) ||
        areSameCanonicalWork(existing, item)
      ) {
        matchedIdx = idx;
        break;
      }
    }

    if (matchedIdx >= 0) {
      const existing = result[matchedIdx];
      const merged = mergeCanonicalBookPair(existing, item, todayStr);
      const droppedId = merged.id === existing.id ? item.id : existing.id;
      if (droppedId !== merged.id) {
        removedIds.push(droppedId);
      }
      result[matchedIdx] = merged;
    } else {
      const nextIdx = result.length;
      result.push(item);
      candidateIndices.push(nextIdx);
      indicesByAuthorBucket.set(bucket, candidateIndices);
    }
  }

  return { books: result, removedIds };
}
