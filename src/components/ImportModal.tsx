'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  ExternalLink,
  ListPlus,
  Loader2,
  Search,
  Star,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { Fleuron, Tabline } from '@/components/ui';
import { BatchBookEnrichInput, BatchBookEnrichMatch } from '@/lib/bookProviders';
import { parseReleaseDateInput } from '@/lib/dates';
import {
  GoodreadsParseResult,
  parseBatchAuthorLines,
  parseBatchBookLines,
  parseGoodreadsCsv,
} from '@/lib/goodreadsParser';
import {
  BookItem,
  FollowedAuthor,
  ReadingStatus,
  SearchAuthorResult,
  TabKey,
} from '@/types/books';

export type ImportTabMode = 'goodreads' | 'authors' | 'books';

interface ImportModalProps {
  initialMode?: ImportTabMode;
  existingAuthors: FollowedAuthor[];
  hasCurrentYearChallenge: boolean;
  todayStr: string;
  hardcoverToken?: string;
  onClose: () => void;
  onApplyBatchImport: (payload: {
    booksToUpsert: BookItem[];
    newAuthors: SearchAuthorResult[];
    createChallenge?: { year: number; goalCount: number };
    onAuthorSyncProgress?: (current: number, total: number, authorName: string) => void;
    shouldAbort?: () => boolean;
  }) => Promise<{ syncedAuthors: number }>;
  onNavigateTab: (tab: TabKey) => void;
}

