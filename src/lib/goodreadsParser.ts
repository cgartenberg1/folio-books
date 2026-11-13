import { cleanDisplayBookTitle } from '@/lib/bookDedupe';

export interface GoodreadsParsedBook {
  rowKey: string;
  goodreadsBookId?: string;
  rawTitle: string;
  cleanSearchTitle: string;
  authorName: string;
  isbn10?: string;
  isbn13?: string;
  myRating?: number;
  pageCount?: number;
  releaseYear?: number;
  dateRead?: string; // YYYY-MM-DD
  dateAdded?: string; // YYYY-MM-DD
  exclusiveShelf: 'read' | 'to-read' | 'currently-reading' | 'other';
  rawExclusiveShelf: string;
  notes?: string;
}

export interface GoodreadsAuthorSummary {
  key: string;
  name: string;
  totalBooks: number;
  readCount: number;
  toReadCount: number;
  avgRating?: number;
  maxRating: number;
  sampleTitles: string[];
}

export interface GoodreadsParseResult {
  books: GoodreadsParsedBook[];
  authors: GoodreadsAuthorSummary[];
  counts: {
    total: number;
    read: number;
    toRead: number;
    currentlyReading: number;
    other: number;
    readByYear: Record<number, number>;
  };
}

/**
 * RFC-4180 compliant CSV parser supporting multi-line quoted fields (e.g. Goodreads reviews),
 * escaped double quotes (""), UTF-8 BOM, and CRLF/LF line endings.
 */
