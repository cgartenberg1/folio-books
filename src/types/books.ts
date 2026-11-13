export type DataSource = 'hardcover' | 'google' | 'openlibrary' | 'manual';

export type ReadingStatus = 'none' | 'todo' | 'read';

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export type TabKey =
  | 'upcoming'
  | 'released'
  | 'reading'
  | 'friends'
  | 'authors'
  | 'search';

export interface FollowedAuthor {
  id: string;
  source: DataSource;
  externalId?: string;
  name: string;
  imageUrl?: string;
  bio?: string;
  followedAt: string;
  lastSyncedAt?: string;
  updatedAt: string;
}

export interface BookItem {
  id: string;
  source: DataSource;
  externalId?: string;
  title: string;
  authorName: string;
  authorId?: string;
  coverUrl?: string;
  releaseDate?: string;
  datePrecision: DatePrecision;
  description?: string;
  pageCount?: number;
  isbn?: string;
  /** Explicitly tracked standalone book without following all of the author's releases */
  isOneOff: boolean;
  /** Added manually by the user */
  isManual: boolean;
  /** Dismissed/hidden from feed so sync doesn't re-add unwanted editions */
  hidden?: boolean;
  readingStatus: ReadingStatus;
  addedToTodoAt?: string;
  /** YYYY-MM-DD when finished (used for yearly reading challenges) */
  finishedAt?: string;
  rating?: number;
  notes?: string;
  /** Linked Vellum ebook reader telemetry */
  vellumBookId?: string;
  vellumProgress?: number;
  vellumChapter?: string;
  vellumLastReadAt?: string;
  vellumFormat?: string;
  updatedAt: string;
}

export interface ReadingChallenge {
  id: string;
  year: number;
  goalCount: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchAuthorResult {
  id: string;
  source: DataSource;
  externalId: string;
  name: string;
  imageUrl?: string;
  bio?: string;
  topWork?: string;
  booksCount?: number;
}

export interface SearchBookResult {
  id: string;
  source: DataSource;
  externalId: string;
  title: string;
  authorName: string;
  authorExternalId?: string;
  authorSource?: DataSource;
  coverUrl?: string;
  releaseDate?: string;
  datePrecision: DatePrecision;
  description?: string;
  pageCount?: number;
  isbn?: string;
}

export interface AppSettings {
  hardcoverToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  workspaceKey?: string;
  vellumUrl?: string;
}

export interface TrackerState {
  authors: FollowedAuthor[];
  books: BookItem[];
  challenges: ReadingChallenge[];
}

export interface UserProfile {
  id: string;
  email?: string;
  displayName: string;
  avatarUrl?: string;
  shareActivity: boolean;
}

export interface FriendGroup {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
  createdAt: string;
  memberCount?: number;
}

export interface FriendChallengeStanding {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  isCurrentUser: boolean;
  shareActivity: boolean;
  year: number;
  goalCount?: number;
  challengeTitle?: string;
  booksReadCount: number;
  recentCovers: Array<{
    id: string;
    title: string;
    authorName: string;
    coverUrl?: string;
  }>;
}

export interface FriendFinishedFeedItem {
  bookId: string;
  userId: string;
  userDisplayName: string;
  userAvatarUrl?: string;
  isCurrentUser: boolean;
  source: DataSource;
  externalId?: string;
  title: string;
  authorName: string;
  coverUrl?: string;
  releaseDate?: string;
  datePrecision: DatePrecision;
  finishedAt?: string;
  rating?: number;
  notes?: string;
  updatedAt: string;
}
