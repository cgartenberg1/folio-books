import {
  addDays,
  differenceInCalendarDays,
  endOfWeek,
  format,
  isSameYear,
  parseISO,
  startOfWeek,
} from 'date-fns';
import { BookItem, DatePrecision } from '@/types/books';

export interface WeekBucket {
  key: string;
  sortOrder: string;
  label: string;
  sublabel?: string;
  badge?: string;
  isCurrentWeek?: boolean;
  isNextWeek?: boolean;
  isTBA?: boolean;
  books: BookItem[];
}

export function getLocalTodayStr(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseReleaseDateInput(
  raw?: string | number | null,
  fallbackYear?: number | null
): { releaseDate?: string; datePrecision: DatePrecision } {
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const trimmed = String(raw).trim();

    // Full ISO date YYYY-MM-DD (or timestamp starting with YYYY-MM-DD)
    const fullMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (fullMatch) {
      const [, y, m, d] = fullMatch;
      const monthNum = Number(m);
      const dayNum = Number(d);
      if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
        return { releaseDate: `${y}-${m}-${d}`, datePrecision: 'day' };
      }
    }

    // Year-month YYYY-MM
    const monthMatch = trimmed.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
      const [, y, m] = monthMatch;
      const monthNum = Number(m);
      if (monthNum >= 1 && monthNum <= 12) {
        return { releaseDate: `${y}-${m}`, datePrecision: 'month' };
      }
    }

    // Year only YYYY
    const yearMatch = trimmed.match(/^(\d{4})$/);
    if (yearMatch) {
      return { releaseDate: yearMatch[1], datePrecision: 'year' };
    }

    // Natural date string fallback (e.g., "Nov 17, 2026")
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime()) && trimmed.length > 4) {
      return {
        releaseDate: format(parsed, 'yyyy-MM-dd'),
        datePrecision: 'day',
      };
    }
  }

  if (fallbackYear && fallbackYear >= 1000 && fallbackYear <= 2999) {
    return { releaseDate: String(fallbackYear), datePrecision: 'year' };
  }

  return { releaseDate: undefined, datePrecision: 'unknown' };
}

export function classifyReleaseTiming(
  book: Pick<BookItem, 'releaseDate' | 'datePrecision'>,
  todayStr: string
): 'upcoming' | 'released' {
  const { releaseDate, datePrecision } = book;
  if (!releaseDate || datePrecision === 'unknown') {
    return 'upcoming';
  }

  if (datePrecision === 'day') {
    return releaseDate > todayStr ? 'upcoming' : 'released';
  }

  if (datePrecision === 'month') {
    const currentYearMonth = todayStr.slice(0, 7);
    return releaseDate > currentYearMonth ? 'upcoming' : 'released';
  }

  if (datePrecision === 'year') {
    const currentYear = Number(todayStr.slice(0, 4));
    return Number(releaseDate) > currentYear ? 'upcoming' : 'released';
  }

  return 'released';
}

export function formatReleaseDate(
  releaseDate?: string,
  datePrecision?: DatePrecision
): string {
  if (!releaseDate || datePrecision === 'unknown') {
    return 'Date TBA';
  }

  if (datePrecision === 'year' || releaseDate.length === 4) {
    return releaseDate;
  }

  if (datePrecision === 'month' || releaseDate.length === 7) {
    const parsed = parseISO(`${releaseDate}-01`);
    if (!Number.isNaN(parsed.getTime())) {
      return format(parsed, 'MMMM yyyy');
    }
    return releaseDate;
  }

  const parsed = parseISO(releaseDate);
  if (!Number.isNaN(parsed.getTime())) {
    return format(parsed, 'MMM d, yyyy');
  }
  return releaseDate;
}

export function getRelativeReleaseLabel(
  releaseDate?: string,
  datePrecision?: DatePrecision,
  todayStr: string = getLocalTodayStr()
): string | null {
  if (!releaseDate || datePrecision !== 'day') {
    return null;
  }

  const target = parseISO(releaseDate);
  const today = parseISO(todayStr);
  if (Number.isNaN(target.getTime()) || Number.isNaN(today.getTime())) {
    return null;
  }

  const diffDays = differenceInCalendarDays(target, today);
  if (diffDays === 0) return 'Out today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays > 1 && diffDays <= 14) return `In ${diffDays} days`;
  if (diffDays > 14 && diffDays <= 60) {
    const weeks = Math.round(diffDays / 7);
    return `In ~${weeks} wks`;
  }
  if (diffDays < 0 && diffDays >= -7) {
    return diffDays === -1 ? 'Yesterday' : `${Math.abs(diffDays)}d ago`;
  }
  return null;
}

