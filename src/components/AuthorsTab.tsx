'use client';

import React, { useMemo } from 'react';
import { Plus, RefreshCw, Upload } from 'lucide-react';
import { AuthorAvatar } from '@/components/BookCover';
import {
  countWord,
  EmptyState,
  LedgerSection,
  PageHeader,
  plural,
} from '@/components/ui';
import {
  decodeAuthorLatestRelease,
  findMostRecentAuthorRelease,
  normalizeAuthorCanonicalKey,
  type AuthorLatestReleaseInfo,
} from '@/lib/bookDedupe';
import { classifyReleaseTiming, formatReleaseDate } from '@/lib/dates';
import { BookItem, FollowedAuthor } from '@/types/books';

interface AuthorsTabProps {
  authors: FollowedAuthor[];
  books: BookItem[];
  todayStr: string;
  syncingAuthorIds: Set<string>;
  isSyncingAll: boolean;
  onSyncAuthor: (author: FollowedAuthor) => void;
  onSyncAllAuthors: () => void;
  onUnfollowAuthor: (author: FollowedAuthor) => void;
  onAddManualAuthor: () => void;
  onOpenBatchImport: () => void;
  onAddBookForAuthor: (authorId: string) => void;
  onViewAuthorReleased: (authorId: string) => void;
  onGoToSearch: () => void;
}

/** Index authors by surname, as a library catalogue would. */
function surnameOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || name;
}

