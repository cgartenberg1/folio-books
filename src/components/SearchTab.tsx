'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Loader2,
  Pin,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { AuthorAvatar, BookCover } from '@/components/BookCover';
import { countWord, PageHeader, plural, SectionHeading, Tabline } from '@/components/ui';
import { classifyReleaseTiming, formatReleaseDate } from '@/lib/dates';
import {
  BookItem,
  FollowedAuthor,
  SearchAuthorResult,
  SearchBookResult,
} from '@/types/books';

interface SearchTabProps {
  initialQuery?: string;
  onConsumeInitialQuery: () => void;
  authors: FollowedAuthor[];
  books: BookItem[];
  todayStr: string;
  hardcoverToken?: string;
  syncingAuthorIds: Set<string>;
  onFollowSearchAuthor: (author: SearchAuthorResult) => void;
  onUnfollowAuthor: (author: FollowedAuthor) => void;
  onTrackOneOffBook: (book: SearchBookResult) => void;
  onAddSearchBookToTodo: (book: SearchBookResult) => void;
  onMarkSearchBookRead: (book: SearchBookResult) => void;
  onAddManualAuthor: () => void;
  onAddManualBook: () => void;
}

type SearchMode = 'all' | 'authors' | 'books';

export function SearchTab({
  initialQuery,
  onConsumeInitialQuery,
  authors,
  books,
  todayStr,
  hardcoverToken,
  syncingAuthorIds,
  onFollowSearchAuthor,
  onUnfollowAuthor,
  onTrackOneOffBook,
  onAddSearchBookToTodo,
  onMarkSearchBookRead,
  onAddManualAuthor,
  onAddManualBook,
}: SearchTabProps) {
  const [query, setQuery] = useState(initialQuery || '');
  const [mode, setMode] = useState<SearchMode>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [authorResults, setAuthorResults] = useState<SearchAuthorResult[]>([]);
  const [bookResults, setBookResults] = useState<SearchBookResult[]>([]);
  const [providerUsed, setProviderUsed] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  const runSearch = useCallback(
    async (searchText: string, searchMode: SearchMode) => {
      const trimmed = searchText.trim();
      if (trimmed.length < 2) {
        setAuthorResults([]);
        setBookResults([]);
        setErrorMsg('');
        return;
      }

      setIsLoading(true);
      setErrorMsg('');
      try {
        const headers: Record<string, string> = {};
        if (hardcoverToken?.trim()) {
          headers['x-hardcover-token'] = hardcoverToken.trim();
        }
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}&mode=${searchMode}`,
          { headers }
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Search failed');
        }
        setAuthorResults(data.authors || []);
        setBookResults(data.books || []);
        setProviderUsed(data.providerUsed || '');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setIsLoading(false);
      }
    },
    [hardcoverToken]
  );

  useEffect(() => {
    if (initialQuery && initialQuery.trim()) {
      setQuery(initialQuery);
      runSearch(initialQuery, mode);
      onConsumeInitialQuery();
    }
  }, [initialQuery, mode, onConsumeInitialQuery, runSearch]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setAuthorResults([]);
      setBookResults([]);
      return;
    }
    const timer = setTimeout(() => {
      runSearch(trimmed, mode);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, mode, runSearch]);

  const followedByNormName = useMemo(() => {
    const map = new Map<string, FollowedAuthor>();
    for (const a of authors) {
      map.set(a.name.toLowerCase().trim(), a);
      map.set(a.id, a);
    }
    return map;
  }, [authors]);

  const trackedBookLookup = useMemo(() => {
    const map = new Map<string, BookItem>();
    for (const b of books) {
      if (b.hidden) continue;
      map.set(b.id, b);
      const normKey = `${b.title.toLowerCase().trim()}::${b.authorName.toLowerCase().trim()}`;
      map.set(normKey, b);
    }
    return map;
  }, [books]);

  const hasQuery = query.trim().length >= 2;

  return (
    <div className="space-y-8">
      <PageHeader
        numeral="VI"
        kicker="The Catalogue"
        title="Search"
        dek="Follow a writer’s whole body of work, or keep watch over a single title."
        actions={
          <>
            <button type="button" onClick={onAddManualAuthor} className="btn btn-outline btn-sm">
              <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
              Author by hand
            </button>
            <button type="button" onClick={onAddManualBook} className="btn btn-outline btn-sm">
              <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
              Book by hand
            </button>
          </>
        }
      />

      {/* The search line */}
      <div className="space-y-4">
        <div className="relative">
          <Search
            strokeWidth={1.25}
            className="pointer-events-none absolute left-0 top-1/2 h-6 w-6 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="An author, a title, an ISBN…"
            className="w-full border-0 border-b border-rule-strong bg-transparent py-3 pl-10 pr-10 font-display text-[28px] font-medium text-ink placeholder:italic placeholder:font-normal placeholder:text-ink-faint focus:border-ink focus:outline-none focus:ring-0 sm:text-[36px]"
          />
          {isLoading ? (
            <Loader2
              strokeWidth={1.5}
              className="absolute right-1 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-ink-faint"
            />
          ) : (
            query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear"
                className="icon-btn absolute right-0 top-1/2 -translate-y-1/2"
              >
                <X strokeWidth={1.5} className="h-5 w-5" />
              </button>
            )
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabline
            value={mode}
            onChange={setMode}
            options={[
              { key: 'all', label: 'Everything' },
              { key: 'authors', label: 'Authors' },
              { key: 'books', label: 'Books' },
            ]}
          />
          {providerUsed && !isLoading && hasQuery && (
            <span className="caps-sm text-ink-faint">
              From{' '}
              {providerUsed === 'hardcover'
                ? 'Hardcover'
                : providerUsed === 'hybrid'
                ? 'Hardcover & Google Books'
                : 'Google Books & Open Library'}
            </span>
          )}
        </div>
      </div>

      {errorMsg && (
        <p className="border-l-2 border-claret pl-3 font-serif text-[15px] italic text-claret">
          {errorMsg}
        </p>
      )}

      {!hasQuery && (
        <div className="grid grid-cols-1 gap-10 border-t border-rule pt-8 md:grid-cols-2">
          {[
            {
              n: 'i',
              title: 'Follow an author',
              body: 'Folio gathers their announced books into Upcoming, week by week, and their backlist into Released. New titles appear as the catalogues learn of them.',
            },
            {
              n: 'ii',
              title: 'Keep watch on a single title',
              body: 'Choose “Track this title” on any book to follow its release date alone, without taking on the rest of the author’s list.',
            },
          ].map((item) => (
            <div key={item.n} className="flex gap-5">
              <span className="font-display text-[40px] italic leading-none text-claret">
                {item.n}.
              </span>
              <div>
                <h3 className="font-serif text-[20px] font-medium text-ink">{item.title}</h3>
                <p className="mt-1.5 font-serif text-[16px] leading-relaxed text-ink-muted text-pretty">
                  {item.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      {hasQuery && (isLoading && authorResults.length === 0 && bookResults.length === 0) && (
        <p className="py-12 text-center font-serif text-[17px] italic text-ink-muted">
          Consulting the catalogues…
        </p>
      )}

      {hasQuery && !(isLoading && authorResults.length === 0 && bookResults.length === 0) && (
        <div className={`space-y-12 transition-opacity ${isLoading ? 'opacity-60' : ''}`}>
          {(mode === 'all' || mode === 'authors') && (
            <section>
              <SectionHeading
                title="Authors"
                meta={`${countWord(authorResults.length, true)} ${plural(
                  authorResults.length,
                  'match',
                  'matches'
                )}`}
              />

              {authorResults.length === 0 ? (
                <p className="py-6 font-serif text-[16px] italic text-ink-muted">
                  No authors by that name.{' '}
                  <button type="button" onClick={onAddManualAuthor} className="link not-italic">
                    Add one by hand
                  </button>
                  .
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
                  {authorResults.map((author) => {
                    const existing =
                      followedByNormName.get(author.id) ||
                      followedByNormName.get(author.name.toLowerCase().trim());
                    const isSyncing =
                      syncingAuthorIds.has(author.id) ||
                      (existing ? syncingAuthorIds.has(existing.id) : false);

                    return (
                      <div
                        key={author.id}
                        className="flex items-center justify-between gap-4 border-b border-rule py-4"
                      >
                        <div className="flex min-w-0 items-center gap-3.5">
                          <AuthorAvatar name={author.name} imageUrl={author.imageUrl} />
                          <div className="min-w-0">
                            <h4 className="truncate font-serif text-[18px] font-medium text-ink">
                              {author.name}
                            </h4>
                            <p className="truncate font-serif text-[14.5px] italic text-ink-muted">
                              {author.topWork
                                ? `Author of ${author.topWork}`
                                : author.booksCount
                                ? `${countWord(author.booksCount)} catalogued works`
                                : 'Author'}
                            </p>
                          </div>
                        </div>

                        {existing ? (
                          <button
                            type="button"
                            onClick={() => onUnfollowAuthor(existing)}
                            disabled={isSyncing}
                            title="Unfollow"
                            className="group btn btn-ghost btn-sm shrink-0 !text-claret"
                          >
                            {isSyncing ? (
                              <>
                                <Loader2 strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />
                                Gathering…
                              </>
                            ) : (
                              <>
                                <Check strokeWidth={2} className="h-3.5 w-3.5" />
                                <span className="group-hover:hidden">Following</span>
                                <span className="hidden group-hover:inline">Unfollow</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onFollowSearchAuthor(author)}
                            disabled={isSyncing}
                            className="btn btn-outline btn-sm shrink-0"
                          >
                            {isSyncing && (
                              <Loader2 strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />
                            )}
                            Follow
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {(mode === 'all' || mode === 'books') && (
            <section>
              <SectionHeading
                title="Books"
                meta={`${countWord(bookResults.length, true)} ${plural(
                  bookResults.length,
                  'match',
                  'matches'
                )}`}
              />

              {bookResults.length === 0 ? (
                <p className="py-6 font-serif text-[16px] italic text-ink-muted">
                  No books by that description.{' '}
                  <button type="button" onClick={onAddManualBook} className="link not-italic">
                    Add one by hand
                  </button>
                  .
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
                  {bookResults.map((b) => {
                    const normKey = `${b.title.toLowerCase().trim()}::${b.authorName
                      .toLowerCase()
                      .trim()}`;
                    const existing = trackedBookLookup.get(b.id) || trackedBookLookup.get(normKey);
                    const timing = classifyReleaseTiming(b, todayStr);
                    const isTodo = existing?.readingStatus === 'todo';
                    const isRead = existing?.readingStatus === 'read';
                    const isTracked = Boolean(existing?.isOneOff);

                    return (
                      <article key={b.id} className="flex gap-4 border-b border-rule py-5 sm:gap-5">
                        <BookCover title={b.title} authorName={b.authorName} coverUrl={b.coverUrl} />

                        <div className="flex min-w-0 flex-1 flex-col">
                          <h4 className="book-title text-[19px] line-clamp-2">{b.title}</h4>
                          <p className="byline mt-0.5 truncate text-[15.5px]">
                            <span className="text-ink-muted">by </span>
                            {b.authorName}
                          </p>
                          <div className="caps-sm mt-2 flex flex-wrap items-center gap-x-2 text-ink-muted">
                            <span className={timing === 'upcoming' ? 'text-claret' : ''}>
                              {timing === 'upcoming' ? 'Forthcoming' : 'Published'}
                            </span>
                            <span className="text-ink-faint">·</span>
                            <span className="nums-lining">
                              {formatReleaseDate(b.releaseDate, b.datePrecision)}
                            </span>
                            {b.pageCount ? (
                              <>
                                <span className="text-ink-faint">·</span>
                                <span className="nums-lining">{b.pageCount} pp.</span>
                              </>
                            ) : null}
                          </div>

                          <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-3">
                            <button
                              type="button"
                              onClick={() => onTrackOneOffBook(b)}
                              data-active={isTracked}
                              className="entry-action"
                            >
                              <Pin
                                strokeWidth={1.5}
                                className={`h-3.5 w-3.5 ${isTracked ? 'fill-claret/15' : ''}`}
                              />
                              {isTracked ? 'Tracking' : 'Track this title'}
                            </button>

                            <button
                              type="button"
                              onClick={() => onAddSearchBookToTodo(b)}
                              data-active={isTodo}
                              className="entry-action"
                            >
                              {isTodo ? (
                                <BookmarkCheck strokeWidth={1.5} className="h-3.5 w-3.5 fill-claret/15" />
                              ) : (
                                <Bookmark strokeWidth={1.5} className="h-3.5 w-3.5" />
                              )}
                              {isTodo ? 'On your list' : 'Add to list'}
                            </button>

                            {timing === 'released' && (
                              <button
                                type="button"
                                onClick={() => onMarkSearchBookRead(b)}
                                data-active={isRead}
                                className="entry-action"
                              >
                                <Check strokeWidth={isRead ? 2 : 1.5} className="h-3.5 w-3.5" />
                                {isRead ? 'Read' : 'Mark as read'}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
