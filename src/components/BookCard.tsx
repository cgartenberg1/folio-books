'use client';

import React from 'react';
import { format, parseISO } from 'date-fns';
import { Bookmark, BookmarkCheck, BookOpen, Check, EyeOff, PenLine, X } from 'lucide-react';
import { BookCover } from '@/components/BookCover';
import { Rating } from '@/components/ui';
import {
  classifyReleaseTiming,
  formatReleaseDate,
  getRelativeReleaseLabel,
  isLateYearTbaPlaceholder,
} from '@/lib/dates';
import { canOpenVellumWebUrl } from '@/lib/vellumBridge';
import { BookItem } from '@/types/books';

interface BookCardProps {
  book: BookItem;
  todayStr: string;
  isAuthorFollowed?: boolean;
  /** Almanac mode: prints the release day in a left-hand date column */
  showDateBlock?: boolean;
  vellumUrl?: string;
  onToggleTodo: (book: BookItem) => void;
  onToggleRead: (book: BookItem) => void;
  onOpenReadDetails?: (book: BookItem) => void;
  onEditBook?: (book: BookItem) => void;
  onRemoveOrHideBook?: (book: BookItem) => void;
  onSelectAuthor?: (authorId: string) => void;
}

function DateBlock({ book, todayStr }: { book: BookItem; todayStr: string }) {
  if (
    book.datePrecision === 'day' &&
    book.releaseDate &&
    !isLateYearTbaPlaceholder(book.releaseDate, book.datePrecision, todayStr)
  ) {
    const d = parseISO(book.releaseDate);
    if (!Number.isNaN(d.getTime())) {
      return (
        <div className="w-10 shrink-0 pt-0.5 text-center sm:w-12">
          <div className="caps-sm text-ink-muted">{format(d, 'EEE')}</div>
          <div className="mt-0.5 font-display text-[34px] font-medium leading-[0.9] text-ink nums-lining sm:text-[38px]">
            {format(d, 'd')}
          </div>
          <div className="caps-sm mt-1 text-ink-faint">{format(d, 'MMM')}</div>
        </div>
      );
    }
  }

  if (book.datePrecision === 'month' && book.releaseDate) {
    const d = parseISO(`${book.releaseDate}-01`);
    return (
      <div className="w-10 shrink-0 pt-1 text-center sm:w-12">
        <div className="font-display text-[22px] italic leading-none text-ink-soft">
          {Number.isNaN(d.getTime()) ? '—' : format(d, 'MMM')}
        </div>
        <div className="caps-sm mt-1.5 text-ink-faint">Day TBA</div>
      </div>
    );
  }

  return (
    <div className="w-10 shrink-0 pt-1 text-center sm:w-12">
      <div className="font-display text-[26px] leading-none text-ink-faint">—</div>
      <div className="caps-sm mt-1.5 text-ink-faint">TBA</div>
    </div>
  );
}

