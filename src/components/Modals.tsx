'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  ImagePlus,
  KeyRound,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { BookCover } from '@/components/BookCover';
import {
  CloudConnectionConfig,
  fetchOrRotateVellumBridgeToken,
} from '@/lib/cloudSync';
import {
  compressUploadedCoverImage,
  isCustomCoverUrl,
  markCustomCoverUrl,
  stripCustomCoverMarker,
} from '@/lib/coverArt';
import { parseReleaseDateInput } from '@/lib/dates';
import { canOpenVellumWebUrl } from '@/lib/vellumBridge';
import {
  AppSettings,
  BookItem,
  FollowedAuthor,
  ReadingChallenge,
  ReadingStatus,
  TrackerState,
} from '@/types/books';

interface ModalShellProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}

function ModalShell({ title, subtitle, onClose, children }: ModalShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(20_14_8/0.45)] p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative max-h-[92vh] w-full animate-fade-up overflow-y-auto border border-rule bg-paper shadow-2xl sm:max-w-lg"
      >
        <div className="sticky top-0 z-10 bg-paper/95 px-6 pt-6 backdrop-blur-sm sm:px-8 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-[30px] font-medium leading-tight text-ink">
                {title}
              </h2>
              {subtitle && (
                <p className="mt-1 font-serif text-[15px] italic leading-snug text-ink-muted">
                  {subtitle}
                </p>
              )}
            </div>
            <button type="button" onClick={onClose} title="Close" className="icon-btn -mr-2 -mt-1">
              <X strokeWidth={1.5} className="h-5 w-5" />
            </button>
          </div>
          <div className="rule-double mt-5" />
        </div>
        <div className="px-6 pb-6 pt-5 sm:px-8 sm:pb-8">{children}</div>
      </div>
    </div>
  );
}

interface BookFormModalProps {
  initialBook?: BookItem | null;
  authors: FollowedAuthor[];
  todayStr: string;
  defaultAuthorId?: string;
  hardcoverToken?: string;
  onClose: () => void;
  onSave: (bookData: {
    id?: string;
    title: string;
    authorName: string;
    authorId?: string;
    releaseDateInput: string;
    coverUrl?: string;
    isOneOff: boolean;
    readingStatus: ReadingStatus;
    finishedAt?: string;
  }) => void;
}

interface CoverCandidateItem {
  url: string;
  label: string;
  source: string;
}

