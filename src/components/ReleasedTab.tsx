'use client';

import React, { useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { BookCard } from '@/components/BookCard';
import {
  countWord,
  EmptyState,
  LedgerSection,
  PageHeader,
  plural,
  Tabline,
} from '@/components/ui';
import { sortReleasedBooksReverseChronological } from '@/lib/dates';
import { BookItem, FollowedAuthor } from '@/types/books';

interface ReleasedTabProps {
  books: BookItem[];
  authors: FollowedAuthor[];
  todayStr: string;
  selectedAuthorIdFilter: string | null;
  onClearAuthorFilter: () => void;
  onSelectAuthorFilter: (authorId: string) => void;
  onToggleTodo: (book: BookItem) => void;
  onToggleRead: (book: BookItem) => void;
  onOpenReadDetails: (book: BookItem) => void;
  onEditBook: (book: BookItem) => void;
  onRemoveOrHideBook: (book: BookItem) => void;
  onAddManualBook: () => void;
  onGoToSearch: () => void;
}

type Scope = 'all' | 'recent' | 'unread' | 'oneoff';

export function ReleasedTab({
  books,
  authors,
  todayStr,
  selectedAuthorIdFilter,
  onClearAuthorFilter,
  onSelectAuthorFilter,
  onToggleTodo,
  onToggleRead,
  onOpenReadDetails,
  onEditBook,
  onRemoveOrHideBook,
  onAddManualBook,
  onGoToSearch,
}: ReleasedTabProps) {
  const [scope, setScope] = useState<Scope>('all');
  const [searchFilter, setSearchFilter] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(40);

  const followedIds = useMemo(() => new Set(authors.map((a) => a.id)), [authors]);

  const cutoffTwoYearsAgo = useMemo(() => {
    const year = Number(todayStr.slice(0, 4)) - 2;
    return `${year}${todayStr.slice(4)}`;
  }, [todayStr]);

  const sortedBooks = useMemo(() => sortReleasedBooksReverseChronological(books), [books]);

  const filteredBooks = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    return sortedBooks.filter((b) => {
      if (selectedAuthorIdFilter && b.authorId !== selectedAuthorIdFilter) {
        return false;
      }
      if (scope === 'recent') {
        if (!b.releaseDate) return false;
        const normalized =
          b.releaseDate.length === 4
            ? `${b.releaseDate}-01-01`
            : b.releaseDate.length === 7
            ? `${b.releaseDate}-01`
            : b.releaseDate;
        if (normalized < cutoffTwoYearsAgo) return false;
      } else if (scope === 'unread') {
        if (b.readingStatus === 'read') return false;
      } else if (scope === 'oneoff') {
        if (!b.isOneOff || (b.authorId && followedIds.has(b.authorId))) return false;
      }

      if (q) {
        return b.title.toLowerCase().includes(q) || b.authorName.toLowerCase().includes(q);
      }
      return true;
    });
  }, [sortedBooks, selectedAuthorIdFilter, scope, cutoffTwoYearsAgo, followedIds, searchFilter]);

  const activeAuthorName = useMemo(
    () => authors.find((a) => a.id === selectedAuthorIdFilter)?.name,
    [authors, selectedAuthorIdFilter]
  );

  const displayedBooks = filteredBooks.slice(0, visibleLimit);

  // Group into a bibliography by year of publication (order already newest → oldest)
  const yearGroups = useMemo(() => {
    const groups: Array<{ year: string; books: BookItem[] }> = [];
    for (const book of displayedBooks) {
      const year =
        book.releaseDate && book.datePrecision !== 'unknown'
          ? book.releaseDate.slice(0, 4)
          : 'Undated';
      const last = groups[groups.length - 1];
      if (last && last.year === year) {
        last.books.push(book);
      } else {
        groups.push({ year, books: [book] });
      }
    }
    return groups;
  }, [displayedBooks]);

  const readCount = useMemo(
    () => books.filter((b) => b.readingStatus === 'read').length,
    [books]
  );

  return (
    <div className="space-y-8">
      <PageHeader
        numeral="II"
        kicker="The Published"
        title="Released"
        dek={
          books.length === 0
            ? 'Every book already in the world, newest first.'
            : `${countWord(books.length, true)} published ${plural(
                books.length,
                'title'
              )}, newest first. You have read ${countWord(readCount)} of them.`
        }
        actions={
          <button type="button" onClick={onAddManualBook} className="btn btn-primary btn-sm">
            <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
            Add a book
          </button>
        }
      />

      {selectedAuthorIdFilter && activeAuthorName && (
        <div className="flex items-center justify-between gap-3 border-y border-rule bg-paper-raised/60 px-4 py-3">
          <p className="font-serif text-[16px] text-ink-soft">
            <span className="italic text-ink-muted">The works of </span>
            {activeAuthorName}
          </p>
          <button type="button" onClick={onClearAuthorFilter} className="btn btn-ghost btn-sm">
            <X strokeWidth={1.5} className="h-3.5 w-3.5" />
            Show all
          </button>
        </div>
      )}

      {books.length > 0 && (
        <div className="flex flex-col gap-4 border-b border-rule sm:flex-row sm:items-end sm:justify-between">
          <Tabline
            value={scope}
            onChange={(next) => {
              setScope(next);
              setVisibleLimit(40);
            }}
            options={[
              { key: 'all', label: 'Everything', count: books.length },
              { key: 'recent', label: 'Past two years' },
              { key: 'unread', label: 'Unread' },
              { key: 'oneoff', label: 'Single titles' },
            ]}
          />

          <div className="relative mb-2 w-full sm:w-60">
            <Search
              strokeWidth={1.5}
              className="pointer-events-none absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Find a title or author…"
              className="w-full border-0 border-b border-transparent bg-transparent py-1 pl-6 pr-6 font-serif text-[15px] text-ink placeholder:italic placeholder:text-ink-faint focus:border-ink focus:outline-none focus:ring-0"
            />
            {searchFilter && (
              <button
                type="button"
                onClick={() => setSearchFilter('')}
                className="absolute right-0 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              >
                <X strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {filteredBooks.length === 0 ? (
        <EmptyState
          title={
            books.length === 0
              ? 'No published books on the shelves yet.'
              : 'Nothing matches that description.'
          }
          body={
            books.length === 0
              ? 'Follow an author or look up a single title, and their published work will gather here, newest first.'
              : 'Try another heading, or clear the search.'
          }
        >
          {books.length === 0 && (
            <button type="button" onClick={onGoToSearch} className="btn btn-primary">
              Search the catalogue
            </button>
          )}
        </EmptyState>
      ) : (
        <>
          <div className="border-b border-rule">
            {yearGroups.map((group) => (
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
                      {countWord(group.books.length, true)} {plural(group.books.length, 'title')}
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
                      isAuthorFollowed={Boolean(book.authorId && followedIds.has(book.authorId))}
                      onToggleTodo={onToggleTodo}
                      onToggleRead={onToggleRead}
                      onOpenReadDetails={onOpenReadDetails}
                      onEditBook={onEditBook}
                      onRemoveOrHideBook={onRemoveOrHideBook}
                      onSelectAuthor={onSelectAuthorFilter}
                    />
                  ))}
                </div>
              </LedgerSection>
            ))}
          </div>

          {filteredBooks.length > visibleLimit && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={() => setVisibleLimit((prev) => prev + 40)}
                className="btn btn-outline"
              >
                Turn the page
                <span className="font-serif italic text-ink-muted">
                  ({filteredBooks.length - visibleLimit} more)
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