export function BookCard({
  book,
  todayStr,
  isAuthorFollowed,
  showDateBlock = false,
  vellumUrl = 'http://localhost:3030',
  onToggleTodo,
  onToggleRead,
  onOpenReadDetails,
  onEditBook,
  onRemoveOrHideBook,
  onSelectAuthor,
}: BookCardProps) {
  const timing = classifyReleaseTiming(book, todayStr);
  const formattedDate = formatReleaseDate(
    book.releaseDate,
    book.datePrecision,
    todayStr
  );
  const relativeLabel = getRelativeReleaseLabel(
    book.releaseDate,
    book.datePrecision,
    todayStr
  );

  const isTodo = book.readingStatus === 'todo';
  const isRead = book.readingStatus === 'read';
  const isRemovable = (book.isOneOff && !isAuthorFollowed) || book.isManual;

  const metaParts: React.ReactNode[] = [];
  if (!showDateBlock) {
    metaParts.push(
      <span key="date" className="nums-lining">
        {timing === 'upcoming' ? 'Due ' : ''}
        {formattedDate}
      </span>
    );
  }
  if (relativeLabel) {
    metaParts.push(
      <span key="rel" className={timing === 'upcoming' ? 'text-claret' : ''}>
        {relativeLabel}
      </span>
    );
  }
  if (book.isOneOff && !isAuthorFollowed) {
    metaParts.push(<span key="oneoff">Single title</span>);
  }
  if (book.isManual) {
    metaParts.push(<span key="manual">Added by hand</span>);
  }
  if (book.pageCount && !showDateBlock) {
    metaParts.push(
      <span key="pages" className="nums-lining">
        {book.pageCount} pp.
      </span>
    );
  }
  if (
    typeof book.vellumProgress === 'number' &&
    book.vellumProgress >= 0.005 &&
    !isRead
  ) {
    metaParts.push(
      <span key="vellum-prog" className="text-claret nums-lining">
        {Math.round(book.vellumProgress * 100)}% in Vellum
      </span>
    );
  } else if (book.vellumBookId && isRead) {
    metaParts.push(<span key="vellum-fin">Read in Vellum</span>);
  }

  return (
    <article className="group relative flex gap-4 border-b border-rule py-5 sm:gap-5">
      {showDateBlock && <DateBlock book={book} todayStr={todayStr} />}

      <BookCover
        title={book.title}
        authorName={book.authorName}
        coverUrl={book.coverUrl}
        onClick={onEditBook ? () => onEditBook(book) : undefined}
        actionTitle={onEditBook ? 'Edit details or change cover artwork' : undefined}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <h3 className="book-title text-[19px] line-clamp-2 sm:text-[20px]">{book.title}</h3>

          {(onEditBook || onRemoveOrHideBook) && (
            <div className="-mr-1.5 -mt-1 flex shrink-0 items-center opacity-70 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
              {onEditBook && (
                <button
                  type="button"
                  onClick={() => onEditBook(book)}
                  title="Edit details"
                  className="icon-btn h-7 w-7"
                >
                  <PenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
                </button>
              )}
              {onRemoveOrHideBook && (
                <button
                  type="button"
                  onClick={() => onRemoveOrHideBook(book)}
                  title={isRemovable ? 'Remove from your ledger' : 'Hide from feed'}
                  className="icon-btn h-7 w-7 hover:text-claret"
                >
                  {isRemovable ? (
                    <X strokeWidth={1.5} className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff strokeWidth={1.5} className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        <p className="byline mt-0.5 text-[15.5px] leading-snug">
          <span className="text-ink-muted">by </span>
          {book.authorId && isAuthorFollowed && onSelectAuthor ? (
            <button
              type="button"
              onClick={() => onSelectAuthor(book.authorId!)}
              className="text-left transition-colors hover:text-claret"
            >
              {book.authorName}
            </button>
          ) : (
            <span>{book.authorName}</span>
          )}
        </p>

        {metaParts.length > 0 && (
          <div className="caps-sm mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
            {metaParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-ink-faint">·</span>}
                {part}
              </React.Fragment>
            ))}
          </div>
        )}

        {isRead && (book.rating || book.finishedAt || onOpenReadDetails) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {book.rating ? (
              onOpenReadDetails ? (
                <button
                  type="button"
                  onClick={() => onOpenReadDetails(book)}
                  title="Edit rating, finish date, or notes"
                  className="transition-opacity hover:opacity-80"
                >
                  <Rating value={book.rating} />
                </button>
              ) : (
                <Rating value={book.rating} />
              )
            ) : null}
            {book.finishedAt ? (
              onOpenReadDetails ? (
                <button
                  type="button"
                  onClick={() => onOpenReadDetails(book)}
                  title="Click to edit date finished"
                  className="font-serif text-[14px] italic text-ink-muted decoration-claret/50 underline-offset-4 transition-colors hover:text-claret hover:underline"
                >
                  Finished{' '}
                  {formatReleaseDate(
                    book.finishedAt,
                    book.finishedAt.length === 4
                      ? 'year'
                      : book.finishedAt.length === 7
                      ? 'month'
                      : 'day'
                  )}
                </button>
              ) : (
                <span className="font-serif text-[14px] italic text-ink-muted">
                  Finished{' '}
                  {formatReleaseDate(
                    book.finishedAt,
                    book.finishedAt.length === 4
                      ? 'year'
                      : book.finishedAt.length === 7
                      ? 'month'
                      : 'day'
                  )}
                </span>
              )
            ) : onOpenReadDetails ? (
              <button
                type="button"
                onClick={() => onOpenReadDetails(book)}
                className="font-serif text-[13.5px] italic text-ink-faint decoration-claret/50 underline-offset-4 transition-colors hover:text-claret hover:underline"
              >
                No finish date · Set date
              </button>
            ) : null}
          </div>
        )}

        {isRead && book.notes && (
          <p className="mt-2 border-l border-claret/40 pl-3 font-serif text-[14.5px] italic leading-snug text-ink-soft line-clamp-2">
            {book.notes}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-3">
          <button
            type="button"
            onClick={() => onToggleTodo(book)}
            data-active={isTodo}
            className="entry-action"
          >
            {isTodo ? (
              <BookmarkCheck strokeWidth={1.5} className="h-3.5 w-3.5 fill-claret/15" />
            ) : (
              <Bookmark strokeWidth={1.5} className="h-3.5 w-3.5" />
            )}
            {isTodo ? 'On your list' : timing === 'upcoming' ? 'Want to read' : 'Add to list'}
          </button>

          {timing === 'released' && (
            <button
              type="button"
              onClick={() => onToggleRead(book)}
              data-active={isRead}
              className="entry-action"
            >
              <Check strokeWidth={isRead ? 2 : 1.5} className="h-3.5 w-3.5" />
              {isRead ? 'Read' : 'Mark as read'}
            </button>
          )}

          {isRead && onOpenReadDetails && (
            <button
              type="button"
              onClick={() => onOpenReadDetails(book)}
              className="entry-action"
            >
              <PenLine strokeWidth={1.5} className="h-3.5 w-3.5" />
              {book.finishedAt || book.rating || book.notes
                ? 'Edit date & log'
                : 'Set date & rate'}
            </button>
          )}

          {(book.vellumBookId || (book.vellumProgress && book.vellumProgress > 0)) &&
            canOpenVellumWebUrl(vellumUrl) && (
              <a
                href={`${vellumUrl.replace(/\/+$/, '')}/?book=${encodeURIComponent(
                  book.vellumBookId || book.title
                )}`}
                target="_blank"
                rel="noreferrer"
                className="entry-action"
              >
                <BookOpen strokeWidth={1.5} className="h-3.5 w-3.5" />
                {book.vellumProgress && book.vellumProgress > 0 && !isRead
                  ? 'Continue in Vellum'
                  : 'Open in Vellum'}
              </a>
            )}
        </div>
      </div>
    </article>
  );
}