export function AuthorsTab({
  authors,
  books,
  todayStr,
  syncingAuthorIds,
  isSyncingAll,
  onSyncAuthor,
  onSyncAllAuthors,
  onUnfollowAuthor,
  onAddManualAuthor,
  onOpenBatchImport,
  onAddBookForAuthor,
  onViewAuthorReleased,
  onGoToSearch,
}: AuthorsTabProps) {
  const { statsByAuthor, latestReleaseByAuthor } = useMemo(() => {
    const authorIdByNorm = new Map<string, string>();
    for (const a of authors) {
      const norm = normalizeAuthorCanonicalKey(a.name);
      if (norm) authorIdByNorm.set(norm, a.id);
    }

    const statsMap = new Map<string, { upcoming: number; released: number }>();
    const booksByAuthorId = new Map<string, BookItem[]>();

    for (const b of books) {
      if (b.hidden) continue;
      const resolvedAuthorId =
        b.authorId ||
        authorIdByNorm.get(normalizeAuthorCanonicalKey(b.authorName));
      if (!resolvedAuthorId) continue;

      if (!statsMap.has(resolvedAuthorId)) {
        statsMap.set(resolvedAuthorId, { upcoming: 0, released: 0 });
      }
      const stat = statsMap.get(resolvedAuthorId)!;
      if (classifyReleaseTiming(b, todayStr) === 'upcoming') {
        stat.upcoming += 1;
      } else {
        stat.released += 1;
      }

      const list = booksByAuthorId.get(resolvedAuthorId) || [];
      list.push(b);
      booksByAuthorId.set(resolvedAuthorId, list);
    }

    const latestMap = new Map<string, AuthorLatestReleaseInfo>();
    for (const author of authors) {
      const storedLatest = decodeAuthorLatestRelease(author.bio);
      const ledgerBooks = booksByAuthorId.get(author.id) || [];
      const combinedCandidates: Array<
        Pick<BookItem, 'title' | 'releaseDate' | 'datePrecision' | 'hidden'>
      > = [
        ...(storedLatest ? [{ ...storedLatest, hidden: false }] : []),
        ...ledgerBooks,
      ];
      const best = findMostRecentAuthorRelease(combinedCandidates, todayStr);
      if (best) {
        latestMap.set(author.id, best);
      }
    }

    return { statsByAuthor: statsMap, latestReleaseByAuthor: latestMap };
  }, [authors, books, todayStr]);

  const letterGroups = useMemo(() => {
    const sorted = [...authors].sort((a, b) =>
      surnameOf(a.name).localeCompare(surnameOf(b.name))
    );
    const groups: Array<{ letter: string; authors: FollowedAuthor[] }> = [];
    for (const author of sorted) {
      const first = surnameOf(author.name).charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      const last = groups[groups.length - 1];
      if (last && last.letter === letter) last.authors.push(author);
      else groups.push({ letter, authors: [author] });
    }
    return groups;
  }, [authors]);

  const totalUpcoming = useMemo(() => {
    let n = 0;
    statsByAuthor.forEach((s) => (n += s.upcoming));
    return n;
  }, [statsByAuthor]);

  return (
    <div className="space-y-8">
      <PageHeader
        numeral="V"
        kicker="The Company Kept"
        title="Authors"
        dek={
          authors.length === 0
            ? 'The writers whose every new book you want to hear about.'
            : `Following ${countWord(authors.length)} ${plural(authors.length, 'author')}, with ${countWord(
                totalUpcoming
              )} forthcoming ${plural(totalUpcoming, 'book')} between them.`
        }
        actions={
          <>
            {authors.length > 0 && (
              <button
                type="button"
                onClick={onSyncAllAuthors}
                disabled={isSyncingAll}
                className="btn btn-outline btn-sm"
              >
                <RefreshCw
                  strokeWidth={1.5}
                  className={`h-3.5 w-3.5 ${isSyncingAll ? 'animate-spin' : ''}`}
                />
                {isSyncingAll ? 'Refreshing…' : 'Refresh all'}
              </button>
            )}
            <button type="button" onClick={onOpenBatchImport} className="btn btn-outline btn-sm">
              <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
              Import a list
            </button>
            <button type="button" onClick={onAddManualAuthor} className="btn btn-primary btn-sm">
              <Plus strokeWidth={1.75} className="h-3.5 w-3.5" />
              Add an author
            </button>
          </>
        }
      />

      {authors.length === 0 ? (
        <EmptyState
          title="You aren’t following anyone yet."
          body="Search for a writer to gather their published and forthcoming books, or add a small-press or self-published author by hand."
        >
          <button type="button" onClick={onGoToSearch} className="btn btn-primary">
            Search for authors
          </button>
          <button type="button" onClick={onAddManualAuthor} className="btn btn-outline">
            Add by hand
          </button>
        </EmptyState>
      ) : (
        <div className="border-b border-rule">
          {letterGroups.map((group) => (
            <LedgerSection
              key={group.letter}
              gutter={
                <p className="font-display text-[52px] font-medium leading-none text-ink">
                  {group.letter}
                </p>
              }
            >
              <div className="-mb-px grid grid-cols-1 gap-x-10 lg:grid-cols-2">
                {group.authors.map((author) => {
                  const counts = statsByAuthor.get(author.id) || { upcoming: 0, released: 0 };
                  const isSyncing = syncingAuthorIds.has(author.id);
                  const latestRelease = latestReleaseByAuthor.get(author.id);
                  const customManualBio =
                    author.source === 'manual' &&
                    author.bio &&
                    !author.bio.startsWith('folio:latest:')
                      ? author.bio
                      : undefined;

                  return (
                    <article key={author.id} className="flex gap-4 border-b border-rule py-5">
                      <AuthorAvatar name={author.name} imageUrl={author.imageUrl} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <h3 className="truncate font-serif text-[21px] font-medium leading-tight text-ink">
                            {author.name}
                          </h3>
                          <span className="caps-sm shrink-0 text-ink-faint">
                            {author.source === 'hardcover'
                              ? 'Hardcover'
                              : author.source === 'manual'
                              ? 'By hand'
                              : 'Catalogue'}
                          </span>
                        </div>

                        <p className="mt-0.5 font-serif text-[15px] italic text-ink-muted">
                          <span className={counts.upcoming > 0 ? 'text-claret' : ''}>
                            {countWord(counts.upcoming, true)} forthcoming
                          </span>
                          <span className="mx-1.5 text-ink-faint">·</span>
                          <button
                            type="button"
                            onClick={() => onViewAuthorReleased(author.id)}
                            className="italic transition-colors hover:text-ink"
                          >
                            {countWord(counts.released)} published
                          </button>
                        </p>

                        {latestRelease ? (
                          <p className="mt-1.5 truncate font-serif text-[14px] leading-snug text-ink-muted">
                            <span className="caps-sm mr-1.5 text-ink-faint">
                              Latest
                            </span>
                            <span className="italic text-ink-soft">
                              {latestRelease.title}
                            </span>
                            {latestRelease.releaseDate && (
                              <span className="ml-1.5 font-sans text-[11.5px] text-ink-faint nums-lining">
                                ·{' '}
                                {formatReleaseDate(
                                  latestRelease.releaseDate,
                                  latestRelease.datePrecision,
                                  todayStr
                                )}
                              </span>
                            )}
                          </p>
                        ) : customManualBio ? (
                          <p className="mt-1.5 text-[13px] leading-snug text-ink-muted line-clamp-2">
                            {customManualBio}
                          </p>
                        ) : null}

                        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                          <button
                            type="button"
                            onClick={() => onSyncAuthor(author)}
                            disabled={isSyncing}
                            className="entry-action disabled:opacity-50"
                          >
                            <RefreshCw
                              strokeWidth={1.5}
                              className={`h-3 w-3 ${isSyncing ? 'animate-spin' : ''}`}
                            />
                            {isSyncing ? 'Refreshing…' : 'Refresh'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onAddBookForAuthor(author.id)}
                            className="entry-action"
                          >
                            <Plus strokeWidth={1.5} className="h-3 w-3" />
                            Add a book
                          </button>
                          <button
                            type="button"
                            onClick={() => onUnfollowAuthor(author)}
                            className="entry-action hover:!text-claret"
                          >
                            Unfollow
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </LedgerSection>
          ))}
        </div>
      )}
    </div>
  );
}