export function parseCsvRows(rawCsv: string): string[][] {
  const text = rawCsv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentField);
      currentField = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') {
        i += 1;
      }
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0]?.trim() !== '') {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else if (ch === '\n') {
      currentRow.push(currentField);
      if (currentRow.length > 1 || currentRow[0]?.trim() !== '') {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 1 || currentRow[0]?.trim() !== '') {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Strips Goodreads' Excel formula wrapper `="0765326353"` -> `0765326353`.
 */
function cleanGoodreadsExcelField(raw?: string): string {
  if (!raw) return '';
  let s = raw.trim();
  if (s.startsWith('="') && s.endsWith('"')) {
    s = s.slice(2, -1);
  } else if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function cleanIsbn(raw?: string): string | undefined {
  const cleaned = cleanGoodreadsExcelField(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (cleaned.length === 10 || cleaned.length === 13) {
    return cleaned;
  }
  return undefined;
}

/**
 * Normalizes Goodreads date strings (`YYYY/MM/DD`, `YYYY-MM-DD`, or `M/D/YYYY` / `M/D/YY`)
 * into `YYYY-MM-DD`.
 */
export function normalizeGoodreadsDate(raw?: string): string | undefined {
  const cleaned = cleanGoodreadsExcelField(raw);
  if (!cleaned) return undefined;

  // YYYY/MM/DD or YYYY-MM-DD
  const ymd = cleaned.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    const y = ymd[1];
    const m = ymd[2].padStart(2, '0');
    const d = ymd[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // M/D/YYYY or M/D/YY (if CSV was opened and re-saved in Excel)
  const mdy = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const m = mdy[1].padStart(2, '0');
    const d = mdy[2].padStart(2, '0');
    let yNum = Number(mdy[3]);
    if (mdy[3].length === 2) {
      yNum += yNum >= 70 ? 1900 : 2000;
    }
    return `${yNum}-${m}-${d}`;
  }

  return undefined;
}

function cleanGoodreadsHtmlNotes(review?: string, privateNotes?: string): string | undefined {
  const parts = [review, privateNotes]
    .map((p) =>
      (p || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim()
    )
    .filter(Boolean);

  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
}

function stripSeriesSuffix(title: string): string {
  // Goodreads titles frequently look like "The Way of Kings (The Stormlight Archive, #1)"
  // or "Great Big Beautiful Life: Reese's Book Club"
  const withoutSeries = title
    .replace(/\s*\([^)]*#\d+[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleanDisplayBookTitle(withoutSeries);
}

export function parseGoodreadsCsv(csvText: string): GoodreadsParseResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    throw new Error('CSV file appears empty or missing book rows.');
  }

  const headerRow = rows[0].map((h) => h.trim().toLowerCase());
  const colIdx = (names: string[]): number => {
    for (const name of names) {
      const idx = headerRow.indexOf(name.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const titleCol = colIdx(['title', 'book title']);
  const authorCol = colIdx(['author', 'author name', 'authors']);
  if (titleCol === -1 || authorCol === -1) {
    throw new Error(
      'Could not find "Title" and "Author" columns. Make sure this is a Goodreads library export CSV.'
    );
  }

  const bookIdCol = colIdx(['book id']);
  const isbnCol = colIdx(['isbn', 'isbn10']);
  const isbn13Col = colIdx(['isbn13', 'isbn-13']);
  const ratingCol = colIdx(['my rating', 'rating']);
  const pagesCol = colIdx(['number of pages', 'pages']);
  const yearPubCol = colIdx(['year published']);
  const origYearCol = colIdx(['original publication year', 'publication year']);
  const dateReadCol = colIdx(['date read', 'finish date', 'finished date']);
  const dateAddedCol = colIdx(['date added']);
  const exclusiveShelfCol = colIdx(['exclusive shelf', 'shelf', 'read status', 'status']);
  const bookshelvesCol = colIdx(['bookshelves']);
  const reviewCol = colIdx(['my review', 'review']);
  const notesCol = colIdx(['private notes', 'notes']);

  const books: GoodreadsParsedBook[] = [];
  const counts = {
    total: 0,
    read: 0,
    toRead: 0,
    currentlyReading: 0,
    other: 0,
    readByYear: {} as Record<number, number>,
  };

  const authorMap = new Map<
    string,
    {
      name: string;
      totalBooks: number;
      readCount: number;
      toReadCount: number;
      ratingSum: number;
      ratedCount: number;
      maxRating: number;
      sampleTitles: string[];
    }
  >();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawTitle = cleanGoodreadsExcelField(row[titleCol]).replace(/\s+/g, ' ');
    const authorName = cleanGoodreadsExcelField(row[authorCol]).replace(/\s+/g, ' ');
    if (!rawTitle || !authorName) continue;

    const goodreadsBookId =
      bookIdCol !== -1 ? cleanGoodreadsExcelField(row[bookIdCol]) || undefined : undefined;
    const isbn10 = isbnCol !== -1 ? cleanIsbn(row[isbnCol]) : undefined;
    const isbn13 = isbn13Col !== -1 ? cleanIsbn(row[isbn13Col]) : undefined;

    const rawRating = ratingCol !== -1 ? Number(cleanGoodreadsExcelField(row[ratingCol])) : 0;
    const myRating =
      !Number.isNaN(rawRating) && rawRating >= 1 && rawRating <= 5
        ? Math.round(rawRating)
        : undefined;

    const rawPages = pagesCol !== -1 ? Number(cleanGoodreadsExcelField(row[pagesCol])) : 0;
    const pageCount =
      !Number.isNaN(rawPages) && rawPages > 0 ? Math.round(rawPages) : undefined;

    const origYear =
      origYearCol !== -1 ? Number(cleanGoodreadsExcelField(row[origYearCol])) : NaN;
    const pubYear =
      yearPubCol !== -1 ? Number(cleanGoodreadsExcelField(row[yearPubCol])) : NaN;

    let releaseYear: number | undefined;
    if (!Number.isNaN(pubYear) && pubYear > new Date().getFullYear()) {
      releaseYear = pubYear;
    } else if (!Number.isNaN(origYear) && origYear >= 1000 && origYear <= 2999) {
      releaseYear = origYear;
    } else if (!Number.isNaN(pubYear) && pubYear >= 1000 && pubYear <= 2999) {
      releaseYear = pubYear;
    }

    const dateRead =
      dateReadCol !== -1 ? normalizeGoodreadsDate(row[dateReadCol]) : undefined;
    const dateAdded =
      dateAddedCol !== -1 ? normalizeGoodreadsDate(row[dateAddedCol]) : undefined;

    const rawExclusive =
      exclusiveShelfCol !== -1
        ? cleanGoodreadsExcelField(row[exclusiveShelfCol]).toLowerCase()
        : '';
    const bookshelvesStr =
      bookshelvesCol !== -1
        ? cleanGoodreadsExcelField(row[bookshelvesCol]).toLowerCase()
        : '';

    let exclusiveShelf: GoodreadsParsedBook['exclusiveShelf'] = 'other';
    if (rawExclusive === 'read' || (!rawExclusive && dateRead)) {
      exclusiveShelf = 'read';
      counts.read += 1;
      if (dateRead) {
        const y = Number(dateRead.slice(0, 4));
        if (!Number.isNaN(y)) {
          counts.readByYear[y] = (counts.readByYear[y] || 0) + 1;
        }
      }
    } else if (
      rawExclusive === 'to-read' ||
      rawExclusive === 'want-to-read' ||
      (!rawExclusive && bookshelvesStr.includes('to-read'))
    ) {
      exclusiveShelf = 'to-read';
      counts.toRead += 1;
    } else if (rawExclusive === 'currently-reading') {
      exclusiveShelf = 'currently-reading';
      counts.currentlyReading += 1;
    } else {
      exclusiveShelf = 'other';
      counts.other += 1;
    }

    counts.total += 1;

    const notes = cleanGoodreadsHtmlNotes(
      reviewCol !== -1 ? row[reviewCol] : undefined,
      notesCol !== -1 ? row[notesCol] : undefined
    );

    const cleanSearchTitle = stripSeriesSuffix(rawTitle) || rawTitle;

    books.push({
      rowKey: goodreadsBookId ? `gr:${goodreadsBookId}` : `row:${r}`,
      goodreadsBookId,
      rawTitle,
      cleanSearchTitle,
      authorName,
      isbn10,
      isbn13,
      myRating,
      pageCount,
      releaseYear,
      dateRead,
      dateAdded,
      exclusiveShelf,
      rawExclusiveShelf: rawExclusive || 'unclassified',
      notes,
    });

    // Aggregate author summary
    const authorNorm = authorName.toLowerCase().trim();
    if (!authorMap.has(authorNorm)) {
      authorMap.set(authorNorm, {
        name: authorName,
        totalBooks: 0,
        readCount: 0,
        toReadCount: 0,
        ratingSum: 0,
        ratedCount: 0,
        maxRating: 0,
        sampleTitles: [],
      });
    }
    const stat = authorMap.get(authorNorm)!;
    stat.totalBooks += 1;
    if (exclusiveShelf === 'read') stat.readCount += 1;
    if (exclusiveShelf === 'to-read' || exclusiveShelf === 'currently-reading') {
      stat.toReadCount += 1;
    }
    if (myRating) {
      stat.ratingSum += myRating;
      stat.ratedCount += 1;
      if (myRating > stat.maxRating) stat.maxRating = myRating;
    }
    if (stat.sampleTitles.length < 3) {
      stat.sampleTitles.push(cleanSearchTitle);
    }
  }

  const authors: GoodreadsAuthorSummary[] = Array.from(authorMap.entries())
    .map(([key, stat]) => ({
      key,
      name: stat.name,
      totalBooks: stat.totalBooks,
      readCount: stat.readCount,
      toReadCount: stat.toReadCount,
      avgRating:
        stat.ratedCount > 0
          ? Number((stat.ratingSum / stat.ratedCount).toFixed(1))
          : undefined,
      maxRating: stat.maxRating,
      sampleTitles: stat.sampleTitles,
    }))
    .sort((a, b) => {
      if (b.totalBooks !== a.totalBooks) return b.totalBooks - a.totalBooks;
      if (b.readCount !== a.readCount) return b.readCount - a.readCount;
      return (b.avgRating || 0) - (a.avgRating || 0);
    });

  return { books, authors, counts };
}

export function parseBatchAuthorLines(rawText: string): string[] {
  const chunks = rawText.includes('\n')
    ? rawText.split(/\r?\n/)
    : rawText.split(/[,;]/);

  const seen = new Set<string>();
  const results: string[] = [];

  for (const chunk of chunks) {
    const cleaned = chunk
      .replace(/^\s*([-*•]|\d+[.)])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(cleaned);
  }

  return results;
}

export interface ParsedBatchBookEntry {
  lineKey: string;
  rawLine: string;
  titleHint: string;
  authorHint?: string;
  isbn13?: string;
  isbn10?: string;
}

export function parseBatchBookLines(rawText: string): ParsedBatchBookEntry[] {
  const lines = rawText.split(/\r?\n/);
  const entries: ParsedBatchBookEntry[] = [];
  const seen = new Set<string>();

  lines.forEach((line, idx) => {
    const cleaned = line
      .replace(/^\s*([-*•]|\d+[.)])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return;

    const dedupe = cleaned.toLowerCase();
    if (seen.has(dedupe)) return;
    seen.add(dedupe);

    // Pure ISBN check
    const strippedIsbn = cleaned.replace(/[- ]/g, '').toUpperCase();
    if (/^\d{13}$/.test(strippedIsbn)) {
      entries.push({
        lineKey: `line:${idx}`,
        rawLine: cleaned,
        titleHint: strippedIsbn,
        isbn13: strippedIsbn,
      });
      return;
    }
    if (/^\d{9}[0-9X]$/.test(strippedIsbn)) {
      entries.push({
        lineKey: `line:${idx}`,
        rawLine: cleaned,
        titleHint: strippedIsbn,
        isbn10: strippedIsbn,
      });
      return;
    }

    // "Title by Author"
    const byMatch = cleaned.match(/^(.+?)\s+by\s+([A-Z][^—–|-]{1,60})$/i);
    if (byMatch) {
      entries.push({
        lineKey: `line:${idx}`,
        rawLine: cleaned,
        titleHint: byMatch[1].replace(/^["“]|["”]$/g, '').trim(),
        authorHint: byMatch[2].trim(),
      });
      return;
    }

    // "Title - Author" or "Title — Author" or "Title | Author"
    const sepMatch = cleaned.match(/^(.+?)\s+(?:[-—–|])\s+(.+)$/);
    if (sepMatch) {
      entries.push({
        lineKey: `line:${idx}`,
        rawLine: cleaned,
        titleHint: sepMatch[1].replace(/^["“]|["”]$/g, '').trim(),
        authorHint: sepMatch[2].trim(),
      });
      return;
    }

    entries.push({
      lineKey: `line:${idx}`,
      rawLine: cleaned,
      titleHint: cleaned.replace(/^["“]|["”]$/g, '').trim(),
    });
  });

  return entries;
}
