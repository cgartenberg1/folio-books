'use client';

import React, { useMemo, useRef, useState } from 'react';
import { getDayOfYear, getDaysInYear, parseISO } from 'date-fns';
import { BookOpen, Check, PenLine, Plus, Search, Upload, X } from 'lucide-react';
import { BookCard } from '@/components/BookCard';
import { BookCover, BookSpine } from '@/components/BookCover';
import {
  countWord,
  EmptyState,
  LedgerSection,
  PageHeader,
  plural,
  SectionHeading,
  Tabline,
} from '@/components/ui';
import { classifyReleaseTiming } from '@/lib/dates';
import { canOpenVellumWebUrl } from '@/lib/vellumBridge';
import { BookItem, FollowedAuthor, ReadingChallenge } from '@/types/books';

interface ReadingTabProps {
  books: BookItem[];
  authors: FollowedAuthor[];
  challenges: ReadingChallenge[];
  todayStr: string;
  vellumUrl?: string;
  onToggleTodo: (book: BookItem) => void;
  onToggleRead: (book: BookItem) => void;
  onOpenReadDetails: (book: BookItem) => void;
  onEditBook: (book: BookItem) => void;
  onRemoveOrHideBook?: (book: BookItem) => void;
  onSelectAuthor?: (authorId: string) => void;
  onOpenChallengeModal: (year: number, existing?: ReadingChallenge) => void;
  onDeleteChallenge: (id: string) => void;
  onAddManualBook: () => void;
  onOpenGoodreadsImport: () => void;
}

type TodoScope = 'all' | 'available' | 'upcoming' | 'oneoff';
type TodoSort = 'added_desc' | 'release_asc' | 'release_desc' | 'title_asc' | 'author_asc' | 'pages_asc';

type ReadScope = 'all' | 'undated' | 'notes' | 'unrated';
type ReadRatingFilter = 'all' | '5' | '4plus' | '3plus' | 'rated' | 'unrated';
type ReadSort =
  | 'finished_desc'
  | 'finished_asc'
  | 'rating_desc'
  | 'rating_asc'
  | 'pub_desc'
  | 'pub_asc'
  | 'title_asc'
  | 'author_asc'
  | 'updated_desc';

const MAX_SPINES = 300;
const PAGE_STEP = 60;

function normalizePubDateSortable(book: BookItem, fallback: string): string {
  if (!book.releaseDate || book.datePrecision === 'unknown') return fallback;
  if (book.releaseDate.length === 4) return `${book.releaseDate}-06-15`;
  if (book.releaseDate.length === 7) return `${book.releaseDate}-15`;
  return book.releaseDate;
}

function stripLeadingSortArticle(title: string): string {
  return (title || '')
    .trim()
    .replace(/^(?:the|a|an)\s+/i, '')
    .toLowerCase();
}