export function ImportModal({
  initialMode = 'goodreads',
  existingAuthors,
  hasCurrentYearChallenge,
  todayStr,
  hardcoverToken,
  onClose,
  onApplyBatchImport,
  onNavigateTab,
}: ImportModalProps) {
  const currentYear = Number(todayStr.slice(0, 4));
  const [mode, setMode] = useState<ImportTabMode>(initialMode);

  // Goodreads CSV state
  const [csvFileName, setCsvFileName] = useState<string>('');
  const [csvError, setCsvError] = useState<string>('');
  const [parsedGr, setParsedGr] = useState<GoodreadsParseResult | null>(null);
  const [includeReadShelf, setIncludeReadShelf] = useState(true);
  const [includeToReadShelf, setIncludeToReadShelf] = useState(true);
  const [includeOtherShelves, setIncludeOtherShelves] = useState(false);
  const [enrichWithHardcover, setEnrichWithHardcover] = useState(true);
  const [selectedGrAuthors, setSelectedGrAuthors] = useState<Set<string>>(
    new Set()
  );
  const [grAuthorSearch, setGrAuthorSearch] = useState('');
  const [createYearChallenge, setCreateYearChallenge] = useState(false);
  const [challengeGoalInput, setChallengeGoalInput] = useState(24);

  // Batch Authors state
  const [authorsText, setAuthorsText] = useState('');

  // Batch Books state
  const [booksText, setBooksText] = useState('');
  const [batchBookDestination, setBatchBookDestination] = useState<
    'oneoff' | 'todo' | 'read'
  >('oneoff');
  const [batchReadHasDate, setBatchReadHasDate] = useState(false);
  const [batchReadDate, setBatchReadDate] = useState(todayStr);

  // Shared execution / progress state
  const [isRunning, setIsRunning] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [completedSummary, setCompletedSummary] = useState<{
    booksImported: number;
    authorsFollowed: number;
  } | null>(null);
  const abortRef = useRef(false);

  const existingAuthorNormSet = useMemo(
    () => new Set(existingAuthors.map((a) => a.name.toLowerCase().trim())),
    [existingAuthors]
  );

  const handleCsvTextLoaded = (fileName: string, text: string) => {
    setCsvError('');
    try {
      const result = parseGoodreadsCsv(text);
      setCsvFileName(fileName);
      setParsedGr(result);

      // Default author selection: 2+ books if library has > 12 authors, else all
      const defaultSelected = new Set<string>();
      const useTwoPlusThreshold = result.authors.length > 12;
      for (const a of result.authors) {
        if (existingAuthorNormSet.has(a.key)) continue;
        if (!useTwoPlusThreshold || a.totalBooks >= 2) {
          defaultSelected.add(a.key);
        }
      }
      setSelectedGrAuthors(defaultSelected);

      const readThisYear = result.counts.readByYear[currentYear] || 0;
      if (readThisYear > 0 && !hasCurrentYearChallenge) {
        setCreateYearChallenge(true);
        setChallengeGoalInput(Math.max(12, Math.ceil((readThisYear + 4) / 5) * 5));
      }
    } catch (err) {
      setCsvError(
        err instanceof Error ? err.message : 'Could not parse CSV file.'
      );
      setParsedGr(null);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      handleCsvTextLoaded(file.name, String(reader.result || ''));
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      handleCsvTextLoaded(file.name, String(reader.result || ''));
    };
    reader.readAsText(file);
  };

  const selectGrAuthorsPreset = (
    preset: '2plus' | '3plus' | 'rated4' | 'all' | 'none'
  ) => {
    if (!parsedGr) return;
    const next = new Set<string>();
    for (const a of parsedGr.authors) {
      if (existingAuthorNormSet.has(a.key)) continue;
      if (preset === 'all') next.add(a.key);
      else if (preset === '2plus' && a.totalBooks >= 2) next.add(a.key);
      else if (preset === '3plus' && a.totalBooks >= 3) next.add(a.key);
      else if (preset === 'rated4' && a.maxRating >= 4) next.add(a.key);
    }
    setSelectedGrAuthors(next);
  };

  const filteredGrAuthors = useMemo(() => {
    if (!parsedGr) return [];
    const q = grAuthorSearch.trim().toLowerCase();
    if (!q) return parsedGr.authors;
    return parsedGr.authors.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.sampleTitles.some((t) => t.toLowerCase().includes(q))
    );
  }, [parsedGr, grAuthorSearch]);

  const parsedAuthorLines = useMemo(
    () => parseBatchAuthorLines(authorsText),
    [authorsText]
  );
  const newBatchAuthorLines = useMemo(
    () =>
      parsedAuthorLines.filter(
        (name) => !existingAuthorNormSet.has(name.toLowerCase().trim())
      ),
    [parsedAuthorLines, existingAuthorNormSet]
  );

  const parsedBookLines = useMemo(
    () => parseBatchBookLines(booksText),
    [booksText]
  );

  const callEnrichEndpoint = async <T,>(body: unknown): Promise<T> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (hardcoverToken?.trim()) {
      headers['x-hardcover-token'] = hardcoverToken.trim();
    }
    const res = await fetch('/api/import/enrich', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error('Batch lookup request failed');
    }
    return res.json() as Promise<T>;
  };

  // Execute Goodreads CSV Import
  const runGoodreadsImport = async () => {
    if (!parsedGr) return;
    abortRef.current = false;
    setIsRunning(true);
    setProgressPct(4);

    try {
      const selectedRows = parsedGr.books.filter((b) => {
        if (b.exclusiveShelf === 'read') return includeReadShelf;
        if (
          b.exclusiveShelf === 'to-read' ||
          b.exclusiveShelf === 'currently-reading'
        ) {
          return includeToReadShelf;
        }
        return includeOtherShelves;
      });

      const enrichMatches: Record<string, BatchBookEnrichMatch> = {};

      if (enrichWithHardcover && selectedRows.length > 0) {
        const chunkSize = 50;
        for (let i = 0; i < selectedRows.length; i += chunkSize) {
          if (abortRef.current) break;
          const slice = selectedRows.slice(i, i + chunkSize);
          setProgressLabel(
            `Matching covers & Hardcover editions (${Math.min(
              i + slice.length,
              selectedRows.length
            )} / ${selectedRows.length})...`
          );
          setProgressPct(
            Math.round(5 + ((i + slice.length) / selectedRows.length) * 45)
          );

          const items: BatchBookEnrichInput[] = slice.map((r) => ({
            clientKey: r.rowKey,
            title: r.cleanSearchTitle,
            authorName: r.authorName,
            isbn13: r.isbn13,
            isbn10: r.isbn10,
          }));

          try {
            const data = await callEnrichEndpoint<{
              matches: Record<string, BatchBookEnrichMatch>;
            }>({ action: 'books', items });
            Object.assign(enrichMatches, data.matches || {});
          } catch {
            // Continue gracefully with CSV metadata if a batch fails
          }
        }
      }

      const nowIso = new Date().toISOString();
      const booksToUpsert: BookItem[] = selectedRows.map((row) => {
        const match = enrichMatches[row.rowKey];
        const fallbackDate = parseReleaseDateInput(undefined, row.releaseYear);
        const isbn = match?.isbn || row.isbn13 || row.isbn10;
        const openLibCover = isbn
          ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`
          : undefined;

        const readingStatus: ReadingStatus =
          row.exclusiveShelf === 'read'
            ? 'read'
            : row.exclusiveShelf === 'to-read' ||
              row.exclusiveShelf === 'currently-reading'
            ? 'todo'
            : 'none';

        return {
          id:
            match?.id ||
            (row.goodreadsBookId
              ? `gr:book:${row.goodreadsBookId}`
              : `gr:book:${Date.now().toString(36)}-${Math.random()
                  .toString(36)
                  .slice(2, 6)}`),
          source: match ? match.source : 'manual',
          externalId: match?.externalId || row.goodreadsBookId,
          title: match?.title || row.cleanSearchTitle || row.rawTitle,
          authorName: match?.authorName || row.authorName,
          coverUrl: match?.coverUrl || openLibCover,
          releaseDate: match?.releaseDate || fallbackDate.releaseDate,
          datePrecision: match
            ? match.datePrecision
            : fallbackDate.datePrecision,
          pageCount: match?.pageCount || row.pageCount,
          isbn,
          isOneOff: true,
          isManual: false,
          readingStatus,
          addedToTodoAt:
            readingStatus === 'todo'
              ? row.dateAdded
                ? `${row.dateAdded}T12:00:00.000Z`
                : nowIso
              : undefined,
          finishedAt: readingStatus === 'read' ? row.dateRead : undefined,
          rating: row.myRating,
          notes: row.notes,
          updatedAt: nowIso,
        };
      });

      // Resolve selected authors to follow
      const authorNamesToFollow = parsedGr.authors
        .filter(
          (a) =>
            selectedGrAuthors.has(a.key) && !existingAuthorNormSet.has(a.key)
        )
        .map((a) => a.name);

      const resolvedAuthors: SearchAuthorResult[] = [];
      if (authorNamesToFollow.length > 0 && !abortRef.current) {
        const authorChunk = 20;
        for (let i = 0; i < authorNamesToFollow.length; i += authorChunk) {
          if (abortRef.current) break;
          const slice = authorNamesToFollow.slice(i, i + authorChunk);
          setProgressLabel(
            `Resolving author profiles (${Math.min(
              i + slice.length,
              authorNamesToFollow.length
            )} / ${authorNamesToFollow.length})...`
          );
          setProgressPct(
            Math.round(
              52 + ((i + slice.length) / authorNamesToFollow.length) * 15
            )
          );
          try {
            const res = await callEnrichEndpoint<{
              authors: SearchAuthorResult[];
            }>({ action: 'authors', names: slice });
            resolvedAuthors.push(...(res.authors || []));
          } catch {}
        }
      }

      setProgressLabel('Saving books and syncing upcoming author releases...');
      setProgressPct(70);

      const { syncedAuthors } = await onApplyBatchImport({
        booksToUpsert,
        newAuthors: resolvedAuthors,
        createChallenge:
          createYearChallenge && challengeGoalInput > 0
            ? { year: currentYear, goalCount: challengeGoalInput }
            : undefined,
        onAuthorSyncProgress: (current, total, authorName) => {
          setProgressLabel(
            `Syncing upcoming releases for ${authorName} (${current} / ${total})...`
          );
          setProgressPct(Math.round(70 + (current / Math.max(1, total)) * 28));
        },
        shouldAbort: () => abortRef.current,
      });

      setProgressPct(100);
      setCompletedSummary({
        booksImported: booksToUpsert.length,
        authorsFollowed: syncedAuthors,
      });
    } finally {
      setIsRunning(false);
    }
  };

  // Execute Batch Authors Paste Import
  const runBatchAuthorsImport = async () => {
    if (newBatchAuthorLines.length === 0) return;
    abortRef.current = false;
    setIsRunning(true);
    setProgressPct(8);

    try {
      const resolvedAuthors: SearchAuthorResult[] = [];
      const chunkSize = 20;

      for (let i = 0; i < newBatchAuthorLines.length; i += chunkSize) {
        if (abortRef.current) break;
        const slice = newBatchAuthorLines.slice(i, i + chunkSize);
        setProgressLabel(
          `Resolving authors (${Math.min(
            i + slice.length,
            newBatchAuthorLines.length
          )} / ${newBatchAuthorLines.length})...`
        );
        setProgressPct(
          Math.round(
            10 + ((i + slice.length) / newBatchAuthorLines.length) * 30
          )
        );
        const res = await callEnrichEndpoint<{ authors: SearchAuthorResult[] }>(
          { action: 'authors', names: slice }
        );
        resolvedAuthors.push(...(res.authors || []));
      }

      const { syncedAuthors } = await onApplyBatchImport({
        booksToUpsert: [],
        newAuthors: resolvedAuthors,
        onAuthorSyncProgress: (current, total, authorName) => {
          setProgressLabel(
            `Syncing catalog for ${authorName} (${current} / ${total})...`
          );
          setProgressPct(Math.round(42 + (current / Math.max(1, total)) * 56));
        },
        shouldAbort: () => abortRef.current,
      });

      setProgressPct(100);
      setCompletedSummary({
        booksImported: 0,
        authorsFollowed: syncedAuthors,
      });
    } finally {
      setIsRunning(false);
    }
  };

  // Execute Batch Books Paste Import
  const runBatchBooksImport = async () => {
    if (parsedBookLines.length === 0) return;
    abortRef.current = false;
    setIsRunning(true);
    setProgressPct(8);

    try {
      const enrichMatches: Record<string, BatchBookEnrichMatch> = {};
      const chunkSize = 40;

      for (let i = 0; i < parsedBookLines.length; i += chunkSize) {
        if (abortRef.current) break;
        const slice = parsedBookLines.slice(i, i + chunkSize);
        setProgressLabel(
          `Looking up books (${Math.min(
            i + slice.length,
            parsedBookLines.length
          )} / ${parsedBookLines.length})...`
        );
        setProgressPct(
          Math.round(10 + ((i + slice.length) / parsedBookLines.length) * 80)
        );

        const items: BatchBookEnrichInput[] = slice.map((entry) => ({
          clientKey: entry.lineKey,
          title: entry.titleHint,
          authorName: entry.authorHint,
          isbn13: entry.isbn13,
          isbn10: entry.isbn10,
        }));

        const data = await callEnrichEndpoint<{
          matches: Record<string, BatchBookEnrichMatch>;
        }>({ action: 'books', items });
        Object.assign(enrichMatches, data.matches || {});
      }

      const nowIso = new Date().toISOString();
      const readingStatus: ReadingStatus =
        batchBookDestination === 'todo'
          ? 'todo'
          : batchBookDestination === 'read'
          ? 'read'
          : 'none';

      const booksToUpsert: BookItem[] = parsedBookLines.map((entry, idx) => {
        const match = enrichMatches[entry.lineKey];
        if (match) {
          return {
            id: match.id,
            source: match.source,
            externalId: match.externalId,
            title: match.title,
            authorName: match.authorName,
            coverUrl: match.coverUrl,
            releaseDate: match.releaseDate,
            datePrecision: match.datePrecision,
            pageCount: match.pageCount,
            isbn: match.isbn,
            isOneOff: true,
            isManual: false,
            readingStatus,
            addedToTodoAt: readingStatus === 'todo' ? nowIso : undefined,
            finishedAt:
              readingStatus === 'read' && batchReadHasDate
                ? batchReadDate
                : undefined,
            updatedAt: nowIso,
          };
        }

        // Clean manual fallback if an unannounced/indie title wasn't indexed yet
        return {
          id: `manual:batch:${Date.now().toString(36)}-${idx}`,
          source: 'manual',
          title: entry.titleHint,
          authorName: entry.authorHint || 'Unknown Author',
          releaseDate: undefined,
          datePrecision: 'unknown',
          isbn: entry.isbn13 || entry.isbn10,
          isOneOff: true,
          isManual: true,
          readingStatus,
          addedToTodoAt: readingStatus === 'todo' ? nowIso : undefined,
          finishedAt:
            readingStatus === 'read' && batchReadHasDate
              ? batchReadDate
              : undefined,
          updatedAt: nowIso,
        };
      });

      await onApplyBatchImport({
        booksToUpsert,
        newAuthors: [],
      });

      setProgressPct(100);
      setCompletedSummary({
        booksImported: booksToUpsert.length,
        authorsFollowed: 0,
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[rgb(20_14_8/0.45)] backdrop-blur-[2px] p-0 sm:p-6">
      <div className="flex max-h-[94vh] w-full animate-fade-up flex-col border border-rule bg-paper shadow-2xl sm:max-w-2xl">
        {/* Header */}
        <div className="shrink-0 px-6 pt-6 sm:px-8 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-[30px] font-medium leading-tight text-ink">
                Bring in your library
              </h2>
              <p className="mt-1 font-serif text-[15px] italic text-ink-muted">
                From a Goodreads export, or a simple list of authors or books.
              </p>
            </div>
            {!isRunning && (
              <button type="button" onClick={onClose} title="Close" className="icon-btn -mr-2 -mt-1">
                <X strokeWidth={1.5} className="h-5 w-5" />
              </button>
            )}
          </div>

          {!isRunning && !completedSummary ? (
            <Tabline
              value={mode}
              onChange={setMode}
              options={[
                { key: 'goodreads', label: 'Goodreads export' },
                { key: 'authors', label: 'A list of authors' },
                { key: 'books', label: 'A list of books' },
              ]}
              className="mt-5 border-b border-rule"
            />
          ) : (
            <div className="rule-double mt-5" />
          )}
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 pb-6 pt-5 sm:px-8 sm:pb-8">
          {/* Running Progress View */}
          {isRunning && (
            <div className="space-y-5 py-10 text-center">
              <Loader2 strokeWidth={1.5} className="mx-auto h-7 w-7 animate-spin text-claret" />
              <div>
                <h3 className="font-display text-[26px] font-medium italic leading-tight text-ink">
                  Cataloguing your library…
                </h3>
                <p className="mt-1.5 font-serif text-[15px] italic text-ink-muted">
                  {progressLabel}
                </p>
              </div>
              <div className="mx-auto h-1.5 w-full max-w-md overflow-hidden bg-paper-sunken">
                <div
                  className="h-full bg-claret transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  abortRef.current = true;
                }}
                className="btn btn-ghost btn-sm"
              >
                Finish early (keep books imported so far)
              </button>
            </div>
          )}

          {/* Completed Summary View */}
          {!isRunning && completedSummary && (
            <div className="space-y-5 py-8 text-center">
              <Fleuron />
              <div>
                <h3 className="font-display text-[30px] font-medium italic leading-tight text-ink">
                  Entered into the ledger
                </h3>
                <p className="mt-2 font-serif text-[16px] text-ink-soft">
                  {completedSummary.booksImported > 0 && (
                    <>
                      Imported{' '}
                      <strong className="font-medium text-ink">
                        {completedSummary.booksImported} books
                      </strong>
                      {completedSummary.authorsFollowed > 0 ? ' and ' : '.'}
                    </>
                  )}
                  {completedSummary.authorsFollowed > 0 && (
                    <>
                      followed{' '}
                      <strong className="font-medium text-ink">
                        {completedSummary.authorsFollowed}{' '}
                        {completedSummary.authorsFollowed === 1
                          ? 'author'
                          : 'authors'}
                      </strong>{' '}
                      with synced release calendars.
                    </>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap justify-center gap-2.5 pt-2">
                {completedSummary.authorsFollowed > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onNavigateTab('upcoming');
                      onClose();
                    }}
                    className="btn btn-primary"
                  >
                    View upcoming releases
                  </button>
                )}
                {completedSummary.booksImported > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      onNavigateTab('reading');
                      onClose();
                    }}
                    className="btn btn-outline"
                  >
                    Open Reading &amp; Challenge
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-ghost"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* MODE 1: GOODREADS CSV */}
          {!isRunning && !completedSummary && mode === 'goodreads' && (
            <div className="space-y-5">
              {!parsedGr ? (
                <>
                  <label
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDrop}
                    className="flex cursor-pointer flex-col items-center justify-center border border-dashed border-rule-strong bg-paper-raised/60 p-10 text-center transition-colors hover:border-ink"
                  >
                    <Upload strokeWidth={1.5} className="mb-3 h-7 w-7 text-claret" />
                    <span className="font-serif text-[17px] font-medium text-ink">
                      Drop your{' '}
                      <code className="border border-rule bg-paper px-1.5 py-0.5 font-mono text-[13px]">
                        goodreads_library_export.csv
                      </code>{' '}
                      here
                    </span>
                    <span className="mt-1.5 font-serif text-[14.5px] italic text-ink-muted">
                      or click to choose the CSV file from your computer
                    </span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      onChange={handleFileInput}
                      className="hidden"
                    />
                  </label>

                  {csvError && (
                    <div className="border border-claret/30 bg-claret-wash p-3.5 font-sans text-xs text-claret">
                      {csvError}
                    </div>
                  )}

                  <div className="panel space-y-1.5 p-4">
                    <p className="caps text-ink">
                      How to export from Goodreads
                    </p>
                    <p className="font-serif text-[14.5px] leading-relaxed text-ink-soft">
                      Visit{' '}
                      <a
                        href="https://www.goodreads.com/review/import"
                        target="_blank"
                        rel="noreferrer"
                        className="link inline-flex items-center gap-1"
                      >
                        goodreads.com/review/import
                        <ExternalLink strokeWidth={1.5} className="h-3 w-3" />
                      </a>{' '}
                      and click <strong className="font-medium text-ink">Export Library</strong> at the top of the page. Folio imports your <strong className="font-medium text-ink">Read</strong> history (ratings, dates, reviews, and {currentYear} Reading Challenge count), your <strong className="font-medium text-ink">To-Read</strong> shelf, and lets you choose which authors to follow.
                    </p>
                  </div>
                </>
              ) : (
                <div className="space-y-5">
                  {/* Loaded File Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border border-moss/30 bg-moss-wash px-4 py-3">
                    <div>
                      <p className="font-sans text-xs font-medium text-moss">
                        Loaded {csvFileName}
                      </p>
                      <p className="font-serif text-[14px] italic text-ink-soft">
                        {parsedGr.counts.total} books across {parsedGr.authors.length} authors
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setParsedGr(null);
                        setCsvFileName('');
                      }}
                      className="link font-sans text-xs"
                    >
                      Choose another file
                    </button>
                  </div>

                  {/* Shelves & Enrichment Options */}
                  <div className="panel space-y-3 p-4 sm:p-5">
                    <h3 className="caps text-ink-muted">
                      1. Books &amp; Shelves to Import
                    </h3>

                    <label className="flex cursor-pointer items-center justify-between gap-2 py-1 font-serif text-[15px]">
                      <span className="text-ink">
                        Import <strong className="font-medium">Read</strong> books (ratings, finish dates &amp; reviews)
                      </span>
                      <span className="flex items-center gap-2.5">
                        <span className="tag nums-lining">
                          {parsedGr.counts.read}
                        </span>
                        <input
                          type="checkbox"
                          checked={includeReadShelf}
                          onChange={(e) => setIncludeReadShelf(e.target.checked)}
                          className="h-4 w-4 accent-[rgb(var(--claret))]"
                        />
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-center justify-between gap-2 py-1 font-serif text-[15px]">
                      <span className="text-ink">
                        Import <strong className="font-medium">To-Read</strong> &amp; <strong className="font-medium">Currently Reading</strong> into To-Do
                      </span>
                      <span className="flex items-center gap-2.5">
                        <span className="tag nums-lining">
                          {parsedGr.counts.toRead + parsedGr.counts.currentlyReading}
                        </span>
                        <input
                          type="checkbox"
                          checked={includeToReadShelf}
                          onChange={(e) => setIncludeToReadShelf(e.target.checked)}
                          className="h-4 w-4 accent-[rgb(var(--claret))]"
                        />
                      </span>
                    </label>

                    {parsedGr.counts.other > 0 && (
                      <label className="flex cursor-pointer items-center justify-between gap-2 py-1 font-serif text-[15px]">
                        <span className="text-ink">
                          Import custom shelves ({parsedGr.counts.other} books)
                        </span>
                        <input
                          type="checkbox"
                          checked={includeOtherShelves}
                          onChange={(e) =>
                            setIncludeOtherShelves(e.target.checked)
                          }
                          className="h-4 w-4 accent-[rgb(var(--claret))]"
                        />
                      </label>
                    )}

                    <div className="space-y-2.5 border-t border-rule pt-3">
                      <label className="flex cursor-pointer items-center justify-between gap-2 font-serif text-[14.5px]">
                        <span className="text-ink-soft">
                          Match English covers &amp; canonical editions via Hardcover
                        </span>
                        <input
                          type="checkbox"
                          checked={enrichWithHardcover}
                          onChange={(e) =>
                            setEnrichWithHardcover(e.target.checked)
                          }
                          className="h-4 w-4 accent-[rgb(var(--claret))]"
                        />
                      </label>

                      {!hasCurrentYearChallenge &&
                        (parsedGr.counts.readByYear[currentYear] || 0) > 0 && (
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 font-serif text-[14.5px]">
                            <label className="flex cursor-pointer items-center gap-2 text-ink-soft">
                              <input
                                type="checkbox"
                                checked={createYearChallenge}
                                onChange={(e) =>
                                  setCreateYearChallenge(e.target.checked)
                                }
                                className="h-4 w-4 accent-[rgb(var(--claret))]"
                              />
                              <span>
                                Create {currentYear} Reading Challenge (
                                <strong className="font-medium text-ink">
                                  {parsedGr.counts.readByYear[currentYear]}
                                </strong>{' '}
                                already read in {currentYear})
                              </span>
                            </label>
                            {createYearChallenge && (
                              <div className="flex items-center gap-1.5 font-sans text-xs">
                                <span className="text-ink-muted">Goal:</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={500}
                                  value={challengeGoalInput}
                                  onChange={(e) =>
                                    setChallengeGoalInput(
                                      Math.max(1, Number(e.target.value))
                                    )
                                  }
                                  className="field field-sm w-16 text-center"
                                />
                              </div>
                            )}
                          </div>
                        )}
                    </div>
                  </div>

                  {/* Follow Authors Selector */}
                  <div className="panel space-y-3 p-4 sm:p-5">
                    <div>
                      <h3 className="caps text-ink-muted">
                        2. Follow Authors for Upcoming Releases ({selectedGrAuthors.size} selected)
                      </h3>
                      <p className="mt-1 font-serif text-[14px] italic text-ink-muted">
                        Selected authors will have their forthcoming English releases tracked automatically.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { key: '2plus', label: '2+ books' },
                        { key: '3plus', label: '3+ books' },
                        { key: 'rated4', label: 'Rated 4–5★' },
                        { key: 'all', label: 'Select all' },
                        { key: 'none', label: 'None (books only)' },
                      ].map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() =>
                            selectGrAuthorsPreset(p.key as '2plus' | '3plus' | 'rated4' | 'all' | 'none')
                          }
                          className="btn btn-outline btn-sm"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <div className="relative">
                      <Search strokeWidth={1.5} className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
                      <input
                        type="text"
                        value={grAuthorSearch}
                        onChange={(e) => setGrAuthorSearch(e.target.value)}
                        placeholder="Filter authors from your CSV…"
                        className="field field-sm pl-8"
                      />
                    </div>

                    <div className="max-h-48 divide-y divide-rule overflow-y-auto border border-rule bg-paper">
                      {filteredGrAuthors.map((author) => {
                        const alreadyFollowing = existingAuthorNormSet.has(
                          author.key
                        );
                        const checked =
                          alreadyFollowing || selectedGrAuthors.has(author.key);

                        return (
                          <label
                            key={author.key}
                            className={`flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs transition-colors ${
                              alreadyFollowing
                                ? 'cursor-default opacity-60'
                                : 'cursor-pointer hover:bg-paper-raised'
                            }`}
                          >
                            <div className="min-w-0">
                              <span className="font-serif text-[15px] font-medium text-ink">
                                {author.name}
                              </span>
                              <span className="ml-2 font-sans text-[11px] text-ink-muted">
                                {author.totalBooks}{' '}
                                {author.totalBooks === 1 ? 'book' : 'books'}
                                {author.avgRating ? (
                                  <span className="ml-1.5 inline-flex items-center gap-0.5 text-claret">
                                    <Star strokeWidth={1.25} className="h-2.5 w-2.5 fill-current" />
                                    {author.avgRating}
                                  </span>
                                ) : null}
                              </span>
                              <p className="truncate font-serif text-[13px] italic text-ink-muted">
                                e.g. {author.sampleTitles[0]}
                              </p>
                            </div>

                            {alreadyFollowing ? (
                              <span className="tag tag-moss shrink-0">
                                <Check strokeWidth={1.5} className="h-3 w-3" />
                                Following
                              </span>
                            ) : (
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setSelectedGrAuthors((prev) => {
                                    const copy = new Set(prev);
                                    if (copy.has(author.key)) {
                                      copy.delete(author.key);
                                    } else {
                                      copy.add(author.key);
                                    }
                                    return copy;
                                  });
                                }}
                                className="h-4 w-4 shrink-0 accent-[rgb(var(--claret))]"
                              />
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MODE 2: BATCH AUTHORS */}
          {!isRunning && !completedSummary && mode === 'authors' && (
            <div className="space-y-4">
              <div>
                <label className="field-label">
                  Paste Author Names · one per line or comma-separated
                </label>
                <textarea
                  rows={8}
                  value={authorsText}
                  onChange={(e) => setAuthorsText(e.target.value)}
                  placeholder={`Brandon Sanderson\nEmily Henry\nR.F. Kuang\nStephen King\nAndy Weir`}
                  className="field"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 font-serif text-[14.5px] italic text-ink-muted">
                <span>
                  Detected <strong className="font-medium not-italic text-ink">{newBatchAuthorLines.length}</strong> new{' '}
                  {newBatchAuthorLines.length === 1 ? 'author' : 'authors'} to follow
                  {parsedAuthorLines.length > newBatchAuthorLines.length &&
                    ` (${
                      parsedAuthorLines.length - newBatchAuthorLines.length
                    } already followed)`}
                </span>
                <span>Syncs forthcoming &amp; published English editions</span>
              </div>
            </div>
          )}

          {/* MODE 3: BATCH BOOKS */}
          {!isRunning && !completedSummary && mode === 'books' && (
            <div className="space-y-4">
              <div>
                <label className="field-label">
                  Paste Books · &ldquo;Title – Author&rdquo;, &ldquo;Title by Author&rdquo;, Title, or ISBN
                </label>
                <textarea
                  rows={7}
                  value={booksText}
                  onChange={(e) => setBooksText(e.target.value)}
                  placeholder={`Katabasis - R.F. Kuang\nProject Hail Mary by Andy Weir\n9781250318541\nHorneater - Brandon Sanderson`}
                  className="field"
                />
                <p className="mt-1.5 font-serif text-[14px] italic text-ink-muted">
                  Detected <strong className="font-medium not-italic text-ink">{parsedBookLines.length}</strong>{' '}
                  {parsedBookLines.length === 1 ? 'book' : 'books'} · looks up covers &amp; publication dates without following the authors.
                </p>
              </div>

              <div className="space-y-2">
                <label className="field-label">
                  Where should these books be placed?
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    {
                      key: 'oneoff',
                      label: 'One-off releases',
                      sub: 'Sort into Upcoming / Released',
                    },
                    {
                      key: 'todo',
                      label: 'To read',
                      sub: 'Queue on your reading list',
                    },
                    {
                      key: 'read',
                      label: 'Already read',
                      sub: 'Add to your read ledger',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() =>
                        setBatchBookDestination(
                          opt.key as 'oneoff' | 'todo' | 'read'
                        )
                      }
                      className={`border p-3 text-left transition-colors ${
                        batchBookDestination === opt.key
                          ? 'border-claret bg-claret-wash text-claret'
                          : 'border-rule bg-paper-raised text-ink-soft hover:border-ink hover:text-ink'
                      }`}
                    >
                      <span className="block font-sans text-xs font-medium">{opt.label}</span>
                      <span className="mt-0.5 block font-serif text-[13px] italic opacity-80">
                        {opt.sub}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {batchBookDestination === 'read' && (
                <div className="panel flex flex-wrap items-center justify-between gap-3 p-3.5">
                  <label className="flex cursor-pointer items-center gap-2 font-serif text-[14.5px] text-ink">
                    <input
                      type="checkbox"
                      checked={batchReadHasDate}
                      onChange={(e) => setBatchReadHasDate(e.target.checked)}
                      className="h-4 w-4 accent-[rgb(var(--claret))]"
                    />
                    <span>
                      Assign a finish date (counts toward Reading Challenge)
                    </span>
                  </label>
                  {batchReadHasDate && (
                    <input
                      type="date"
                      value={batchReadDate}
                      onChange={(e) => setBatchReadDate(e.target.value)}
                      className="field field-sm w-40"
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {!isRunning && !completedSummary && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-rule px-6 py-4 sm:px-8">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-ghost"
            >
              Cancel
            </button>

            {mode === 'goodreads' && (
              <button
                type="button"
                disabled={
                  !parsedGr ||
                  (!includeReadShelf &&
                    !includeToReadShelf &&
                    !includeOtherShelves &&
                    selectedGrAuthors.size === 0)
                }
                onClick={runGoodreadsImport}
                className="btn btn-primary"
              >
                <BookOpen strokeWidth={1.5} className="h-4 w-4" />
                Import Goodreads library
              </button>
            )}

            {mode === 'authors' && (
              <button
                type="button"
                disabled={newBatchAuthorLines.length === 0}
                onClick={runBatchAuthorsImport}
                className="btn btn-primary"
              >
                <Users strokeWidth={1.5} className="h-4 w-4" />
                Follow {newBatchAuthorLines.length || ''}{' '}
                {newBatchAuthorLines.length === 1 ? 'author' : 'authors'}
              </button>
            )}

            {mode === 'books' && (
              <button
                type="button"
                disabled={parsedBookLines.length === 0}
                onClick={runBatchBooksImport}
                className="btn btn-primary"
              >
                <ListPlus strokeWidth={1.5} className="h-4 w-4" />
                Import {parsedBookLines.length || ''}{' '}
                {parsedBookLines.length === 1 ? 'book' : 'books'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