export function BookFormModal({
  initialBook,
  authors,
  todayStr,
  defaultAuthorId,
  hardcoverToken,
  onClose,
  onSave,
}: BookFormModalProps) {
  const [title, setTitle] = useState(initialBook?.title || '');
  const [selectedAuthorId, setSelectedAuthorId] = useState<string>(
    initialBook?.authorId || defaultAuthorId || ''
  );
  const [authorName, setAuthorName] = useState(() => {
    if (initialBook?.authorName) return initialBook.authorName;
    if (defaultAuthorId) {
      return authors.find((a) => a.id === defaultAuthorId)?.name || '';
    }
    return '';
  });
  const [releaseDateInput, setReleaseDateInput] = useState(
    initialBook?.releaseDate || ''
  );
  const [coverUrl, setCoverUrl] = useState(initialBook?.coverUrl || '');
  const [coverTouched, setCoverTouched] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [isDraggingCover, setIsDraggingCover] = useState(false);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [coverCandidates, setCoverCandidates] = useState<CoverCandidateItem[]>([]);
  const [failedCandidateUrls, setFailedCandidateUrls] = useState<Set<string>>(
    () => new Set()
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [readingStatus, setReadingStatus] = useState<ReadingStatus>(
    initialBook?.readingStatus || 'none'
  );
  const [finishedAt, setFinishedAt] = useState(
    initialBook?.finishedAt || todayStr
  );

  useEffect(() => {
    if (selectedAuthorId) {
      const matched = authors.find((a) => a.id === selectedAuthorId);
      if (matched) setAuthorName(matched.name);
    }
  }, [selectedAuthorId, authors]);

  const handleImportCoverBlob = async (blob: Blob) => {
    setCoverError(null);
    setIsUploadingCover(true);
    try {
      const compressedDataUrl = await compressUploadedCoverImage(blob);
      setCoverUrl(compressedDataUrl);
      setCoverTouched(true);
    } catch (err) {
      setCoverError(
        err instanceof Error ? err.message : 'Could not import cover image.'
      );
    } finally {
      setIsUploadingCover(false);
    }
  };

  const handleBrowseCovers = async () => {
    if (!title.trim() || isLoadingCandidates) return;
    setCoverError(null);
    setIsLoadingCandidates(true);
    try {
      const params = new URLSearchParams({
        title: title.trim(),
        author: authorName.trim(),
      });
      if (initialBook?.isbn) params.set('isbn', initialBook.isbn);
      if (initialBook?.externalId) params.set('externalId', initialBook.externalId);
      if (initialBook?.source) params.set('source', initialBook.source);

      const headers: Record<string, string> = {};
      if (hardcoverToken?.trim()) {
        headers['x-hardcover-token'] = hardcoverToken.trim();
      }

      const res = await fetch(`/api/books/covers?${params.toString()}`, {
        headers,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not search cover editions');
      }
      setCoverCandidates(data.covers || []);
      setCandidatesLoaded(true);
    } catch (err) {
      setCoverError(
        err instanceof Error ? err.message : 'Could not search cover editions.'
      );
    } finally {
      setIsLoadingCandidates(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !authorName.trim()) return;

    const trimmedCover = coverUrl.trim();
    const resolvedCoverUrl = !trimmedCover
      ? undefined
      : coverTouched || !initialBook || isCustomCoverUrl(trimmedCover)
      ? markCustomCoverUrl(trimmedCover)
      : trimmedCover;

    onSave({
      id: initialBook?.id,
      title: title.trim(),
      authorName: authorName.trim(),
      authorId: selectedAuthorId || undefined,
      releaseDateInput: releaseDateInput.trim(),
      coverUrl: resolvedCoverUrl,
      isOneOff: selectedAuthorId ? Boolean(initialBook?.isOneOff) : true,
      readingStatus,
      finishedAt: readingStatus === 'read' ? finishedAt || undefined : undefined,
    });
  };

  const parsedPreview = parseReleaseDateInput(releaseDateInput);
  const isUploadedDataUrl = coverUrl.trim().startsWith('data:image/');
  const cleanUrlInputValue = isUploadedDataUrl
    ? ''
    : stripCustomCoverMarker(coverUrl) || '';
  const visibleCandidates = coverCandidates.filter(
    (c) => !failedCandidateUrls.has(c.url)
  );

  return (
    <ModalShell
      title={initialBook ? 'Edit details' : 'Add a book by hand'}
      subtitle={
        initialBook
          ? 'Correct the date, swap or import cover artwork, or update your list'
          : 'For announced titles the catalogues haven’t caught up with yet'
      }
      onClose={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData?.items || []);
          const imageItem = items.find((item) => item.type.startsWith('image/'));
          if (imageItem) {
            const blob = imageItem.getAsFile();
            if (blob) {
              e.preventDefault();
              void handleImportCoverBlob(blob);
            }
          }
        }}
        className="space-y-4"
      >
        <div>
          <label className="field-label">
            Title
          </label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Winds of Winter"
            className="field"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="field-label">
              Link to Followed Author
            </label>
            <select
              value={selectedAuthorId}
              onChange={(e) => setSelectedAuthorId(e.target.value)}
              className="field"
            >
              <option value="">One-off title (don&apos;t follow author)</option>
              {authors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label">
              Author Name *
            </label>
            <input
              type="text"
              required
              value={authorName}
              onChange={(e) => {
                setAuthorName(e.target.value);
                if (selectedAuthorId) {
                  const current = authors.find((a) => a.id === selectedAuthorId);
                  if (current && current.name !== e.target.value) {
                    setSelectedAuthorId('');
                  }
                }
              }}
              placeholder="e.g., George R.R. Martin"
              className="field"
            />
          </div>
        </div>

        <div>
          <label className="field-label">
            Release date · day, month, or year; blank if unannounced
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={releaseDateInput}
              onChange={(e) => setReleaseDateInput(e.target.value)}
              placeholder="e.g., 2026-11-24 or 2027"
              className="field flex-1"
            />
            <input
              type="date"
              aria-label="Pick exact date"
              value={
                parsedPreview.datePrecision === 'day'
                  ? parsedPreview.releaseDate || ''
                  : ''
              }
              onChange={(e) => setReleaseDateInput(e.target.value)}
              className="field w-40"
            />
          </div>
        </div>

        {/* Cover Artwork Studio: upload/drop/paste custom art, browse flat editions, or paste URL */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingCover(true);
          }}
          onDragLeave={() => setIsDraggingCover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingCover(false);
            const droppedFile = e.dataTransfer?.files?.[0];
            if (droppedFile) {
              void handleImportCoverBlob(droppedFile);
            }
          }}
          className={`panel p-3.5 transition-colors ${
            isDraggingCover ? 'border-claret bg-claret-wash/30' : ''
          }`}
        >
          <div className="flex items-start gap-4">
            <BookCover
              title={title || 'Untitled'}
              authorName={authorName || 'Author'}
              coverUrl={coverUrl || undefined}
              size="lg"
            />

            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="caps text-ink-muted">Cover artwork</label>
                {(isUploadedDataUrl || isCustomCoverUrl(coverUrl)) && (
                  <span className="tag tag-claret">Custom cover</span>
                )}
              </div>

              <p className="font-serif text-[13.5px] italic leading-snug text-ink-muted">
                Upload or drop an image file, paste an image from your clipboard, or pick a flat head-on edition below.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    void handleImportCoverBlob(file);
                  }
                  e.target.value = '';
                }}
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isUploadingCover}
                  onClick={() => fileInputRef.current?.click()}
                  className="btn btn-outline btn-sm"
                >
                  <ImagePlus strokeWidth={1.5} className="h-3.5 w-3.5" />
                  {isUploadingCover ? 'Importing…' : 'Upload image'}
                </button>

                <button
                  type="button"
                  disabled={!title.trim() || isLoadingCandidates}
                  onClick={handleBrowseCovers}
                  className="btn btn-outline btn-sm"
                >
                  {isLoadingCandidates ? (
                    <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search strokeWidth={1.5} className="h-3.5 w-3.5" />
                  )}
                  {isLoadingCandidates ? 'Searching…' : 'Browse flat covers'}
                </button>

                {coverUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      setCoverUrl('');
                      setCoverTouched(true);
                      setCoverError(null);
                    }}
                    title="Remove cover image"
                    className="btn btn-ghost btn-sm"
                  >
                    <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" />
                    Clear
                  </button>
                )}
              </div>

              <div>
                <input
                  type="text"
                  value={cleanUrlInputValue}
                  onChange={(e) => {
                    setCoverUrl(e.target.value);
                    setCoverTouched(true);
                    setCoverError(null);
                  }}
                  placeholder={
                    isUploadedDataUrl
                      ? 'Uploaded image active — paste https:// URL to replace'
                      : 'Or paste image URL (https://...)'
                  }
                  className="field field-sm text-[13.5px]"
                />
              </div>

              {coverError && (
                <p className="font-serif text-[13px] italic text-claret">
                  {coverError}
                </p>
              )}
            </div>
          </div>

          {candidatesLoaded && (
            <div className="mt-3.5 border-t border-rule pt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="caps-sm text-ink-muted">
                  {visibleCandidates.length > 0
                    ? 'Select an edition cover'
                    : 'No alternative covers found in catalogues'}
                </span>
              </div>
              {visibleCandidates.length > 0 && (
                <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-6">
                  {visibleCandidates.map((cand) => {
                    const isSelected =
                      stripCustomCoverMarker(coverUrl) ===
                      stripCustomCoverMarker(cand.url);
                    return (
                      <button
                        key={cand.url}
                        type="button"
                        onClick={() => {
                          setCoverUrl(markCustomCoverUrl(cand.url) || cand.url);
                          setCoverTouched(true);
                          setCoverError(null);
                        }}
                        className={`group flex flex-col items-center rounded-[2px] border p-1 text-center transition-colors ${
                          isSelected
                            ? 'border-claret bg-claret-wash/35 ring-1 ring-claret'
                            : 'border-rule bg-paper hover:border-ink-muted'
                        }`}
                      >
                        <div className="relative aspect-[2/3] w-full overflow-hidden rounded-[1px] bg-paper-sunken">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={cand.url}
                            alt={cand.label}
                            loading="lazy"
                            onLoad={(e) => {
                              if (
                                e.currentTarget.naturalWidth < 10 ||
                                e.currentTarget.naturalHeight < 10
                              ) {
                                setFailedCandidateUrls((prev) => {
                                  const next = new Set(prev);
                                  next.add(cand.url);
                                  return next;
                                });
                              }
                            }}
                            onError={() => {
                              setFailedCandidateUrls((prev) => {
                                const next = new Set(prev);
                                next.add(cand.url);
                                return next;
                              });
                            }}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <span className="mt-1 line-clamp-1 font-sans text-[9.5px] leading-tight text-ink-muted group-hover:text-ink">
                          {cand.label.replace(/^Hardcover · /, '')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="field-label">
              Reading Status
            </label>
            <select
              value={readingStatus}
              onChange={(e) => setReadingStatus(e.target.value as ReadingStatus)}
              className="field"
            >
              <option value="none">Not on reading list</option>
              <option value="todo">To-Do List (Want to Read)</option>
              <option value="read">Already Read</option>
            </select>
          </div>

          {readingStatus === 'read' && (
            <div>
              <label className="field-label">
                Date Finished (For Challenges)
              </label>
              <input
                type="date"
                value={finishedAt}
                onChange={(e) => setFinishedAt(e.target.value)}
                className="field"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-5 border-t border-rule">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isUploadingCover}
            className="btn btn-primary"
          >
            {initialBook ? 'Save changes' : 'Add to ledger'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface AuthorFormModalProps {
  onClose: () => void;
  onSave: (data: {
    name: string;
    imageUrl?: string;
    bio?: string;
    autoFetchCatalog: boolean;
  }) => void;
}

export function AuthorFormModal({ onClose, onSave }: AuthorFormModalProps) {
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [bio, setBio] = useState('');
  const [autoFetchCatalog, setAutoFetchCatalog] = useState(true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      imageUrl: imageUrl.trim() || undefined,
      bio: bio.trim() || undefined,
      autoFetchCatalog,
    });
  };

  return (
    <ModalShell
      title="Add an author by hand"
      subtitle="For small-press and self-published writers the catalogues miss"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="field-label">
            Author Name *
          </label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Naomi Novik"
            className="field"
          />
        </div>

        <div>
          <label className="field-label">
            Photo URL (Optional)
          </label>
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://..."
            className="field"
          />
        </div>

        <div>
          <label className="field-label">
            Notes / Genre (Optional)
          </label>
          <input
            type="text"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="e.g., Fantasy & sci-fi novelist"
            className="field"
          />
        </div>

        <label className="panel flex cursor-pointer items-start gap-3 p-3.5">
          <input
            type="checkbox"
            checked={autoFetchCatalog}
            onChange={(e) => setAutoFetchCatalog(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 border-rule-strong accent-[rgb(var(--claret))]"
          />
          <span className="font-serif text-[14.5px] leading-snug text-ink-soft">
            <strong className="block font-sans text-[12.5px] font-medium text-ink">
              Check catalogues for published &amp; forthcoming books
            </strong>
            Automatically pull matching English editions from Hardcover and Google Books. Uncheck for a strictly manual entry.
          </span>
        </label>

        <div className="flex justify-end gap-2 pt-5 border-t border-rule">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            Follow Author
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface ReadLogModalProps {
  book: BookItem;
  todayStr: string;
  onClose: () => void;
  onSave: (updates: {
    finishedAt?: string;
    rating?: number;
    notes?: string;
  }) => void;
}

export function ReadLogModal({
  book,
  todayStr,
  onClose,
  onSave,
}: ReadLogModalProps) {
  const [hasFinishDate, setHasFinishDate] = useState<boolean>(
    book.finishedAt !== undefined ? Boolean(book.finishedAt) : true
  );
  const [finishedAt, setFinishedAt] = useState(book.finishedAt || todayStr);
  const [rating, setRating] = useState<number>(book.rating || 0);
  const [notes, setNotes] = useState(book.notes || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      finishedAt: hasFinishDate && finishedAt ? finishedAt : undefined,
      rating: rating > 0 ? rating : undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <ModalShell
      title="Notes on a book"
      subtitle={`${book.title} · ${book.authorName}`}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <label className="field-label">
            When did you finish it?
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setHasFinishDate(true);
                if (!finishedAt) setFinishedAt(todayStr);
              }}
              className={`border px-3 py-2 font-sans text-[12px] font-medium transition-colors ${
                hasFinishDate
                  ? 'border-claret bg-claret-wash text-claret'
                  : 'border-rule bg-paper-raised text-ink-muted hover:border-ink hover:text-ink'
              }`}
            >
              Count for Year Challenge
            </button>
            <button
              type="button"
              onClick={() => setHasFinishDate(false)}
              className={`border px-3 py-2 font-sans text-[12px] font-medium transition-colors ${
                !hasFinishDate
                  ? 'border-claret bg-claret-wash text-claret'
                  : 'border-rule bg-paper-raised text-ink-muted hover:border-ink hover:text-ink'
              }`}
            >
              Read Earlier (No Date)
            </button>
          </div>

          {hasFinishDate && (
            <input
              type="date"
              value={finishedAt}
              onChange={(e) => setFinishedAt(e.target.value)}
              className="field mt-2"
            />
          )}
        </div>

        <div>
          <label className="field-label">
            Your Rating
          </label>
          <div className="mt-1.5 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(rating === star ? 0 : star)}
                className="p-1.5 transition-colors hover:bg-paper-raised"
              >
                <Star
                  strokeWidth={1.25}
                  className={`h-5 w-5 ${
                    star <= rating
                      ? 'fill-claret text-claret'
                      : 'text-rule-strong hover:text-ink-muted'
                  }`}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="ml-2 font-serif text-[14px] italic text-ink-muted">
                {rating} of 5
              </span>
            )}
          </div>
        </div>

        <div>
          <label className="field-label">
            Notes / Thoughts (Optional)
          </label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Favorite moments, quotes, or review..."
            className="field"
          />
        </div>

        <div className="flex justify-end gap-2 pt-5 border-t border-rule">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            Save Log
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface ChallengeModalProps {
  year: number;
  existing?: ReadingChallenge;
  onClose: () => void;
  onSave: (data: { year: number; goalCount: number; title: string }) => void;
}

export function ChallengeModal({
  year: initialYear,
  existing,
  onClose,
  onSave,
}: ChallengeModalProps) {
  const [year, setYear] = useState<number>(existing?.year || initialYear);
  const [goalCount, setGoalCount] = useState<number>(existing?.goalCount || 24);
  const [title, setTitle] = useState<string>(
    existing?.title || `${existing?.year || initialYear} Reading Challenge`
  );

  const presets = [12, 24, 36, 52, 75, 100];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (goalCount < 1) return;
    onSave({
      year,
      goalCount,
      title: title.trim() || `${year} Reading Challenge`,
    });
  };

  return (
    <ModalShell
      title={existing ? 'Revise the challenge' : 'A challenge for the year'}
      subtitle="Choose a number; every book you finish fills a spine on the shelf"
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">
              Challenge Year
            </label>
            <input
              type="number"
              min={2000}
              max={2100}
              disabled={Boolean(existing)}
              value={year}
              onChange={(e) => {
                const nextYear = Number(e.target.value);
                setYear(nextYear);
                if (title.endsWith('Reading Challenge')) {
                  setTitle(`${nextYear} Reading Challenge`);
                }
              }}
              className="field"
            />
          </div>

          <div>
            <label className="field-label">
              Target Books *
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              required
              value={goalCount}
              onChange={(e) => setGoalCount(Math.max(1, Number(e.target.value)))}
              className="field"
            />
          </div>
        </div>

        <div>
          <span className="field-label">
            Quick Goal Presets
          </span>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setGoalCount(p)}
                className={`border px-3 py-1.5 font-sans text-[12px] font-medium nums-lining transition-colors ${
                  goalCount === p
                    ? 'border-ink bg-ink text-paper'
                    : 'border-rule bg-paper-raised text-ink-soft hover:border-ink hover:text-ink'
                }`}
              >
                {p} books
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="field-label">
            Challenge Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="field"
          />
        </div>

        <div className="flex justify-end gap-2 pt-5 border-t border-rule">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            Save Challenge
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface SettingsModalProps {
  settings: AppSettings;
  serverStatus: {
    hasServerHardcoverKey: boolean;
    hasServerGoogleKey: boolean;
    hasServerSupabase: boolean;
    hasBridgeTokenEnv?: boolean;
    isHostedCloud?: boolean;
  };
  cloudConfig?: CloudConnectionConfig | null;
  authUserId?: string | null;
  cloudSyncStatus: 'local' | 'syncing' | 'synced' | 'error';
  cloudSyncError?: string;
  authEmail?: string;
  userDisplayName?: string;
  lastVellumSyncAt?: string;
  stateSnapshot: TrackerState;
  onClose: () => void;
  onSaveSettings: (next: AppSettings) => void;
  onTriggerCloudSync: () => void;
  onGoToFriendsSignIn: () => void;
  onImportState: (imported: TrackerState) => void;
}

export function SettingsModal({
  settings,
  serverStatus,
  cloudConfig,
  authUserId,
  cloudSyncStatus,
  cloudSyncError,
  authEmail,
  userDisplayName,
  lastVellumSyncAt,
  stateSnapshot,
  onClose,
  onSaveSettings,
  onTriggerCloudSync,
  onGoToFriendsSignIn,
  onImportState,
}: SettingsModalProps) {
  const [hardcoverToken, setHardcoverToken] = useState(settings.hardcoverToken);
  const [supabaseUrl, setSupabaseUrl] = useState(settings.supabaseUrl);
  const [supabaseAnonKey, setSupabaseAnonKey] = useState(settings.supabaseAnonKey);
  const [vellumUrl, setVellumUrl] = useState(settings.vellumUrl || 'http://localhost:3030');
  const [savedNotice, setSavedNotice] = useState(false);

  const [folioOrigin, setFolioOrigin] = useState('http://localhost:3000');
  const [bridgeToken, setBridgeToken] = useState<string>('');
  const [bridgeTokenLoading, setBridgeTokenLoading] = useState(false);
  const [bridgeTokenError, setBridgeTokenError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<'url' | 'token' | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setFolioOrigin(window.location.origin);
    }
  }, []);

  useEffect(() => {
    if (!cloudConfig || !authUserId) {
      setBridgeToken('');
      setBridgeTokenError(null);
      return;
    }
    let cancelled = false;
    setBridgeTokenLoading(true);
    setBridgeTokenError(null);
    fetchOrRotateVellumBridgeToken(cloudConfig, false)
      .then((tok) => {
        if (!cancelled) setBridgeToken(tok);
      })
      .catch((err) => {
        if (!cancelled) {
          setBridgeTokenError(
            err instanceof Error
              ? err.message
              : 'Re-run supabase/schema.sql to enable personal Vellum bridge tokens.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBridgeTokenLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudConfig, authUserId]);

  const handleCopyText = (field: 'url' | 'token', value: string) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((cur) => (cur === field ? null : cur));
    }, 1800);
  };

  const handleRotateBridgeToken = async () => {
    if (!cloudConfig || !authUserId) return;
    setBridgeTokenLoading(true);
    setBridgeTokenError(null);
    try {
      const nextTok = await fetchOrRotateVellumBridgeToken(cloudConfig, true);
      setBridgeToken(nextTok);
    } catch (err) {
      setBridgeTokenError(
        err instanceof Error ? err.message : 'Could not rotate bridge token'
      );
    } finally {
      setBridgeTokenLoading(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      hardcoverToken: hardcoverToken.trim(),
      supabaseUrl: supabaseUrl.trim(),
      supabaseAnonKey: supabaseAnonKey.trim(),
      vellumUrl: vellumUrl.trim() || 'http://localhost:3030',
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(stateSnapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `folio-books-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (
          Array.isArray(parsed.authors) &&
          Array.isArray(parsed.books) &&
          Array.isArray(parsed.challenges)
        ) {
          onImportState(parsed as TrackerState);
          onClose();
        }
      } catch {
        alert('Invalid backup JSON file.');
      }
    };
    reader.readAsText(file);
  };

  const hardcoverActive =
    serverStatus.hasServerHardcoverKey || Boolean(hardcoverToken.trim());
  const supabaseActive =
    serverStatus.hasServerSupabase ||
    Boolean(supabaseUrl.trim() && supabaseAnonKey.trim());

  return (
    <ModalShell
      title="Settings"
      subtitle="Catalogue sources, accounts, and backups"
      onClose={onClose}
    >
      <form onSubmit={handleSave} className="space-y-5">
        {/* Hardcover Section */}
        <div className="panel space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound strokeWidth={1.5} className="h-4 w-4 text-claret" />
              <h3 className="caps text-ink">
                Hardcover Catalogue API
              </h3>
            </div>
            <span className={hardcoverActive ? 'tag tag-moss' : 'tag'}>
              {serverStatus.hasServerHardcoverKey
                ? 'Active · .env.local'
                : hardcoverToken.trim()
                ? 'Active · custom token'
                : 'Google Books fallback'}
            </span>
          </div>

          <p className="font-serif text-[14.5px] leading-relaxed text-ink-muted">
            Google Books and Open Library work out of the box with zero setup. Adding a free personal token from{' '}
            <a
              href="https://hardcover.app/account/api"
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              hardcover.app/account/api
            </a>{' '}
            unlocks cleaner author bibliographies and community-curated pre-order dates.
          </p>

          {!serverStatus.hasServerHardcoverKey && (
            <input
              type="password"
              value={hardcoverToken}
              onChange={(e) => setHardcoverToken(e.target.value)}
              placeholder="Paste Hardcover Bearer token (or set HARDCOVER_API_KEY in .env.local)"
              className="field field-sm"
            />
          )}
        </div>

        {/* Supabase Cloud Sync Section */}
        <div className="panel space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cloud strokeWidth={1.5} className="h-4 w-4 text-ink-muted" />
              <h3 className="caps text-ink">
                Cloud Sync &amp; Reading Circles
              </h3>
            </div>
            <span
              className={
                cloudSyncStatus === 'synced'
                  ? 'tag tag-moss'
                  : cloudSyncStatus === 'error'
                  ? 'tag tag-claret'
                  : 'tag'
              }
            >
              {cloudSyncStatus === 'synced'
                ? 'Cloud synced'
                : cloudSyncStatus === 'syncing'
                ? 'Syncing…'
                : cloudSyncStatus === 'error'
                ? 'Sync problem'
                : 'Local browser'}
            </span>
          </div>

          <p className="font-serif text-[14.5px] leading-relaxed text-ink-muted">
            Run{' '}
            <code className="border border-rule bg-paper px-1.5 py-0.5 font-mono text-[12px] text-ink">
              supabase/schema.sql
            </code>{' '}
            in your Supabase SQL Editor, then add your Project URL &amp; anon key below (or in{' '}
            <code className="border border-rule bg-paper px-1.5 py-0.5 font-mono text-[12px] text-ink">
              .env.local
            </code>
            ) to enable Magic Link sign-in, cross-device sync, and shared Reading Circles.
          </p>

          {cloudSyncError && (
            <p className="border border-claret/30 bg-claret-wash px-3 py-2 font-sans text-xs text-claret">
              {cloudSyncError}
            </p>
          )}

          {!serverStatus.hasServerSupabase && (
            <div className="space-y-2">
              <input
                type="url"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                placeholder="https://your-project.supabase.co"
                className="field field-sm"
              />
              <input
                type="password"
                value={supabaseAnonKey}
                onChange={(e) => setSupabaseAnonKey(e.target.value)}
                placeholder="Supabase anon public key"
                className="field field-sm"
              />
            </div>
          )}

          {supabaseActive && (
            <div className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-paper px-3.5 py-2.5">
              {authEmail || userDisplayName ? (
                <>
                  <div className="font-serif text-[14px] text-ink-soft">
                    Signed in as{' '}
                    <strong className="font-medium text-ink">
                      {userDisplayName || authEmail}
                    </strong>
                    {authEmail && userDisplayName ? ` (${authEmail})` : ''}
                  </div>
                  <button
                    type="button"
                    onClick={onTriggerCloudSync}
                    className="btn btn-outline btn-sm"
                  >
                    <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" />
                    Sync now
                  </button>
                </>
              ) : (
                <>
                  <span className="font-serif text-[14px] italic text-ink-muted">
                    Supabase connected — sign in via Magic Link to sync &amp; join circles.
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onSaveSettings({
                        hardcoverToken: hardcoverToken.trim(),
                        supabaseUrl: supabaseUrl.trim(),
                        supabaseAnonKey: supabaseAnonKey.trim(),
                      });
                      onClose();
                      onGoToFriendsSignIn();
                    }}
                    className="btn btn-primary btn-sm"
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Vellum Ebook Reader Companion Section */}
        <div className="panel space-y-3.5 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BookOpen strokeWidth={1.5} className="h-4 w-4 text-claret" />
              <h3 className="caps text-ink">
                Vellum Ebook Reader Link
              </h3>
            </div>
            <span className={lastVellumSyncAt ? 'tag tag-moss' : 'tag'}>
              {lastVellumSyncAt ? 'Linked · live sync' : 'Bridge ready'}
            </span>
          </div>

          <p className="font-serif text-[14.5px] leading-relaxed text-ink-muted">
            Paste these credentials into{' '}
            <strong className="font-medium text-ink">Vellum → Folio Link</strong> on iOS, iPadOS, Android, or web. Books finished in Vellum automatically count toward your yearly challenge and Reading Circle feed.
          </p>

          {/* 1. Folio Server URL to paste into Vellum */}
          <div>
            <label className="field-label">
              Folio URL · paste in Vellum
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={folioOrigin}
                className="field field-sm flex-1 font-mono text-[12px]"
              />
              <button
                type="button"
                onClick={() => handleCopyText('url', folioOrigin)}
                className="btn btn-outline btn-sm shrink-0"
              >
                {copiedField === 'url' ? (
                  <>
                    <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy strokeWidth={1.5} className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 2. Personal Bridge Token for Cloud / Mobile Sync */}
          {cloudConfig && authUserId ? (
            <div>
              <label className="field-label">
                Personal Bridge Token · paste in Vellum
              </label>
              {bridgeTokenError ? (
                <p className="mt-1 border border-claret/30 bg-claret-wash px-3 py-2 font-sans text-xs text-claret">
                  {bridgeTokenError}
                </p>
              ) : (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    readOnly
                    value={bridgeToken || (bridgeTokenLoading ? 'Generating…' : '')}
                    placeholder="Generating personal bridge token…"
                    className="field field-sm min-w-[180px] flex-1 font-mono text-[12px]"
                  />
                  <button
                    type="button"
                    disabled={!bridgeToken || bridgeTokenLoading}
                    onClick={() => handleCopyText('token', bridgeToken)}
                    className="btn btn-outline btn-sm shrink-0"
                  >
                    {copiedField === 'token' ? (
                      <>
                        <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy strokeWidth={1.5} className="h-3.5 w-3.5" />
                        Copy token
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={bridgeTokenLoading}
                    onClick={handleRotateBridgeToken}
                    title="Generate a new personal bridge token"
                    className="btn btn-ghost btn-sm shrink-0"
                  >
                    <RefreshCw
                      strokeWidth={1.5}
                      className={`h-3.5 w-3.5 ${bridgeTokenLoading ? 'animate-spin' : ''}`}
                    />
                    Rotate
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="border border-rule bg-paper px-3 py-2 font-serif text-[13.5px] italic text-ink-muted">
              {serverStatus.isHostedCloud
                ? 'Sign in via Cloud Sync above to generate your personal Bridge Token for Vellum on iPhone, iPad, or Android.'
                : 'On local desktop / LAN, Bridge Token can be left blank in Vellum. Once deployed to Vercel + Supabase, sign in to get a personal Bridge Token.'}
            </p>
          )}

          {/* 3. Desktop Vellum Web URL (optional deep link) */}
          <div className="border-t border-rule pt-3">
            <label className="field-label">
              Vellum Web URL · optional desktop shortcut
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                type="url"
                value={vellumUrl}
                onChange={(e) => setVellumUrl(e.target.value)}
                placeholder="http://localhost:3030"
                className="field field-sm min-w-[200px] flex-1"
              />
              {canOpenVellumWebUrl(vellumUrl) && (
                <a
                  href={vellumUrl.trim() || 'http://localhost:3030'}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-outline btn-sm"
                >
                  <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
                  Open Vellum
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Backup Export/Import */}
        <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <Database strokeWidth={1.5} className="h-4 w-4 text-ink-muted" />
            <span className="font-serif text-[14.5px] text-ink-soft">
              Ledger backup · {stateSnapshot.authors.length} authors, {stateSnapshot.books.length} books
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="btn btn-outline btn-sm"
            >
              <Download strokeWidth={1.5} className="h-3.5 w-3.5" />
              Export JSON
            </button>
            <label className="btn btn-outline btn-sm cursor-pointer">
              <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
              Restore
              <input
                type="file"
                accept="application/json"
                onChange={handleImportFile}
                className="hidden"
              />
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-5 border-t border-rule">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
          >
            Close
          </button>
          <button
            type="submit"
            className="btn btn-primary"
          >
            {savedNotice ? (
              <>
                <Check className="h-4 w-4" />
                Saved
              </>
            ) : (
              'Save Settings'
            )}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
