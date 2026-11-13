'use client';

import React, { useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { BookCard } from '@/components/BookCard';
import {
  countWord,
  EmptyState,
  LedgerSection,
  PageHeader,
  plural,
  Tabline,
} from '@/components/ui';
import { groupUpcomingBooksByWeek, WeekBucket } from '@/lib/dates';
import { BookItem, FollowedAuthor } from '@/types/books';

interface UpcomingTabProps {
  books: BookItem[];
  authors: FollowedAuthor[];
  todayStr: string;
  isSyncing: boolean;
  onToggleTodo: (book: BookItem) => void;
  onToggleRead: (book: BookItem) => void;
  onEditBook: (book: BookItem) => void;
  onRemoveOrHideBook: (book: BookItem) => void;
  onAddManualBook: () => void;
  onSyncAllAuthors: () => void;
  onGoToSearch: (prefill?: string) => void;
  onSelectAuthorFilter: (authorId: string) => void;
  onOpenImport: () => void;
}

const SUGGESTED_AUTHORS = [
  'Sally Rooney',
  'Kazuo Ishiguro',
  'R.F. Kuang',
  'Emily Henry',
  'Brandon Sanderson',
  'Ocean Vuong',
];

function describeBucket(bucket: WeekBucket): {
  kicker: string;
  main: string;
  accent: boolean;
} {
  const [, afterDot] = bucket.label.split(' · ');
  if (bucket.isCurrentWeek) {
    return { kicker: 'This week', main: afterDot || bucket.label, accent: true };
  }
  if (bucket.isNextWeek) {
    return { kicker: 'Next week', main: afterDot || bucket.label, accent: false };
  }
  if (bucket.key.startsWith('week:')) {
    return { kicker: 'Week of', main: bucket.label.replace(/^Week of /, ''), accent: false };
  }
  if (bucket.key.startsWith('month:')) {
    return { kicker: 'Day to be announced', main: bucket.label.split(' · ')[0], accent: false };
  }
  if (bucket.key.startsWith('year:')) {
    return {
      kicker: 'Expected',
      main: bucket.label.replace(/^Expected in /, '').split(' · ')[0],
      accent: false,
    };
  }
  return { kicker: 'Announced', main: 'Date to come', accent: false };
}

export function UpcomingTab({
  books,
  authors,
  todayStr,
  isSyncing,
  onToggleTodo,
  onToggleRead,
  onEditBook,
  onRemoveOrHideBook,
  onAddManualBook,
  onSyncAllAuthors,
  onGoToSearch,
  onSelectAuthorFilter,
  onOpenImport,
}: UpcomingTabProps) {
  const [filterMode, setFilterMode] = useState<'all' | 'authors' | 'oneoff'>('all');

  const followedIds = useMemo(() => new Set(authors.map((a) => a.id)), [authors]);

  const filteredBooks = useMemo(() => {
    return books.filter((b) => {
      if (filterMode === 'authors') {
        return Boolean(b.authorId && followedIds.has(b.authorId));
      }
      if (filterMode === 'oneoff') {
        return b.isOneOff && (!b.authorId || !followedIds.has(b.authorId));
      }
      return true;
    });
  }, [books, filterMode, followedIds]);

  const weekBuckets = useMemo(
    () => groupUpcomingBooksByWeek(filteredBooks, todayStr),
    [filteredBooks, todayStr]
  );

  const datedWeeks = weekBuckets.filter((b) => !b.isTBA).length;

  const dek =
    books.length === 0
      ? 'New books from the authors you follow, set down week by week in order of arrival.'
      : `${countWord(books.length, true)} forthcoming ${plural(books.length, 'title')}${
          datedWeeks > 0
            ? `, arriving over ${countWord(datedWeeks)} ${plural(datedWeeks, 'week')}`
            : ''
        }.`;

  return (
    <div className="space-y-8">
      <PageHeader
        numeral="I"
        kicker="The Forthcoming"
        title="Upcoming"
        dek={dek}
        actions={
          <>
            {authors.length > 0 && (
              <button
                type="button"
                onClick={onSyncAllAuthors}
                disabled={isSyncing}
                className="btn btn-outline btn-sm"
              >
                <RefreshCw
                  strokeWidth={1.5}
                  className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`}
                />
                {isSyncing ? 'Consulting catalogues…' : 'Refresh'}
              </button>
            )}
            <button type="button" onClick={onAddManualBook} className="btn btn-primary btn-sm">
              <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
              Add a book
            </button>
          </>
        }
      />

      {books.length > 0 && (
        <Tabline
          value={filterMode}
          onChange={setFilterMode}
          options={[
            { key: 'all', label: 'Everything', count: books.length },
            { key: 'authors', label: 'Followed authors' },
            { key: 'oneoff', label: 'Single titles' },
          ]}
          className="border-b border-rule"
        />
      )}

      {filteredBooks.length === 0 ? (
        <EmptyState
          title={
            books.length > 0
              ? 'Nothing forthcoming under this heading.'
              : authors.length === 0
              ? 'Your almanac awaits its first entries.'
              : 'No release dates announced just yet.'
          }
          body={
            books.length > 0
              ? 'Try another view, or add an announced title by hand.'
              : authors.length === 0
              ? 'Follow the authors you read, or pin a single forthcoming title, and Folio will keep their release dates in order for you.'
              : 'None of the authors you follow have dated books in the catalogue yet. Announced titles can always be added by hand.'
          }
        >
          {books.length === 0 && (
            <>
              <button type="button" onClick={() => onGoToSearch()} className="btn btn-primary">
                Search the catalogue
              </button>
              <button type="button" onClick={onOpenImport} className="btn btn-outline">
                Import from Goodreads
              </button>
              <button type="button" onClick={onAddManualBook} className="btn btn-ghost">
                Add by hand
              </button>
            </>
          )}
          {authors.length === 0 && books.length === 0 && (
            <p className="mt-6 w-full font-serif text-[16px] italic text-ink-muted">
              Or begin with{' '}
              {SUGGESTED_AUTHORS.map((name, i) => (
                <React.Fragment key={name}>
                  <button type="button" onClick={() => onGoToSearch(name)} className="link not-italic">
                    {name}
                  </button>
                  {i < SUGGESTED_AUTHORS.length - 2
                    ? ', '
                    : i === SUGGESTED_AUTHORS.length - 2
                    ? ', or '
                    : '.'}
                </React.Fragment>
              ))}
            </p>
          )}
        </EmptyState>
      ) : (
        <div className="border-b border-rule">
          {weekBuckets.map((bucket) => {
            const info = describeBucket(bucket);
            return (
              <LedgerSection
                key={bucket.key}
                gutter={
                  <div className="flex items-baseline justify-between gap-3 md:block">
                    <div>
                      <p className={`caps ${info.accent ? 'text-claret' : 'text-ink-muted'}`}>
                        {info.kicker}
                      </p>
                      <p className="mt-1 font-display text-[26px] font-medium leading-tight text-ink nums-lining">
                        {info.main}
                      </p>
                    </div>
                    <p className="font-serif text-[14px] italic text-ink-muted md:mt-1.5">
                      {countWord(bucket.books.length, true)} {plural(bucket.books.length, 'title')}
                    </p>
                  </div>
                }
              >
                <div className="[&>article:last-child]:border-b-0">
                  {bucket.books.map((book) => (
                    <BookCard
                      key={book.id}
                      book={book}
                      todayStr={todayStr}
                      showDateBlock
                      isAuthorFollowed={Boolean(book.authorId && followedIds.has(book.authorId))}
                      onToggleTodo={onToggleTodo}
                      onToggleRead={onToggleRead}
                      onEditBook={onEditBook}
                      onRemoveOrHideBook={onRemoveOrHideBook}
                      onSelectAuthor={onSelectAuthorFilter}
                    />
                  ))}
                </div>
              </LedgerSection>
            );
          })}
        </div>
      )}
    </div>
  );
}