function authorSurnameFirstKey(name: string): string {
  const parts = (name || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  const last = parts[parts.length - 1];
  return `${last}, ${parts.slice(0, -1).join(' ')}`;
}

function matchesReadingSearch(book: BookItem, queryLower: string): boolean {
  if (!queryLower) return true;
  if (book.title.toLowerCase().includes(queryLower)) return true;
  if (book.authorName.toLowerCase().includes(queryLower)) return true;
  if (book.notes && book.notes.toLowerCase().includes(queryLower)) return true;
  if (book.finishedAt && book.finishedAt.includes(queryLower)) return true;
  if (book.releaseDate && book.releaseDate.includes(queryLower)) return true;
  return false;
}

export function ReadingTab({
  books,
  authors,
  challenges,
  todayStr,
  vellumUrl = 'http://localhost:3030',
  onToggleTodo,
  onToggleRead,
  onOpenReadDetails,
  onEditBook,
  onRemoveOrHideBook,
  onSelectAuthor,
  onOpenChallengeModal,
  onDeleteChallenge,
  onAddManualBook,
  onOpenGoodreadsImport,
}: ReadingTabProps) {
  const currentYear = Number(todayStr.slice(0, 4));
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [listMode, setListMode] = useState<'todo' | 'read'>('todo');
  const ledgerRef = useRef<HTMLElement | null>(null);

  // Shared search + list-specific filter/sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [todoScope, setTodoScope] = useState<TodoScope>('all');
  const [todoSort, setTodoSort] = useState<TodoSort>('added_desc');

  const [readScope, setReadScope] = useState<ReadScope>('all');
  const [readYearFilter, setReadYearFilter] = useState<string>('all');
  const [readRatingFilter, setReadRatingFilter] = useState<ReadRatingFilter>('all');
  const [readSort, setReadSort] = useState<ReadSort>('finished_desc');
  const [visibleLimit, setVisibleLimit] = useState<number>(PAGE_STEP);

  const followedIds = useMemo(() => new Set(authors.map((a) => a.id)), [authors]);
  const queryLower = searchQuery.trim().toLowerCase();

  const availableYears = useMemo(() => {
    const years = new Set<number>([currentYear]);
    for (const c of challenges) years.add(c.year);
    for (const b of books) {
      if (b.readingStatus === 'read' && b.finishedAt && b.finishedAt.length >= 4) {
        const y = Number(b.finishedAt.slice(0, 4));
        if (!Number.isNaN(y) && y >= 1950) years.add(y);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [challenges, books, currentYear]);

  const readFinishYears = useMemo(() => {
    const years = new Set<string>();
    for (const b of books) {
      if (b.readingStatus === 'read' && b.finishedAt && b.finishedAt.length >= 4) {
        years.add(b.finishedAt.slice(0, 4));
      }
    }
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [books]);

  const activeChallenge = useMemo(
    () => challenges.find((c) => c.year === selectedYear),
    [challenges, selectedYear]
  );

  const booksReadInSelectedYear = useMemo(() => {
    const prefix = `${selectedYear}-`;
    return books
      .filter(
        (b) =>
          b.readingStatus === 'read' &&
          (b.finishedAt?.startsWith(prefix) || b.finishedAt === String(selectedYear))
      )
      .sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  }, [books, selectedYear]);

  const rawTodoBooks = useMemo(
    () => books.filter((b) => b.readingStatus === 'todo'),
    [books]
  );

  const rawReadBooks = useMemo(
    () => books.filter((b) => b.readingStatus === 'read'),
    [books]
  );

  const undatedReadCount = useMemo(
    () => rawReadBooks.filter((b) => !b.finishedAt).length,
    [rawReadBooks]
  );

  const searchMatchingTodoCount = useMemo(
    () =>
      queryLower
        ? rawTodoBooks.filter((b) => matchesReadingSearch(b, queryLower)).length
        : rawTodoBooks.length,
    [rawTodoBooks, queryLower]
  );

  const searchMatchingReadCount = useMemo(
    () =>
      queryLower
        ? rawReadBooks.filter((b) => matchesReadingSearch(b, queryLower)).length
        : rawReadBooks.length,
    [rawReadBooks, queryLower]
  );

  // Filtered & sorted To-Read list
  const filteredTodoBooks = useMemo(() => {
    const filtered = rawTodoBooks.filter((b) => {
      if (!matchesReadingSearch(b, queryLower)) return false;
      const timing = classifyReleaseTiming(b, todayStr);
      if (todoScope === 'available' && timing !== 'released') return false;
      if (todoScope === 'upcoming' && timing !== 'upcoming') return false;
      if (
        todoScope === 'oneoff' &&
        (!b.isOneOff || (b.authorId && followedIds.has(b.authorId)))
      ) {
        return false;
      }
      return true;
    });

    const copy = [...filtered];
    copy.sort((a, b) => {
      if (todoSort === 'title_asc') {
        return stripLeadingSortArticle(a.title).localeCompare(
          stripLeadingSortArticle(b.title)
        );
      }
      if (todoSort === 'author_asc') {
        const cmp = authorSurnameFirstKey(a.authorName).localeCompare(
          authorSurnameFirstKey(b.authorName)
        );
        if (cmp !== 0) return cmp;
        return stripLeadingSortArticle(a.title).localeCompare(
          stripLeadingSortArticle(b.title)
        );
      }
      if (todoSort === 'release_asc') {
        return normalizePubDateSortable(a, '9999-99-99').localeCompare(
          normalizePubDateSortable(b, '9999-99-99')
        );
      }
      if (todoSort === 'release_desc') {
        return normalizePubDateSortable(b, '0000-00-00').localeCompare(
          normalizePubDateSortable(a, '0000-00-00')
        );
      }
      if (todoSort === 'pages_asc') {
        const pa = a.pageCount || 99999;
        const pb = b.pageCount || 99999;
        if (pa !== pb) return pa - pb;
      }
      return (b.addedToTodoAt || b.updatedAt || '').localeCompare(
        a.addedToTodoAt || a.updatedAt || ''
      );
    });

    return copy;
  }, [rawTodoBooks, queryLower, todayStr, todoScope, followedIds, todoSort]);

  const todoBooksReleased = useMemo(
    () =>
      filteredTodoBooks.filter(
        (b) => classifyReleaseTiming(b, todayStr) === 'released'
      ),
    [filteredTodoBooks, todayStr]
  );

  const todoBooksUpcoming = useMemo(() => {
    const items = filteredTodoBooks.filter(
      (b) => classifyReleaseTiming(b, todayStr) === 'upcoming'
    );
    if (todoSort === 'added_desc') {
      return [...items].sort((a, b) =>
        normalizePubDateSortable(a, '9999-99-99').localeCompare(
          normalizePubDateSortable(b, '9999-99-99')
        )
      );
    }
    return items;
  }, [filteredTodoBooks, todayStr, todoSort]);

  // Filtered & sorted Read log
  const filteredReadBooks = useMemo(() => {
    const filtered = rawReadBooks.filter((b) => {
      if (!matchesReadingSearch(b, queryLower)) return false;

      if (readScope === 'undated' && b.finishedAt) return false;
      if (readScope === 'notes' && !b.notes) return false;
      if (readScope === 'unrated' && b.rating && b.rating > 0) return false;

      if (readYearFilter === 'undated') {
        if (b.finishedAt) return false;
      } else if (readYearFilter !== 'all') {
        if (!b.finishedAt || b.finishedAt.slice(0, 4) !== readYearFilter) {
          return false;
        }
      }

      if (readRatingFilter === '5' && b.rating !== 5) return false;
      if (readRatingFilter === '4plus' && (b.rating || 0) < 4) return false;
      if (readRatingFilter === '3plus' && (b.rating || 0) < 3) return false;
      if (readRatingFilter === 'rated' && (!b.rating || b.rating <= 0)) return false;
      if (readRatingFilter === 'unrated' && b.rating && b.rating > 0) return false;

      return true;
    });

    const copy = [...filtered];
    copy.sort((a, b) => {
      if (readSort === 'finished_asc') {
        const da = a.finishedAt || '9999-99-99';
        const db = b.finishedAt || '9999-99-99';
        if (da !== db) return da.localeCompare(db);
        return a.updatedAt.localeCompare(b.updatedAt);
      }
      if (readSort === 'rating_desc') {
        const ra = a.rating || 0;
        const rb = b.rating || 0;
        if (ra !== rb) return rb - ra;
        return (b.finishedAt || '0000-00-00').localeCompare(
          a.finishedAt || '0000-00-00'
        );
      }
      if (readSort === 'rating_asc') {
        const ra = a.rating || 99;
        const rb = b.rating || 99;
        if (ra !== rb) return ra - rb;
        return (b.finishedAt || '0000-00-00').localeCompare(
          a.finishedAt || '0000-00-00'
        );
      }
      if (readSort === 'pub_desc') {
        return normalizePubDateSortable(b, '0000-00-00').localeCompare(
          normalizePubDateSortable(a, '0000-00-00')
        );
      }
      if (readSort === 'pub_asc') {
        return normalizePubDateSortable(a, '9999-99-99').localeCompare(
          normalizePubDateSortable(b, '9999-99-99')
        );
      }
      if (readSort === 'title_asc') {
        return stripLeadingSortArticle(a.title).localeCompare(
          stripLeadingSortArticle(b.title)
        );
      }
      if (readSort === 'author_asc') {
        const cmp = authorSurnameFirstKey(a.authorName).localeCompare(
          authorSurnameFirstKey(b.authorName)
        );
        if (cmp !== 0) return cmp;
        return stripLeadingSortArticle(a.title).localeCompare(
          stripLeadingSortArticle(b.title)
        );
      }
      if (readSort === 'updated_desc') {
        return b.updatedAt.localeCompare(a.updatedAt);
      }

      // Default: finished_desc
      const dateA = a.finishedAt || '0000-00-00';
      const dateB = b.finishedAt || '0000-00-00';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    return copy;
  }, [
    rawReadBooks,
    queryLower,
    readScope,
    readYearFilter,
    readRatingFilter,
    readSort,
  ]);

  const displayedReadBooks = useMemo(
    () => filteredReadBooks.slice(0, visibleLimit),
    [filteredReadBooks, visibleLimit]
  );

  const isGroupedByFinishYear =
    readSort === 'finished_desc' || readSort === 'finished_asc';

  const readByYear = useMemo(() => {
    if (!isGroupedByFinishYear) return [];
    const groups: Array<{ year: string; books: BookItem[] }> = [];
    for (const book of displayedReadBooks) {
      const year =
        book.finishedAt && book.finishedAt.length >= 4
          ? book.finishedAt.slice(0, 4)
          : 'Undated';
      const last = groups[groups.length - 1];
      if (last && last.year === year) last.books.push(book);
      else groups.push({ year, books: [book] });
    }
    return groups;
  }, [displayedReadBooks, isGroupedByFinishYear]);

  const completed = booksReadInSelectedYear.length;

  const paceSummary = useMemo(() => {
    if (!activeChallenge) return null;
    const goal = activeChallenge.goalCount;
    if (completed >= goal) {
      return `The goal is met${
        completed > goal ? `, with ${countWord(completed - goal)} to spare` : ''
      }.`;
    }
    if (selectedYear === currentYear) {
      const today = parseISO(todayStr);
      const dayOfYear = getDayOfYear(today);
      const totalDays = getDaysInYear(today);
      const expectedByNow = (dayOfYear / totalDays) * goal;
      const diff = Math.round(completed - expectedByNow);
      const remaining = goal - completed;
      if (diff >= 1) {
        return `${countWord(diff, true)} ${plural(
          diff,
          'book'
        )} ahead of pace, with ${countWord(remaining)} still to go.`;
      }
      if (diff === 0) {
        return `Precisely on pace, with ${countWord(remaining)} still to go.`;
      }
      const behind = Math.abs(diff);
      return `${countWord(behind, true)} ${plural(
        behind,
        'book'
      )} behind pace, with ${countWord(remaining)} still to go.`;
    }
    return `The year closed ${countWord(goal - completed)} short of the mark.`;
  }, [activeChallenge, completed, selectedYear, currentYear, todayStr]);

  const shelfTotal = activeChallenge
    ? Math.min(MAX_SPINES, Math.max(activeChallenge.goalCount, completed))
    : 0;

  const vellumActiveBooks = useMemo(
    () =>
      books
        .filter(
          (b) =>
            b.readingStatus !== 'read' &&
            typeof b.vellumProgress === 'number' &&
            b.vellumProgress >= 0.005 &&
            b.vellumProgress < 0.995 &&
            matchesReadingSearch(b, queryLower)
        )
        .sort((a, b) =>
          (b.vellumLastReadAt || b.updatedAt).localeCompare(
            a.vellumLastReadAt || a.updatedAt
          )
        ),
    [books, queryLower]
  );

  const cleanVellumUrl = vellumUrl.replace(/\/+$/, '');

  const hasActiveTodoFilters =
    Boolean(queryLower) || todoScope !== 'all' || todoSort !== 'added_desc';
  const hasActiveReadFilters =
    Boolean(queryLower) ||
    readScope !== 'all' ||
    readYearFilter !== 'all' ||
    readRatingFilter !== 'all' ||
    readSort !== 'finished_desc';

  const resetAllFilters = () => {
    setSearchQuery('');
    setTodoScope('all');
    setTodoSort('added_desc');
    setReadScope('all');
    setReadYearFilter('all');
    setReadRatingFilter('all');
    setReadSort('finished_desc');
    setVisibleLimit(PAGE_STEP);
  };

  const jumpToSelectedChallengeYearLog = () => {
    setListMode('read');
    setReadScope('all');
    setReadYearFilter(String(selectedYear));
    setReadSort('finished_desc');
    setVisibleLimit(PAGE_STEP);
    setTimeout(() => {
      ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 30);
  };

  const availableNowCount = useMemo(
    () =>
      rawTodoBooks.filter(
        (b) => classifyReleaseTiming(b, todayStr) === 'released'
      ).length,
    [rawTodoBooks, todayStr]
  );

  const forthcomingTodoCount = rawTodoBooks.length - availableNowCount;

  return (
    <div className="space-y-10">
      <PageHeader
        numeral="III"
        kicker="The Reading Life"
        title="Reading"
        dek="What you mean to read, what you have read, and how the year is going."
        actions={
          <>
            <button
              type="button"
              onClick={onOpenGoodreadsImport}
              className="btn btn-outline btn-sm"
            >
              <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
              Import
            </button>
            <button
              type="button"
              onClick={onAddManualBook}
              className="btn btn-primary btn-sm"
            >
              <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
              Log a book
            </button>
          </>
        }
      />

      {/* The Year's Challenge */}
      <section className="animate-fade-up">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule">
          <h2 className="caps pb-2 text-ink-soft">The {selectedYear} Challenge</h2>
          {availableYears.length > 1 && (
            <Tabline
              value={String(selectedYear)}
              onChange={(y) => setSelectedYear(Number(y))}
              options={availableYears.map((y) => ({
                key: String(y),
                label: String(y),
              }))}
            />
          )}
        </div>

        {activeChallenge ? (
          <div className="pt-7">
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-display text-[48px] font-medium leading-[0.95] text-ink sm:text-[64px]">
                  {countWord(completed, true)}
                  <span className="italic text-ink-muted">
                    {' '}
                    of {countWord(activeChallenge.goalCount)}
                  </span>
                </p>
                <p className="mt-3 font-serif text-[17px] italic text-ink-soft">
                  {paceSummary}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    onOpenChallengeModal(selectedYear, activeChallenge)
                  }
                  className="btn btn-ghost btn-sm"
                >
                  Revise goal
                </button>
                <span className="text-ink-faint">·</span>
                <button
                  type="button"
                  onClick={() => onDeleteChallenge(activeChallenge.id)}
                  className="btn btn-danger btn-sm"
                >
                  Remove
                </button>
                <span className="text-ink-faint">·</span>
                <button
                  type="button"
                  onClick={() => onOpenChallengeModal(selectedYear + 1)}
                  className="btn btn-ghost btn-sm"
                >
                  Plan {selectedYear + 1}
                </button>
              </div>
            </div>

            {/* The shelf */}
            <div className="mt-8">
              <div
                className={`flex h-24 items-end px-0.5 sm:h-28 ${
                  shelfTotal > 60 ? 'gap-px' : 'gap-[3px]'
                }`}
              >
                {Array.from({ length: shelfTotal }).map((_, i) => {
                  const book = booksReadInSelectedYear[i];
                  return book ? (
                    <BookSpine
                      key={book.id}
                      seed={`${book.title}:${book.authorName}`}
                      title={`${book.title} — ${book.authorName}`}
                      filled
                      onClick={() => onOpenReadDetails(book)}
                    />
                  ) : (
                    <BookSpine
                      key={`empty-${i}`}
                      seed={`slot-${i}`}
                      filled={false}
                    />
                  );
                })}
              </div>
              <div className="h-[5px] border-t-2 border-ink/80 bg-gradient-to-b from-ink/10 to-transparent" />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="caps-sm text-ink-faint">
                  Each spine, a book finished in {selectedYear} (click any spine
                  to edit its log)
                </span>
                <div className="flex items-center gap-3">
                  {completed > 0 && (
                    <button
                      type="button"
                      onClick={jumpToSelectedChallengeYearLog}
                      className="font-serif text-[13.5px] italic text-claret underline-offset-4 hover:underline"
                    >
                      Inspect {selectedYear} read log ({completed}) ↓
                    </button>
                  )}
                  <span className="caps-sm text-ink-faint nums-lining">
                    {Math.round(
                      (completed / Math.max(1, activeChallenge.goalCount)) * 100
                    )}
                    %
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5 py-8 md:flex-row md:items-center md:justify-between">
            <div className="max-w-lg">
              <p className="font-display text-[34px] font-medium italic leading-tight text-ink">
                How many books will {selectedYear} hold?
              </p>
              <p className="mt-2 font-serif text-[16.5px] leading-relaxed text-ink-muted">
                Set yourself a number, and every book you mark as read fills a
                spine on the shelf.
                {completed > 0 &&
                  ` ${countWord(completed, true)} ${plural(
                    completed,
                    'book'
                  )} already finished this year will count.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {completed > 0 && (
                <button
                  type="button"
                  onClick={jumpToSelectedChallengeYearLog}
                  className="btn btn-outline"
                >
                  View {selectedYear} log ({completed})
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpenChallengeModal(selectedYear)}
                className="btn btn-primary"
              >
                Begin the {selectedYear} challenge
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Currently on the Lectern (Live Sync from Vellum) */}
      {vellumActiveBooks.length > 0 && (
        <section className="animate-fade-up space-y-4">
          <SectionHeading
            title="On the lectern · reading in Vellum"
            meta={`${countWord(vellumActiveBooks.length, true)} ${plural(
              vellumActiveBooks.length,
              'volume'
            )} open`}
          />

          <div className="grid grid-cols-1 gap-x-10 gap-y-2 lg:grid-cols-2">
            {vellumActiveBooks.map((book) => {
              const pct = Math.round((book.vellumProgress || 0) * 100);
              return (
                <article
                  key={`lectern-${book.id}`}
                  className="flex gap-4 border-b border-rule py-4 sm:gap-5"
                >
                  <BookCover
                    title={book.title}
                    authorName={book.authorName}
                    coverUrl={book.coverUrl}
                    onClick={() => onEditBook(book)}
                    actionTitle="Edit details or change cover artwork"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="book-title text-[19px] line-clamp-2">
                        {book.title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => onEditBook(book)}
                        title="Edit details"
                        className="icon-btn -mr-1.5 -mt-1 h-7 w-7 shrink-0 opacity-70 hover:opacity-100"
                      >
                        <PenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="byline mt-0.5 text-[15px] leading-snug">
                      <span className="text-ink-muted">by </span>
                      <span>{book.authorName}</span>
                    </p>

                    <div className="mt-3 max-w-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-serif text-[13.5px] italic text-ink-muted">
                          {book.vellumChapter || 'In progress in Vellum'}
                        </span>
                        <span className="caps-sm shrink-0 text-claret nums-lining">
                          {pct}%
                        </span>
                      </div>
                      <div className="mt-1.5 h-[2px] w-full bg-rule">
                        <div
                          className="h-full bg-claret transition-all duration-500"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>

                    <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-3">
                      {canOpenVellumWebUrl(cleanVellumUrl) && (
                        <a
                          href={`${cleanVellumUrl}/?book=${encodeURIComponent(
                            book.vellumBookId || book.title
                          )}`}
                          target="_blank"
                          rel="noreferrer"
                          data-active="true"
                          className="entry-action"
                        >
                          <BookOpen strokeWidth={1.5} className="h-3.5 w-3.5" />
                          Continue in Vellum
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => onToggleRead(book)}
                        className="entry-action"
                      >
                        <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
                        Mark as read
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Reading Ledger: Search, Filters, Sort & Entries */}
      <section ref={ledgerRef} className="space-y-5 scroll-mt-20">
        {/* Primary Tabline + Search Bar */}
        <div className="flex flex-col gap-4 border-b border-rule sm:flex-row sm:items-end sm:justify-between">
          <Tabline
            value={listMode}
            onChange={(next) => {
              setListMode(next);
              setVisibleLimit(PAGE_STEP);
            }}
            options={[
              {
                key: 'todo',
                label: 'To read',
                count: searchMatchingTodoCount,
              },
              {
                key: 'read',
                label: 'Read',
                count: searchMatchingReadCount,
              },
            ]}
          />

          <div className="relative mb-2 w-full sm:w-72">
            <Search
              strokeWidth={1.5}
              className="pointer-events-none absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleLimit(PAGE_STEP);
              }}
              placeholder="Search title, author, year, or notes…"
              className="w-full border-0 border-b border-transparent bg-transparent py-1 pl-6 pr-6 font-serif text-[15px] text-ink placeholder:italic placeholder:text-ink-faint focus:border-ink focus:outline-none focus:ring-0"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setVisibleLimit(PAGE_STEP);
                }}
                aria-label="Clear search"
                className="absolute right-0 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              >
                <X strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Mode-specific Filter & Sort Controls */}
        {listMode === 'todo' && rawTodoBooks.length > 0 && (
          <div className="flex flex-col gap-3 border-b border-rule/70 pb-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <Tabline
              value={todoScope}
              onChange={(next) => setTodoScope(next)}
              options={[
                { key: 'all', label: 'All', count: rawTodoBooks.length },
                {
                  key: 'available',
                  label: 'Available now',
                  count: availableNowCount,
                },
                {
                  key: 'upcoming',
                  label: 'Forthcoming',
                  count: forthcomingTodoCount,
                },
                { key: 'oneoff', label: 'Single titles' },
              ]}
            />

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 font-sans text-[12px] text-ink-muted">
                <span className="caps-sm text-ink-faint">Sort</span>
                <select
                  value={todoSort}
                  onChange={(e) => setTodoSort(e.target.value as TodoSort)}
                  className="border border-rule bg-paper-raised px-2.5 py-1 font-sans text-[12px] text-ink focus:border-ink focus:outline-none"
                >
                  <option value="added_desc">Recently added</option>
                  <option value="release_asc">Release date (soonest / oldest)</option>
                  <option value="release_desc">Release date (newest)</option>
                  <option value="title_asc">Title (A–Z)</option>
                  <option value="author_asc">Author (A–Z)</option>
                  <option value="pages_asc">Shortest first (pages)</option>
                </select>
              </label>

              {hasActiveTodoFilters && (
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="btn btn-ghost btn-sm text-claret"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        )}

        {listMode === 'read' && rawReadBooks.length > 0 && (
          <div className="space-y-3 border-b border-rule/70 pb-3.5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <Tabline
                value={readScope}
                onChange={(next) => {
                  setReadScope(next);
                  if (next === 'undated') {
                    setReadYearFilter('all');
                  }
                  setVisibleLimit(PAGE_STEP);
                }}
                options={[
                  { key: 'all', label: 'All read', count: rawReadBooks.length },
                  {
                    key: 'undated',
                    label: 'Missing date',
                    count: undatedReadCount,
                  },
                  { key: 'notes', label: 'With notes' },
                  { key: 'unrated', label: 'Unrated' },
                ]}
              />

              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex items-center gap-1.5 font-sans text-[12px] text-ink-muted">
                  <span className="caps-sm text-ink-faint">Year</span>
                  <select
                    value={readYearFilter}
                    onChange={(e) => {
                      const val = e.target.value;
                      setReadYearFilter(val);
                      if (val !== 'all' && readScope === 'undated') {
                        setReadScope('all');
                      }
                      setVisibleLimit(PAGE_STEP);
                    }}
                    className="border border-rule bg-paper-raised px-2 py-1 font-sans text-[12px] text-ink focus:border-ink focus:outline-none"
                  >
                    <option value="all">All years</option>
                    {readFinishYears.map((yr) => (
                      <option key={yr} value={yr}>
                        Read in {yr}
                      </option>
                    ))}
                    <option value="undated">No finish date</option>
                  </select>
                </label>

                <label className="flex items-center gap-1.5 font-sans text-[12px] text-ink-muted">
                  <span className="caps-sm text-ink-faint">Rating</span>
                  <select
                    value={readRatingFilter}
                    onChange={(e) => {
                      setReadRatingFilter(e.target.value as ReadRatingFilter);
                      setVisibleLimit(PAGE_STEP);
                    }}
                    className="border border-rule bg-paper-raised px-2 py-1 font-sans text-[12px] text-ink focus:border-ink focus:outline-none"
                  >
                    <option value="all">Any rating</option>
                    <option value="5">5 stars</option>
                    <option value="4plus">4+ stars</option>
                    <option value="3plus">3+ stars</option>
                    <option value="rated">Rated</option>
                    <option value="unrated">Unrated</option>
                  </select>
                </label>

                <label className="flex items-center gap-1.5 font-sans text-[12px] text-ink-muted">
                  <span className="caps-sm text-ink-faint">Sort</span>
                  <select
                    value={readSort}
                    onChange={(e) => {
                      setReadSort(e.target.value as ReadSort);
                      setVisibleLimit(PAGE_STEP);
                    }}
                    className="border border-rule bg-paper-raised px-2.5 py-1 font-sans text-[12px] text-ink focus:border-ink focus:outline-none"
                  >
                    <option value="finished_desc">Date finished (newest)</option>
                    <option value="finished_asc">Date finished (oldest)</option>
                    <option value="rating_desc">Highest rated</option>
                    <option value="rating_asc">Lowest rated</option>
                    <option value="pub_desc">Publication date (newest)</option>
                    <option value="pub_asc">Publication date (oldest)</option>
                    <option value="title_asc">Title (A–Z)</option>
                    <option value="author_asc">Author (A–Z)</option>
                    <option value="updated_desc">Recently edited</option>
                  </select>
                </label>

                {hasActiveReadFilters && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="btn btn-ghost btn-sm text-claret"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>

            {hasActiveReadFilters && (
              <p className="font-serif text-[14px] italic text-ink-muted">
                Showing {countWord(filteredReadBooks.length)}{' '}
                {plural(filteredReadBooks.length, 'book')} of{' '}
                {rawReadBooks.length.toLocaleString()} read — click any finish
                date or “Edit date &amp; log” to update dates, ratings, or notes.
              </p>
            )}
          </div>
        )}

        {/* Active List Content */}
        {listMode === 'todo' ? (
          rawTodoBooks.length === 0 ? (
            <EmptyState
              title="The reading list is empty."
              body="Choose “Add to list” on any book in Released or Search, and it will wait for you here."
            />
          ) : filteredTodoBooks.length === 0 ? (
            <EmptyState
              title="Nothing on your To-Read list matches."
              body="Try clearing your search or switching filters."
            >
              {queryLower && searchMatchingReadCount > 0 && (
                <button
                  type="button"
                  onClick={() => setListMode('read')}
                  className="btn btn-primary"
                >
                  View {searchMatchingReadCount}{' '}
                  {plural(searchMatchingReadCount, 'match', 'matches')} in Read
                </button>
              )}
              <button
                type="button"
                onClick={resetAllFilters}
                className="btn btn-outline"
              >
                Clear filters
              </button>
            </EmptyState>
          ) : todoScope === 'all' && todoSort === 'added_desc' ? (
            <div className="space-y-10">
              {todoBooksReleased.length > 0 && (
                <div>
                  <SectionHeading
                    title="On the shelf, ready to read"
                    meta={`${countWord(todoBooksReleased.length, true)} ${plural(
                      todoBooksReleased.length,
                      'book'
                    )}`}
                  />
                  <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
                    {todoBooksReleased.map((book) => (
                      <BookCard
                        key={book.id}
                        book={book}
                        todayStr={todayStr}
                        vellumUrl={cleanVellumUrl}
                        isAuthorFollowed={Boolean(
                          book.authorId && followedIds.has(book.authorId)
                        )}
                        onToggleTodo={onToggleTodo}
                        onToggleRead={onToggleRead}
                        onOpenReadDetails={onOpenReadDetails}
                        onEditBook={onEditBook}
                        onRemoveOrHideBook={onRemoveOrHideBook}
                        onSelectAuthor={onSelectAuthor}
                      />
                    ))}
                  </div>
                </div>
              )}

              {todoBooksUpcoming.length > 0 && (
                <div>
                  <SectionHeading
                    title="Awaiting publication"
                    meta={`${countWord(todoBooksUpcoming.length, true)} ${plural(
                      todoBooksUpcoming.length,
                      'book'
                    )}`}
                  />
                  <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
                    {todoBooksUpcoming.map((book) => (
                      <BookCard
                        key={book.id}
                        book={book}
                        todayStr={todayStr}
                        vellumUrl={cleanVellumUrl}
                        isAuthorFollowed={Boolean(
                          book.authorId && followedIds.has(book.authorId)
                        )}
                        onToggleTodo={onToggleTodo}
                        onToggleRead={onToggleRead}
                        onEditBook={onEditBook}
                        onRemoveOrHideBook={onRemoveOrHideBook}
                        onSelectAuthor={onSelectAuthor}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
              {filteredTodoBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  todayStr={todayStr}
                  vellumUrl={cleanVellumUrl}
                  isAuthorFollowed={Boolean(
                    book.authorId && followedIds.has(book.authorId)
                  )}
                  onToggleTodo={onToggleTodo}
                  onToggleRead={onToggleRead}
                  onOpenReadDetails={onOpenReadDetails}
                  onEditBook={onEditBook}
                  onRemoveOrHideBook={onRemoveOrHideBook}
                  onSelectAuthor={onSelectAuthor}
                />
              ))}
            </div>
          )
        ) : rawReadBooks.length === 0 ? (
          <EmptyState
            title="No books in the log yet."
            body="Mark a book as read from Released, your list, or Search. Each one keeps its date, a rating, and your notes."
          />
        ) : filteredReadBooks.length === 0 ? (
          <EmptyState
            title="No read books match those filters."
            body="Try another year, rating, or search term."
          >
            {queryLower && searchMatchingTodoCount > 0 && (
              <button
                type="button"
                onClick={() => setListMode('todo')}
                className="btn btn-primary"
              >
                View {searchMatchingTodoCount}{' '}
                {plural(searchMatchingTodoCount, 'match', 'matches')} in To read
              </button>
            )}
            <button
              type="button"
              onClick={resetAllFilters}
              className="btn btn-outline"
            >
              Reset filters
            </button>
          </EmptyState>
        ) : (
          <>
            {isGroupedByFinishYear ? (
              <div className="border-b border-rule">
                {readByYear.map((group) => (
                  <LedgerSection
                    key={group.year}
                    gutter={
                      <div className="flex items-baseline justify-between gap-3 md:block">
                        <p
                          className={`font-display font-medium leading-none text-ink nums-lining ${
                            group.year === 'Undated'
                              ? 'text-[28px] italic'
                              : 'text-[44px]'
                          }`}
                        >
                          {group.year}
                        </p>
                        <p className="font-serif text-[14px] italic text-ink-muted md:mt-2">
                          {countWord(group.books.length, true)}{' '}
                          {plural(group.books.length, 'book')} read
                        </p>
                      </div>
                    }
                  >
                    <div className="-mb-px grid grid-cols-1 gap-x-8 lg:grid-cols-2">
                      {group.books.map((book) => (
                        <BookCard
                          key={book.id}
                          book={book}
                          todayStr={todayStr}
                          vellumUrl={cleanVellumUrl}
                          isAuthorFollowed={Boolean(
                            book.authorId && followedIds.has(book.authorId)
                          )}
                          onToggleTodo={onToggleTodo}
                          onToggleRead={onToggleRead}
                          onOpenReadDetails={onOpenReadDetails}
                          onEditBook={onEditBook}
                          onRemoveOrHideBook={onRemoveOrHideBook}
                          onSelectAuthor={onSelectAuthor}
                        />
                      ))}
                    </div>
                  </LedgerSection>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-x-10 border-b border-rule lg:grid-cols-2">
                {displayedReadBooks.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    todayStr={todayStr}
                    vellumUrl={cleanVellumUrl}
                    isAuthorFollowed={Boolean(
                      book.authorId && followedIds.has(book.authorId)
                    )}
                    onToggleTodo={onToggleTodo}
                    onToggleRead={onToggleRead}
                    onOpenReadDetails={onOpenReadDetails}
                    onEditBook={onEditBook}
                    onRemoveOrHideBook={onRemoveOrHideBook}
                    onSelectAuthor={onSelectAuthor}
                  />
                ))}
              </div>
            )}

            {filteredReadBooks.length > visibleLimit && (
              <div className="flex flex-wrap items-center justify-center gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
                  className="btn btn-outline"
                >
                  Show {Math.min(PAGE_STEP, filteredReadBooks.length - visibleLimit)}{' '}
                  more ({filteredReadBooks.length - visibleLimit} remaining)
                </button>
                {filteredReadBooks.length - visibleLimit > PAGE_STEP && (
                  <button
                    type="button"
                    onClick={() => setVisibleLimit(filteredReadBooks.length)}
                    className="btn btn-ghost"
                  >
                    Show all {filteredReadBooks.length.toLocaleString()}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
