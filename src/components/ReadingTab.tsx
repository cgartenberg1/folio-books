'use client';

import React, { useMemo, useState } from 'react';
import { getDayOfYear, getDaysInYear, parseISO } from 'date-fns';
import { BookOpen, Check, Plus, Upload } from 'lucide-react';
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
  onOpenChallengeModal: (year: number, existing?: ReadingChallenge) => void;
  onDeleteChallenge: (id: string) => void;
  onAddManualBook: () => void;
  onOpenGoodreadsImport: () => void;
}

const MAX_SPINES = 300;

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
  onOpenChallengeModal,
  onDeleteChallenge,
  onAddManualBook,
  onOpenGoodreadsImport,
}: ReadingTabProps) {
  const currentYear = Number(todayStr.slice(0, 4));
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [listMode, setListMode] = useState<'todo' | 'read'>('todo');

  const followedIds = useMemo(() => new Set(authors.map((a) => a.id)), [authors]);

  const availableYears = useMemo(() => {
    const years = new Set<number>([currentYear]);
    for (const c of challenges) years.add(c.year);
    for (const b of books) {
      if (b.readingStatus === 'read' && b.finishedAt && b.finishedAt.length >= 4) {
        const y = Number(b.finishedAt.slice(0, 4));
        if (!Number.isNaN(y) && y >= 2000) years.add(y);
      }
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [challenges, books, currentYear]);

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

  const todoBooksReleased = useMemo(
    () =>
      books
        .filter(
          (b) => b.readingStatus === 'todo' && classifyReleaseTiming(b, todayStr) === 'released'
        )
        .sort((a, b) => (b.addedToTodoAt || '').localeCompare(a.addedToTodoAt || '')),
    [books, todayStr]
  );

  const todoBooksUpcoming = useMemo(
    () =>
      books
        .filter(
          (b) => b.readingStatus === 'todo' && classifyReleaseTiming(b, todayStr) === 'upcoming'
        )
        .sort((a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999')),
    [books, todayStr]
  );

  const allReadBooks = useMemo(
    () =>
      books
        .filter((b) => b.readingStatus === 'read')
        .sort((a, b) => {
          const dateA = a.finishedAt || '0000-00-00';
          const dateB = b.finishedAt || '0000-00-00';
          if (dateA !== dateB) return dateB.localeCompare(dateA);
          return b.updatedAt.localeCompare(a.updatedAt);
        }),
    [books]
  );

  const readByYear = useMemo(() => {
    const groups: Array<{ year: string; books: BookItem[] }> = [];
    for (const book of allReadBooks) {
      const year = book.finishedAt && book.finishedAt.length >= 4 ? book.finishedAt.slice(0, 4) : 'Undated';
      const last = groups[groups.length - 1];
      if (last && last.year === year) last.books.push(book);
      else groups.push({ year, books: [book] });
    }
    return groups;
  }, [allReadBooks]);

  const completed = booksReadInSelectedYear.length;

  const paceSummary = useMemo(() => {
    if (!activeChallenge) return null;
    const goal = activeChallenge.goalCount;
    if (completed >= goal) {
      return `The goal is met${completed > goal ? `, with ${countWord(completed - goal)} to spare` : ''}.`;
    }
    if (selectedYear === currentYear) {
      const today = parseISO(todayStr);
      const dayOfYear = getDayOfYear(today);
      const totalDays = getDaysInYear(today);
      const expectedByNow = (dayOfYear / totalDays) * goal;
      const diff = Math.round(completed - expectedByNow);
      const remaining = goal - completed;
      if (diff >= 1) {
        return `${countWord(diff, true)} ${plural(diff, 'book')} ahead of pace, with ${countWord(remaining)} still to go.`;
      }
      if (diff === 0) {
        return `Precisely on pace, with ${countWord(remaining)} still to go.`;
      }
      const behind = Math.abs(diff);
      return `${countWord(behind, true)} ${plural(behind, 'book')} behind pace, with ${countWord(remaining)} still to go.`;
    }
    return `The year closed ${countWord(goal - completed)} short of the mark.`;
  }, [activeChallenge, completed, selectedYear, currentYear, todayStr]);

  const shelfTotal = activeChallenge
    ? Math.min(MAX_SPINES, Math.max(activeChallenge.goalCount, completed))
    : 0;

  const todoTotal = todoBooksReleased.length + todoBooksUpcoming.length;

  const vellumActiveBooks = useMemo(
    () =>
      books
        .filter(
          (b) =>
            b.readingStatus !== 'read' &&
            typeof b.vellumProgress === 'number' &&
            b.vellumProgress >= 0.005 &&
            b.vellumProgress < 0.995
        )
        .sort((a, b) =>
          (b.vellumLastReadAt || b.updatedAt).localeCompare(
            a.vellumLastReadAt || a.updatedAt
          )
        ),
    [books]
  );

  const cleanVellumUrl = vellumUrl.replace(/\/+$/, '');

  return (
    <div className="space-y-10">
      <PageHeader
        numeral="III"
        kicker="The Reading Life"
        title="Reading"
        dek="What you mean to read, what you have read, and how the year is going."
        actions={
          <>
            <button type="button" onClick={onOpenGoodreadsImport} className="btn btn-outline btn-sm">
              <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
              Import
            </button>
            <button type="button" onClick={onAddManualBook} className="btn btn-primary btn-sm">
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
              options={availableYears.map((y) => ({ key: String(y), label: String(y) }))}
            />
          )}
        </div>

        {activeChallenge ? (
          <div className="pt-7">
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-display text-[48px] font-medium leading-[0.95] text-ink sm:text-[64px]">
                  {countWord(completed, true)}
                  <span className="italic text-ink-muted"> of {countWord(activeChallenge.goalCount)}</span>
                </p>
                <p className="mt-3 font-serif text-[17px] italic text-ink-soft">{paceSummary}</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onOpenChallengeModal(selectedYear, activeChallenge)}
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
                    <BookSpine key={`empty-${i}`} seed={`slot-${i}`} filled={false} />
                  );
                })}
              </div>
              <div className="h-[5px] border-t-2 border-ink/80 bg-gradient-to-b from-ink/10 to-transparent" />
              <p className="caps-sm mt-2 flex justify-between text-ink-faint">
                <span>Each spine, a book finished in {selectedYear}</span>
                <span className="nums-lining">
                  {Math.round((completed / Math.max(1, activeChallenge.goalCount)) * 100)}%
                </span>
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5 py-8 md:flex-row md:items-center md:justify-between">
            <div className="max-w-lg">
              <p className="font-display text-[34px] font-medium italic leading-tight text-ink">
                How many books will {selectedYear} hold?
              </p>
              <p className="mt-2 font-serif text-[16.5px] leading-relaxed text-ink-muted">
                Set yourself a number, and every book you mark as read fills a spine on the shelf.
                {completed > 0 &&
                  ` ${countWord(completed, true)} ${plural(completed, 'book')} already finished this year will count.`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChallengeModal(selectedYear)}
              className="btn btn-primary shrink-0"
            >
              Begin the {selectedYear} challenge
            </button>
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
                    <h3 className="book-title text-[19px] line-clamp-2">{book.title}</h3>
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

      {/* List vs log */}
      <section className="space-y-6">
        <Tabline
          value={listMode}
          onChange={setListMode}
          options={[
            { key: 'todo', label: 'To read', count: todoTotal },
            { key: 'read', label: 'Read', count: allReadBooks.length },
          ]}
          className="border-b border-rule"
        />

        {listMode === 'todo' ? (
          todoTotal === 0 ? (
            <EmptyState
              title="The reading list is empty."
              body="Choose “Add to list” on any book in Released or Search, and it will wait for you here."
            />
          ) : (
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
                        isAuthorFollowed={Boolean(book.authorId && followedIds.has(book.authorId))}
                        onToggleTodo={onToggleTodo}
                        onToggleRead={onToggleRead}
                        onOpenReadDetails={onOpenReadDetails}
                        onEditBook={onEditBook}
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
                        isAuthorFollowed={Boolean(book.authorId && followedIds.has(book.authorId))}
                        onToggleTodo={onToggleTodo}
                        onToggleRead={onToggleRead}
                        onEditBook={onEditBook}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        ) : allReadBooks.length === 0 ? (
          <EmptyState
            title="No books in the log yet."
            body="Mark a book as read from Released, your list, or Search. Each one keeps its date, a rating, and your notes."
          />
        ) : (
          <div className="border-b border-rule">
            {readByYear.map((group) => (
              <LedgerSection
                key={group.year}
                gutter={
                  <div className="flex items-baseline justify-between gap-3 md:block">
                    <p
                      className={`font-display font-medium leading-none text-ink nums-lining ${
                        group.year === 'Undated' ? 'text-[28px] italic' : 'text-[44px]'
                      }`}
                    >
                      {group.year}
                    </p>
                    <p className="font-serif text-[14px] italic text-ink-muted md:mt-2">
                      {countWord(group.books.length, true)} {plural(group.books.length, 'book')} read
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
                      isAuthorFollowed={Boolean(book.authorId && followedIds.has(book.authorId))}
                      onToggleTodo={onToggleTodo}
                      onToggleRead={onToggleRead}
                      onOpenReadDetails={onOpenReadDetails}
                      onEditBook={onEditBook}
                    />
                  ))}
                </div>
              </LedgerSection>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