export function groupUpcomingBooksByWeek(
  books: BookItem[],
  todayStr: string = getLocalTodayStr()
): WeekBucket[] {
  const today = parseISO(todayStr);
  const currentWeekStart = startOfWeek(today, { weekStartsOn: 1 });
  const nextWeekStart = addDays(currentWeekStart, 7);
  const currentWeekKey = format(currentWeekStart, 'yyyy-MM-dd');
  const nextWeekKey = format(nextWeekStart, 'yyyy-MM-dd');

  const bucketMap = new Map<string, WeekBucket>();

  for (const book of books) {
    if (book.datePrecision === 'day' && book.releaseDate) {
      const date = parseISO(book.releaseDate);
      if (!Number.isNaN(date.getTime())) {
        const weekStart = startOfWeek(date, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(date, { weekStartsOn: 1 });
        const weekKey = format(weekStart, 'yyyy-MM-dd');
        const isCurrent = weekKey === currentWeekKey;
        const isNext = weekKey === nextWeekKey;

        const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
        const sameYearWithToday = isSameYear(weekEnd, today);
        const rangeStr = sameMonth
          ? `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'd')}${
              sameYearWithToday ? '' : `, ${format(weekEnd, 'yyyy')}`
            }`
          : `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d')}${
              sameYearWithToday ? '' : `, ${format(weekEnd, 'yyyy')}`
            }`;

        let label = `Week of ${rangeStr}`;
        let badge: string | undefined;
        if (isCurrent) {
          label = `This Week · ${rangeStr}`;
          badge = 'This Week';
        } else if (isNext) {
          label = `Next Week · ${rangeStr}`;
          badge = 'Next Week';
        }

        if (!bucketMap.has(weekKey)) {
          bucketMap.set(weekKey, {
            key: `week:${weekKey}`,
            sortOrder: `1:${weekKey}`,
            label,
            badge,
            isCurrentWeek: isCurrent,
            isNextWeek: isNext,
            books: [],
          });
        }
        bucketMap.get(weekKey)!.books.push(book);
        continue;
      }
    }

    if (book.datePrecision === 'month' && book.releaseDate) {
      const monthKey = book.releaseDate;
      const parsedMonth = parseISO(`${monthKey}-01`);
      const monthLabel = !Number.isNaN(parsedMonth.getTime())
        ? `${format(parsedMonth, 'MMMM yyyy')} · Exact Week TBA`
        : `${monthKey} · Exact Week TBA`;

      if (!bucketMap.has(`month:${monthKey}`)) {
        bucketMap.set(`month:${monthKey}`, {
          key: `month:${monthKey}`,
          sortOrder: `1:${monthKey}-99`,
          label: monthLabel,
          isTBA: true,
          books: [],
        });
      }
      bucketMap.get(`month:${monthKey}`)!.books.push(book);
      continue;
    }

    if (book.datePrecision === 'year' && book.releaseDate) {
      const yearKey = book.releaseDate;
      if (!bucketMap.has(`year:${yearKey}`)) {
        bucketMap.set(`year:${yearKey}`, {
          key: `year:${yearKey}`,
          sortOrder: `2:${yearKey}`,
          label: `Expected in ${yearKey} · Date TBA`,
          isTBA: true,
          books: [],
        });
      }
      bucketMap.get(`year:${yearKey}`)!.books.push(book);
      continue;
    }

    if (!bucketMap.has('tba')) {
      bucketMap.set('tba', {
        key: 'tba',
        sortOrder: '3:9999',
        label: 'Announced · Release Date TBA',
        isTBA: true,
        books: [],
      });
    }
    bucketMap.get('tba')!.books.push(book);
  }

  const buckets = Array.from(bucketMap.values()).sort((a, b) =>
    a.sortOrder.localeCompare(b.sortOrder)
  );

  for (const bucket of buckets) {
    bucket.books.sort((a, b) => {
      const dateA = a.releaseDate || '9999-99-99';
      const dateB = b.releaseDate || '9999-99-99';
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return a.title.localeCompare(b.title);
    });
  }

  return buckets;
}

export function getSortableReleaseKey(book: Pick<BookItem, 'releaseDate' | 'datePrecision'>): string {
  if (!book.releaseDate || book.datePrecision === 'unknown') {
    return '0000-00-00';
  }
  if (book.datePrecision === 'day') return book.releaseDate;
  if (book.datePrecision === 'month') return `${book.releaseDate}-01`;
  if (book.datePrecision === 'year') return `${book.releaseDate}-01-01`;
  return book.releaseDate;
}

export function sortReleasedBooksReverseChronological(books: BookItem[]): BookItem[] {
  return [...books].sort((a, b) => {
    const keyA = getSortableReleaseKey(a);
    const keyB = getSortableReleaseKey(b);
    if (keyA !== keyB) {
      return keyB.localeCompare(keyA);
    }
    return a.title.localeCompare(b.title);
  });
}
