'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookCheck,
  BookOpen,
  CalendarClock,
  Cloud,
  Feather,
  Moon,
  Search,
  Settings,
  Sun,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { AuthorsTab } from '@/components/AuthorsTab';
import { FriendsTab } from '@/components/FriendsTab';
import { ImportModal, ImportTabMode } from '@/components/ImportModal';
import {
  AuthorFormModal,
  BookFormModal,
  ChallengeModal,
  ReadLogModal,
  SettingsModal,
} from '@/components/Modals';
import { ReadingTab } from '@/components/ReadingTab';
import { ReleasedTab } from '@/components/ReleasedTab';
import { SearchTab } from '@/components/SearchTab';
import { UpcomingTab } from '@/components/UpcomingTab';
import { Fleuron, toRoman } from '@/components/ui';
import { buildDemoLibrary } from '@/lib/demoLibrary';
import { format, parseISO } from 'date-fns';
import {
  deleteCloudRecords,
  getCurrentSessionAndProfile,
  mergeLocalAndCloudState,
  pullCloudState,
  pushFullStateToCloud,
  resolveCloudConfig,
  sendMagicLink,
  signOutUser,
  subscribeToAuthChanges,
  updateUserProfile,
} from '@/lib/cloudSync';
import {
  classifyReleaseTiming,
  getLocalTodayStr,
  parseReleaseDateInput,
} from '@/lib/dates';
import {
  isLocalNetworkHost,
  mergeBookLists,
  mergeChallengeLists,
  syncFolioStateWithBridge,
} from '@/lib/vellumBridge';
import {
  AppSettings,
  BookItem,
  FollowedAuthor,
  FriendFinishedFeedItem,
  ReadingChallenge,
  ReadingStatus,
  SearchAuthorResult,
  SearchBookResult,
  TabKey,
  TrackerState,
  UserProfile,
} from '@/types/books';

const LOCAL_STATE_KEY = 'folio_tracker_state_v1';
const LOCAL_SETTINGS_KEY = 'folio_tracker_settings_v1';
const LOCAL_THEME_KEY = 'folio_tracker_theme_v1';
const PENDING_JOIN_CODE_KEY = 'folio_pending_join_code_v1';
const LAST_AUTH_USER_KEY = 'folio_last_auth_user_v1';

const DEFAULT_SETTINGS: AppSettings = {
  hardcoverToken: '',
  supabaseUrl: '',
  supabaseAnonKey: '',
  vellumUrl: 'http://localhost:3030',
};

const EMPTY_STATE: TrackerState = {
  authors: [],
  books: [],
  challenges: [],
};

function normBookMatchKey(title: string, authorName: string): string {
  const cleanTitle = title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .split(':')[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const cleanAuthor = authorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${cleanTitle}::${cleanAuthor}`;
}

export function BookTrackerApp() {
  const [mounted, setMounted] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('upcoming');
  const [todayStr, setTodayStr] = useState<string>(() => getLocalTodayStr());

  const [state, setState] = useState<TrackerState>(EMPTY_STATE);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [serverStatus, setServerStatus] = useState<{
    hasServerHardcoverKey: boolean;
    hasServerGoogleKey: boolean;
    hasServerSupabase: boolean;
    hasBridgeTokenEnv?: boolean;
    isHostedCloud?: boolean;
  }>({
    hasServerHardcoverKey: false,
    hasServerGoogleKey: false,
    hasServerSupabase: false,
    hasBridgeTokenEnv: false,
    isHostedCloud: false,
  });

  const [cloudSyncStatus, setCloudSyncStatus] = useState<
    'local' | 'syncing' | 'synced' | 'error'
  >('local');
  const [cloudSyncError, setCloudSyncError] = useState<string | undefined>();
  const [lastVellumSyncAt, setLastVellumSyncAt] = useState<string | undefined>();
  const deletedBookIdsRef = useRef<string[]>([]);
  const deletedChallengeIdsRef = useRef<string[]>([]);
  const bridgeFingerRef = useRef<string>('');

  // Multi-user Supabase Auth + Friend Group Invite state
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | undefined>();
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  const initialCloudSyncDoneRef = useRef(false);

  const [syncingAuthorIds, setSyncingAuthorIds] = useState<Set<string>>(
    new Set()
  );
  const [isSyncingAll, setIsSyncingAll] = useState(false);

  // Cross-tab navigation helpers
  const [searchPrefill, setSearchPrefill] = useState<string | undefined>();
  const [releasedAuthorFilter, setReleasedAuthorFilter] = useState<
    string | null
  >(null);

  // Modal states
  const [bookModalState, setBookModalState] = useState<{
    open: boolean;
    book?: BookItem | null;
    defaultAuthorId?: string;
  }>({ open: false });
  const [authorModalOpen, setAuthorModalOpen] = useState(false);
  const [readLogBook, setReadLogBook] = useState<BookItem | null>(null);
  const [challengeModalState, setChallengeModalState] = useState<{
    open: boolean;
    year: number;
    existing?: ReadingChallenge;
  }>({ open: false, year: Number(todayStr.slice(0, 4)) });
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [importModalState, setImportModalState] = useState<{
    open: boolean;
    mode: ImportTabMode;
  }>({ open: false, mode: 'goodreads' });

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  }, []);

  // Register PWA service worker + load local state/settings
  useEffect(() => {
    setTodayStr(getLocalTodayStr());

    try {
      const rawTheme = localStorage.getItem(LOCAL_THEME_KEY);
      const prefersDark =
        rawTheme === 'dark' ||
        (!rawTheme &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      setDarkMode(prefersDark);
      document.documentElement.classList.toggle('dark', prefersDark);

      const rawState = localStorage.getItem(LOCAL_STATE_KEY);
      const isDemo = new URL(window.location.href).searchParams.has('demo');
      if (isDemo) {
        // Preview mode: load a sample library that is never persisted
        setDemoMode(true);
        setState(buildDemoLibrary(getLocalTodayStr()));
      } else if (rawState) {
        const parsed = JSON.parse(rawState);
        if (parsed && Array.isArray(parsed.books)) {
          setState({
            authors: parsed.authors || [],
            books: parsed.books || [],
            challenges: parsed.challenges || [],
          });
        }
      }

      const rawSettings = localStorage.getItem(LOCAL_SETTINGS_KEY);
      if (rawSettings) {
        setSettings((prev) => ({ ...prev, ...JSON.parse(rawSettings) }));
      }

      // Check URL for friend group invite link (?join=CODE)
      const currentUrl = new URL(window.location.href);
      const joinParam = currentUrl.searchParams
        .get('join')
        ?.trim()
        .toUpperCase();
      if (joinParam) {
        setPendingJoinCode(joinParam);
        localStorage.setItem(PENDING_JOIN_CODE_KEY, joinParam);
        currentUrl.searchParams.delete('join');
        window.history.replaceState(
          {},
          '',
          currentUrl.pathname + currentUrl.search + currentUrl.hash
        );
        setActiveTab('friends');
      } else {
        const storedJoin = localStorage.getItem(PENDING_JOIN_CODE_KEY);
        if (storedJoin) {
          setPendingJoinCode(storedJoin);
        }
      }
    } catch {
      // Ignore malformed storage
    }

    fetch('/api/config')
      .then((r) => r.json())
      .then((info) => setServerStatus(info))
      .catch(() => {});

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    setMounted(true);
  }, []);

  // Persist local state immediately on change (never in demo preview mode)
  useEffect(() => {
    if (!mounted || demoMode) return;
    try {
      localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
    } catch {
      // Storage quota full fallback
    }
  }, [state, mounted, demoMode]);

  // Cloud Auth session subscription & personal library sync
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const computeBridgeFingerprint = useCallback(
    (books: BookItem[], challenges: ReadingChallenge[]) =>
      JSON.stringify({
        b: books
          .map(
            (x) =>
              `${x.id}|${x.updatedAt}|${x.readingStatus}|${x.finishedAt || ''}|${
                x.rating ?? ''
              }|${x.notes || ''}|${x.vellumProgress ?? ''}|${x.vellumChapter || ''}`
          )
          .sort(),
        c: challenges.map((x) => `${x.id}|${x.updatedAt}|${x.goalCount}`).sort(),
      }),
    []
  );

  const runVellumBridgeSync = useCallback(async () => {
    if (demoMode) return;
    if (
      typeof window === 'undefined' ||
      serverStatus.isHostedCloud ||
      !isLocalNetworkHost(window.location.hostname)
    ) {
      return;
    }
    const curState = stateRef.current;
    const delBooks = [...deletedBookIdsRef.current];
    const delChallenges = [...deletedChallengeIdsRef.current];
    deletedBookIdsRef.current = [];
    deletedChallengeIdsRef.current = [];

    const res = await syncFolioStateWithBridge({
      books: curState.books,
      challenges: curState.challenges,
      deletedBookIds: delBooks,
      deletedChallengeIds: delChallenges,
      vellumUrl: settingsRef.current.vellumUrl || 'http://localhost:3030',
    });
    if (!res) return;

    if (res.lastVellumSyncAt) {
      setLastVellumSyncAt(res.lastVellumSyncAt);
    }

    setState((prev) => {
      const mergedBooks = mergeBookLists(
        prev.books,
        res.books.filter((b) => !delBooks.includes(b.id))
      );
      const mergedChallenges = mergeChallengeLists(
        prev.challenges,
        res.challenges.filter((c) => !delChallenges.includes(c.id))
      );
      const prevFp = computeBridgeFingerprint(prev.books, prev.challenges);
      const nextFp = computeBridgeFingerprint(mergedBooks, mergedChallenges);
      bridgeFingerRef.current = nextFp;
      if (prevFp === nextFp) return prev;
      return {
        ...prev,
        books: mergedBooks,
        challenges: mergedChallenges,
      };
    });
  }, [demoMode, serverStatus.isHostedCloud, computeBridgeFingerprint]);

  // Sync Folio <-> Vellum Bridge on mount, focus, and periodic 10s heartbeat while visible
  useEffect(() => {
    if (!mounted || demoMode) return;
    runVellumBridgeSync();

    const onFocusOrVis = () => {
      if (document.visibilityState === 'visible') {
        runVellumBridgeSync();
      }
    };
    window.addEventListener('focus', onFocusOrVis);
    document.addEventListener('visibilitychange', onFocusOrVis);

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        runVellumBridgeSync();
      }
    }, 10000);

    return () => {
      window.removeEventListener('focus', onFocusOrVis);
      document.removeEventListener('visibilitychange', onFocusOrVis);
      clearInterval(interval);
    };
  }, [mounted, demoMode, runVellumBridgeSync]);

  // Debounced push to Vellum Bridge whenever Folio books or challenges change locally
  useEffect(() => {
    if (!mounted || demoMode) return;
    const fp = computeBridgeFingerprint(state.books, state.challenges);
    if (fp === bridgeFingerRef.current) return;

    const timer = setTimeout(() => {
      runVellumBridgeSync();
    }, 550);
    return () => clearTimeout(timer);
  }, [state.books, state.challenges, mounted, demoMode, computeBridgeFingerprint, runVellumBridgeSync]);

  const cloudConfig = useMemo(
    () => resolveCloudConfig(settings),
    [settings, serverStatus.hasServerSupabase]
  );

  const triggerCloudPullAndPush = useCallback(
    async (activeSettings: AppSettings, explicitUserId?: string | null) => {
      const cfg = resolveCloudConfig(activeSettings);
      const targetUserId =
        explicitUserId !== undefined ? explicitUserId : authUserId;

      if (!cfg || !targetUserId) {
        initialCloudSyncDoneRef.current = false;
        setCloudSyncStatus('local');
        setCloudSyncError(undefined);
        return;
      }

      setCloudSyncStatus('syncing');
      setCloudSyncError(undefined);
      try {
        const remote = await pullCloudState(cfg, targetUserId);
        let prevOwnerId: string | null = null;
        try {
          prevOwnerId = localStorage.getItem(LAST_AUTH_USER_KEY);
        } catch {}

        if (prevOwnerId && prevOwnerId !== targetUserId) {
          // A different account signed in on this device; load their cloud library cleanly
          setState(remote);
        } else {
          // Same user or first-time upgrade from local browser state
          const merged = mergeLocalAndCloudState(stateRef.current, remote);
          setState(merged);
          await pushFullStateToCloud(cfg, targetUserId, merged);
        }

        try {
          localStorage.setItem(LAST_AUTH_USER_KEY, targetUserId);
        } catch {}

        initialCloudSyncDoneRef.current = true;
        setCloudSyncStatus('synced');
      } catch (err) {
        setCloudSyncStatus('error');
        setCloudSyncError(
          err instanceof Error ? err.message : 'Cloud sync failed'
        );
      }
    },
    [authUserId]
  );

  // Subscribe to Supabase Auth state (Magic Link sign-in / session restore / sign-out)
  useEffect(() => {
    if (!mounted) return;
    if (!cloudConfig) {
      setAuthUserId(null);
      setAuthEmail(undefined);
      setUserProfile(null);
      initialCloudSyncDoneRef.current = false;
      setCloudSyncStatus('local');
      return;
    }

    let active = true;

    getCurrentSessionAndProfile(cloudConfig)
      .then((snap) => {
        if (!active) return;
        setAuthUserId(snap.userId);
        setAuthEmail(snap.email);
        setUserProfile(snap.profile);
      })
      .catch(() => {});

    const unsubscribe = subscribeToAuthChanges(cloudConfig, (snap) => {
      if (!active) return;
      setAuthUserId((prev) => {
        if (prev !== snap.userId) {
          initialCloudSyncDoneRef.current = false;
        }
        return snap.userId;
      });
      setAuthEmail(snap.email);
      setUserProfile(snap.profile);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [mounted, cloudConfig]);

  // Run initial pull/merge once authenticated
  useEffect(() => {
    if (!mounted || demoMode) return;
    if (cloudConfig && authUserId) {
      triggerCloudPullAndPush(settings, authUserId);
    } else {
      initialCloudSyncDoneRef.current = false;
      setCloudSyncStatus('local');
    }
  }, [mounted, demoMode, cloudConfig, authUserId, settings, triggerCloudPullAndPush]);

  // Debounced background push on state edits when signed in
  const lastCloudPullMsRef = useRef<number>(0);

  useEffect(() => {
    if (!mounted || demoMode || !cloudConfig || !authUserId) return;
    if (!initialCloudSyncDoneRef.current) return;

    const timer = setTimeout(async () => {
      try {
        setCloudSyncStatus('syncing');
        await pushFullStateToCloud(cloudConfig, authUserId, state);
        setCloudSyncStatus('synced');
        setCloudSyncError(undefined);
      } catch (err) {
        setCloudSyncStatus('error');
        setCloudSyncError(
          err instanceof Error ? err.message : 'Cloud sync failed'
        );
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [state, cloudConfig, authUserId, mounted, demoMode]);

  // Pull cloud updates on window focus so native Vellum mobile syncs appear automatically
  useEffect(() => {
    if (!mounted || demoMode || !cloudConfig || !authUserId) return;

    const refreshFromCloud = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!initialCloudSyncDoneRef.current) return;
      const now = Date.now();
      if (now - lastCloudPullMsRef.current < 10_000) return;
      lastCloudPullMsRef.current = now;

      try {
        const remote = await pullCloudState(cloudConfig, authUserId);
        setState((prev) => {
          const merged = mergeLocalAndCloudState(prev, remote);
          const prevFp = computeBridgeFingerprint(prev.books, prev.challenges);
          const nextFp = computeBridgeFingerprint(merged.books, merged.challenges);
          if (prevFp === nextFp && prev.authors.length === merged.authors.length) {
            return prev;
          }
          return merged;
        });
      } catch {
        // Silent background focus refresh
      }
    };

    window.addEventListener('focus', refreshFromCloud);
    document.addEventListener('visibilitychange', refreshFromCloud);
    return () => {
      window.removeEventListener('focus', refreshFromCloud);
      document.removeEventListener('visibilitychange', refreshFromCloud);
    };
  }, [mounted, demoMode, cloudConfig, authUserId, computeBridgeFingerprint]);

  const effectiveLastVellumSyncAt = useMemo(() => {
    let latest = lastVellumSyncAt || '';
    for (const b of state.books) {
      if (b.vellumLastReadAt && b.vellumLastReadAt > latest) {
        latest = b.vellumLastReadAt;
      }
    }
    return latest || undefined;
  }, [lastVellumSyncAt, state.books]);

  const toggleDarkMode = () => {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem(LOCAL_THEME_KEY, next ? 'dark' : 'light');
    } catch {}
  };

  // Sync bibliography for a single followed author
  const syncAuthorCatalog = useCallback(
    async (author: FollowedAuthor, silent = false) => {
      setSyncingAuthorIds((prev) => new Set(prev).add(author.id));
      try {
        const headers: Record<string, string> = {};
        if (settings.hardcoverToken?.trim()) {
          headers['x-hardcover-token'] = settings.hardcoverToken.trim();
        }
        const params = new URLSearchParams({
          authorId: author.id,
          name: author.name,
          source: author.source,
        });
        if (author.externalId) {
          params.set('externalId', author.externalId);
        }

        const res = await fetch(`/api/authors/books?${params.toString()}`, {
          headers,
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to sync author');
        }

        const fetchedBooks: BookItem[] = data.books || [];
        const nowIso = new Date().toISOString();

        setState((prev) => {
          const existingById = new Map<string, BookItem>();
          const existingByNorm = new Map<string, BookItem>();
          for (const b of prev.books) {
            existingById.set(b.id, b);
            existingByNorm.set(normBookMatchKey(b.title, b.authorName), b);
          }

          const nextBooksMap = new Map<string, BookItem>();
          for (const b of prev.books) {
            nextBooksMap.set(b.id, b);
          }

          for (const incoming of fetchedBooks) {
            const matched =
              existingById.get(incoming.id) ||
              existingByNorm.get(
                normBookMatchKey(incoming.title, incoming.authorName)
              );

            if (matched) {
              // Preserve user state (readingStatus, hidden, notes, rating, one-off flag)
              const isVellumAutoEntry = matched.id.startsWith('vellum:');
              nextBooksMap.set(matched.id, {
                ...matched,
                authorId: matched.authorId || author.id,
                coverUrl: matched.coverUrl || incoming.coverUrl,
                releaseDate:
                  matched.isManual && matched.releaseDate && !isVellumAutoEntry
                    ? matched.releaseDate
                    : incoming.releaseDate || matched.releaseDate,
                datePrecision:
                  matched.isManual &&
                  matched.datePrecision !== 'unknown' &&
                  !isVellumAutoEntry
                    ? matched.datePrecision
                    : incoming.datePrecision !== 'unknown'
                    ? incoming.datePrecision
                    : matched.datePrecision,
                description: matched.description || incoming.description,
                pageCount: matched.pageCount || incoming.pageCount,
                updatedAt: nowIso,
              });
            } else {
              nextBooksMap.set(incoming.id, {
                ...incoming,
                authorId: author.id,
                updatedAt: nowIso,
              });
            }
          }

          const updatedAuthors = prev.authors.map((a) =>
            a.id === author.id
              ? { ...a, lastSyncedAt: nowIso, updatedAt: nowIso }
              : a
          );

          return {
            ...prev,
            authors: updatedAuthors,
            books: Array.from(nextBooksMap.values()),
          };
        });

        if (!silent) {
          const upcomingCount = fetchedBooks.filter(
            (b) => classifyReleaseTiming(b, todayStr) === 'upcoming'
          ).length;
          showToast(
            `Synced ${fetchedBooks.length} books for ${author.name}${
              upcomingCount > 0 ? ` (${upcomingCount} upcoming)` : ''
            }`
          );
        }
      } catch (err) {
        if (!silent) {
          showToast(
            err instanceof Error ? err.message : `Could not sync ${author.name}`
          );
        }
      } finally {
        setSyncingAuthorIds((prev) => {
          const next = new Set(prev);
          next.delete(author.id);
          return next;
        });
      }
    },
    [settings.hardcoverToken, showToast, todayStr]
  );

  const handleSyncAllAuthors = useCallback(async () => {
    if (state.authors.length === 0 || isSyncingAll) return;
    setIsSyncingAll(true);
    try {
      for (const author of state.authors) {
        await syncAuthorCatalog(author, true);
      }
      showToast(`Refreshed releases for ${state.authors.length} authors`);
    } finally {
      setIsSyncingAll(false);
    }
  }, [state.authors, isSyncingAll, syncAuthorCatalog, showToast]);

  const handleFollowSearchAuthor = useCallback(
    async (candidate: SearchAuthorResult) => {
      const nowIso = new Date().toISOString();
      const newAuthor: FollowedAuthor = {
        id: candidate.id,
        source: candidate.source,
        externalId: candidate.externalId,
        name: candidate.name,
        imageUrl: candidate.imageUrl,
        bio: candidate.bio || candidate.topWork,
        followedAt: nowIso,
        updatedAt: nowIso,
      };

      setState((prev) => {
        if (
          prev.authors.some(
            (a) =>
              a.id === newAuthor.id ||
              a.name.toLowerCase().trim() === newAuthor.name.toLowerCase().trim()
          )
        ) {
          return prev;
        }
        return {
          ...prev,
          authors: [...prev.authors, newAuthor],
        };
      });

      await syncAuthorCatalog(newAuthor, false);
    },
    [syncAuthorCatalog]
  );

  const handleSaveManualAuthor = useCallback(
    async (data: {
      name: string;
      imageUrl?: string;
      bio?: string;
      autoFetchCatalog: boolean;
    }) => {
      const nowIso = new Date().toISOString();
      const slug = data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const newAuthor: FollowedAuthor = {
        id: `manual:author:${slug}-${Date.now().toString(36)}`,
        source: 'manual',
        name: data.name,
        imageUrl: data.imageUrl,
        bio: data.bio,
        followedAt: nowIso,
        updatedAt: nowIso,
      };

      setState((prev) => ({
        ...prev,
        authors: [...prev.authors, newAuthor],
      }));
      setAuthorModalOpen(false);

      if (data.autoFetchCatalog) {
        await syncAuthorCatalog(newAuthor, false);
      } else {
        showToast(`Following ${newAuthor.name}`);
      }
    },
    [syncAuthorCatalog, showToast]
  );

  const handleUnfollowAuthor = useCallback(
    async (author: FollowedAuthor) => {
      const removedBookIds: string[] = [];
      setState((prev) => {
        const remainingBooks = prev.books.filter((b) => {
          const belongsToAuthor = b.authorId === author.id;
          const keepBecauseUserTracked =
            b.isOneOff || b.isManual || b.readingStatus !== 'none';
          if (belongsToAuthor && !keepBecauseUserTracked) {
            removedBookIds.push(b.id);
            return false;
          }
          return true;
        });

        return {
          ...prev,
          authors: prev.authors.filter((a) => a.id !== author.id),
          books: remainingBooks,
        };
      });

      if (releasedAuthorFilter === author.id) {
        setReleasedAuthorFilter(null);
      }

      if (cloudConfig && authUserId) {
        deleteCloudRecords(
          cloudConfig,
          authUserId,
          'followed_authors',
          [author.id]
        ).catch(() => {});
        if (removedBookIds.length > 0) {
          deleteCloudRecords(
            cloudConfig,
            authUserId,
            'tracked_books',
            removedBookIds
          ).catch(() => {});
        }
      }

      showToast(`Unfollowed ${author.name}`);
    },
    [releasedAuthorFilter, cloudConfig, authUserId, showToast]
  );

  const upsertBookFromSearch = useCallback(
    (
      candidate: SearchBookResult,
      updater: (existing?: BookItem) => Partial<BookItem>
    ): BookItem => {
      const nowIso = new Date().toISOString();
      let finalItem!: BookItem;

      setState((prev) => {
        const matchNorm = normBookMatchKey(
          candidate.title,
          candidate.authorName
        );
        const existingIdx = prev.books.findIndex(
          (b) =>
            b.id === candidate.id ||
            normBookMatchKey(b.title, b.authorName) === matchNorm
        );

        const matchedFollowedAuthor = prev.authors.find(
          (a) =>
            a.name.toLowerCase().trim() ===
            candidate.authorName.toLowerCase().trim()
        );

        if (existingIdx >= 0) {
          const current = prev.books[existingIdx];
          finalItem = {
            ...current,
            hidden: false,
            ...updater(current),
            updatedAt: nowIso,
          };
          const copy = [...prev.books];
          copy[existingIdx] = finalItem;
          return { ...prev, books: copy };
        }

        const base: BookItem = {
          id: candidate.id,
          source: candidate.source,
          externalId: candidate.externalId,
          title: candidate.title,
          authorName: candidate.authorName,
          authorId: matchedFollowedAuthor?.id,
          coverUrl: candidate.coverUrl,
          releaseDate: candidate.releaseDate,
          datePrecision: candidate.datePrecision,
          description: candidate.description,
          pageCount: candidate.pageCount,
          isbn: candidate.isbn,
          isOneOff: true,
          isManual: false,
          readingStatus: 'none',
          updatedAt: nowIso,
        };
        finalItem = {
          ...base,
          ...updater(undefined),
        };
        return { ...prev, books: [...prev.books, finalItem] };
      });

      return finalItem;
    },
    []
  );

  const handleTrackOneOffBook = useCallback(
    (candidate: SearchBookResult) => {
      const existing = state.books.find(
        (b) =>
          b.id === candidate.id ||
          normBookMatchKey(b.title, b.authorName) ===
            normBookMatchKey(candidate.title, candidate.authorName)
      );

      if (existing?.isOneOff && !existing.hidden) {
        // Untrack if not on reading list
        if (existing.readingStatus === 'none' && !existing.authorId) {
          setState((prev) => ({
            ...prev,
            books: prev.books.filter((b) => b.id !== existing.id),
          }));
          if (cloudConfig && authUserId) {
            deleteCloudRecords(cloudConfig, authUserId, 'tracked_books', [
              existing.id,
            ]).catch(() => {});
          }
          showToast(`Removed one-off "${candidate.title}"`);
          return;
        }
        upsertBookFromSearch(candidate, () => ({ isOneOff: false }));
        showToast(`Unpinned one-off "${candidate.title}"`);
        return;
      }

      upsertBookFromSearch(candidate, () => ({ isOneOff: true, hidden: false }));
      const timing = classifyReleaseTiming(candidate, todayStr);
      showToast(
        timing === 'upcoming'
          ? `Tracking "${candidate.title}" in Upcoming`
          : `Added "${candidate.title}" to Released`
      );
    },
    [
      state.books,
      cloudConfig,
      authUserId,
      upsertBookFromSearch,
      todayStr,
      showToast,
    ]
  );

  const handleAddSearchBookToTodo = useCallback(
    (candidate: SearchBookResult) => {
      const nowIso = new Date().toISOString();
      let becameTodo = true;
      upsertBookFromSearch(candidate, (existing) => {
        if (existing?.readingStatus === 'todo') {
          becameTodo = false;
          return { readingStatus: 'none', addedToTodoAt: undefined };
        }
        return {
          isOneOff: existing ? existing.isOneOff : true,
          readingStatus: 'todo',
          addedToTodoAt: nowIso,
        };
      });
      showToast(
        becameTodo
          ? `Added "${candidate.title}" to To-Do list`
          : `Removed "${candidate.title}" from To-Do list`
      );
    },
    [upsertBookFromSearch, showToast]
  );

  const handleMarkSearchBookRead = useCallback(
    (candidate: SearchBookResult) => {
      let becameRead = true;
      upsertBookFromSearch(candidate, (existing) => {
        if (existing?.readingStatus === 'read') {
          becameRead = false;
          return { readingStatus: 'none', finishedAt: undefined };
        }
        return {
          isOneOff: existing ? existing.isOneOff : true,
          readingStatus: 'read',
          finishedAt: existing?.finishedAt || todayStr,
        };
      });
      showToast(
        becameRead
          ? `Marked "${candidate.title}" as Read`
          : `Unmarked "${candidate.title}" as Read`
      );
    },
    [upsertBookFromSearch, todayStr, showToast]
  );

  const handleToggleTodo = useCallback(
    (book: BookItem) => {
      const nowIso = new Date().toISOString();
      const nextStatus: ReadingStatus =
        book.readingStatus === 'todo' ? 'none' : 'todo';

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) =>
          b.id === book.id
            ? {
                ...b,
                readingStatus: nextStatus,
                addedToTodoAt: nextStatus === 'todo' ? nowIso : undefined,
                updatedAt: nowIso,
              }
            : b
        ),
      }));

      showToast(
        nextStatus === 'todo'
          ? `Added "${book.title}" to To-Do`
          : `Removed "${book.title}" from To-Do`
      );
    },
    [showToast]
  );

  const handleToggleRead = useCallback(
    (book: BookItem) => {
      const nowIso = new Date().toISOString();
      const nextStatus: ReadingStatus =
        book.readingStatus === 'read' ? 'none' : 'read';

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) =>
          b.id === book.id
            ? {
                ...b,
                readingStatus: nextStatus,
                finishedAt:
                  nextStatus === 'read' ? b.finishedAt || todayStr : undefined,
                updatedAt: nowIso,
              }
            : b
        ),
      }));

      if (nextStatus === 'read') {
        const currentYear = Number(todayStr.slice(0, 4));
        const hasChallenge = state.challenges.some(
          (c) => c.year === currentYear
        );
        showToast(
          hasChallenge
            ? `Marked "${book.title}" as Read · Counted in ${currentYear} Challenge`
            : `Marked "${book.title}" as Read`
        );
      } else {
        showToast(`Unmarked "${book.title}" as Read`);
      }
    },
    [todayStr, state.challenges, showToast]
  );

  const handleSaveReadDetails = useCallback(
    (updates: { finishedAt?: string; rating?: number; notes?: string }) => {
      if (!readLogBook) return;
      const nowIso = new Date().toISOString();
      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) =>
          b.id === readLogBook.id
            ? {
                ...b,
                readingStatus: 'read',
                finishedAt: updates.finishedAt,
                rating: updates.rating,
                notes: updates.notes,
                updatedAt: nowIso,
              }
            : b
        ),
      }));
      setReadLogBook(null);
      showToast('Updated reading log');
    },
    [readLogBook, showToast]
  );

  const handleSaveBookModal = useCallback(
    (data: {
      id?: string;
      title: string;
      authorName: string;
      authorId?: string;
      releaseDateInput: string;
      coverUrl?: string;
      isOneOff: boolean;
      readingStatus: ReadingStatus;
      finishedAt?: string;
    }) => {
      const nowIso = new Date().toISOString();
      const parsedDate = parseReleaseDateInput(data.releaseDateInput);

      if (data.id) {
        setState((prev) => ({
          ...prev,
          books: prev.books.map((b) =>
            b.id === data.id
              ? {
                  ...b,
                  title: data.title,
                  authorName: data.authorName,
                  authorId: data.authorId,
                  coverUrl: data.coverUrl,
                  releaseDate: parsedDate.releaseDate,
                  datePrecision: parsedDate.datePrecision,
                  isOneOff: data.isOneOff,
                  readingStatus: data.readingStatus,
                  addedToTodoAt:
                    data.readingStatus === 'todo'
                      ? b.addedToTodoAt || nowIso
                      : undefined,
                  finishedAt:
                    data.readingStatus === 'read' ? data.finishedAt : undefined,
                  updatedAt: nowIso,
                }
              : b
          ),
        }));
        showToast(`Updated "${data.title}"`);
      } else {
        const newBook: BookItem = {
          id: `manual:book:${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          source: 'manual',
          title: data.title,
          authorName: data.authorName,
          authorId: data.authorId,
          coverUrl: data.coverUrl,
          releaseDate: parsedDate.releaseDate,
          datePrecision: parsedDate.datePrecision,
          isOneOff: data.isOneOff,
          isManual: true,
          readingStatus: data.readingStatus,
          addedToTodoAt: data.readingStatus === 'todo' ? nowIso : undefined,
          finishedAt:
            data.readingStatus === 'read' ? data.finishedAt : undefined,
          updatedAt: nowIso,
        };
        setState((prev) => ({
          ...prev,
          books: [...prev.books, newBook],
        }));
        showToast(`Added "${data.title}"`);
      }

      setBookModalState({ open: false });
    },
    [showToast]
  );

  const handleRemoveOrHideBook = useCallback(
    (book: BookItem) => {
      const nowIso = new Date().toISOString();
      if (book.isManual || (book.isOneOff && !book.authorId)) {
        deletedBookIdsRef.current.push(book.id);
        setState((prev) => ({
          ...prev,
          books: prev.books.filter((b) => b.id !== book.id),
        }));
        if (cloudConfig && authUserId) {
          deleteCloudRecords(cloudConfig, authUserId, 'tracked_books', [
            book.id,
          ]).catch(() => {});
        }
        showToast(`Removed "${book.title}"`);
      } else {
        setState((prev) => ({
          ...prev,
          books: prev.books.map((b) =>
            b.id === book.id
              ? { ...b, hidden: true, isOneOff: false, updatedAt: nowIso }
              : b
          ),
        }));
        showToast(`Hid "${book.title}" from feed`);
      }
    },
    [cloudConfig, authUserId, showToast]
  );

  const handleSaveChallenge = useCallback(
    (data: { year: number; goalCount: number; title: string }) => {
      const nowIso = new Date().toISOString();
      const id = `challenge:${data.year}`;

      setState((prev) => {
        const exists = prev.challenges.some((c) => c.year === data.year);
        if (exists) {
          return {
            ...prev,
            challenges: prev.challenges.map((c) =>
              c.year === data.year
                ? {
                    ...c,
                    goalCount: data.goalCount,
                    title: data.title,
                    updatedAt: nowIso,
                  }
                : c
            ),
          };
        }
        const created: ReadingChallenge = {
          id,
          year: data.year,
          goalCount: data.goalCount,
          title: data.title,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        return {
          ...prev,
          challenges: [...prev.challenges, created],
        };
      });

      setChallengeModalState((prev) => ({ ...prev, open: false }));
      showToast(`Saved ${data.year} Reading Challenge (${data.goalCount} books)`);
    },
    [showToast]
  );

  const handleDeleteChallenge = useCallback(
    (challengeId: string) => {
      deletedChallengeIdsRef.current.push(challengeId);
      setState((prev) => ({
        ...prev,
        challenges: prev.challenges.filter((c) => c.id !== challengeId),
      }));
      if (cloudConfig && authUserId) {
        deleteCloudRecords(cloudConfig, authUserId, 'reading_challenges', [
          challengeId,
        ]).catch(() => {});
      }
      showToast('Removed reading challenge');
    },
    [cloudConfig, authUserId, showToast]
  );

  const handleClearPendingJoinCode = useCallback(() => {
    setPendingJoinCode(null);
    try {
      localStorage.removeItem(PENDING_JOIN_CODE_KEY);
    } catch {}
  }, []);

  const handleSendMagicLink = useCallback(
    async (email: string, displayName?: string) => {
      if (!cloudConfig) {
        throw new Error('Connect Supabase in Settings first.');
      }
      const redirectUrl = new URL(window.location.origin);
      if (pendingJoinCode) {
        redirectUrl.searchParams.set('join', pendingJoinCode);
      }
      await sendMagicLink(
        cloudConfig,
        email,
        redirectUrl.toString(),
        displayName
      );
    },
    [cloudConfig, pendingJoinCode]
  );

  const handleSignOut = useCallback(async () => {
    if (!cloudConfig) return;
    try {
      await signOutUser(cloudConfig);
      setAuthUserId(null);
      setAuthEmail(undefined);
      setUserProfile(null);
      initialCloudSyncDoneRef.current = false;
      setCloudSyncStatus('local');
      showToast('Signed out');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not sign out');
    }
  }, [cloudConfig, showToast]);

  const handleUpdateProfile = useCallback(
    async (updates: { displayName?: string; shareActivity?: boolean }) => {
      if (!cloudConfig || !authUserId) return;
      try {
        const updated = await updateUserProfile(
          cloudConfig,
          authUserId,
          updates,
          authEmail
        );
        setUserProfile(updated);
        showToast('Updated profile');
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Failed to update profile'
        );
      }
    },
    [cloudConfig, authUserId, authEmail, showToast]
  );

  const handleAddFriendBookToTodo = useCallback(
    (item: FriendFinishedFeedItem) => {
      const nowIso = new Date().toISOString();
      setState((prev) => {
        const matchNorm = normBookMatchKey(item.title, item.authorName);
        const existingIdx = prev.books.findIndex(
          (b) =>
            b.id === item.bookId ||
            normBookMatchKey(b.title, b.authorName) === matchNorm
        );

        if (existingIdx >= 0) {
          const current = prev.books[existingIdx];
          if (current.readingStatus === 'read') {
            return prev;
          }
          const copy = [...prev.books];
          copy[existingIdx] = {
            ...current,
            hidden: false,
            readingStatus: 'todo',
            addedToTodoAt: current.addedToTodoAt || nowIso,
            updatedAt: nowIso,
          };
          return { ...prev, books: copy };
        }

        const matchedAuthor = prev.authors.find(
          (a) =>
            a.name.toLowerCase().trim() === item.authorName.toLowerCase().trim()
        );

        const newBook: BookItem = {
          id: item.bookId,
          source: item.source,
          externalId: item.externalId,
          title: item.title,
          authorName: item.authorName,
          authorId: matchedAuthor?.id,
          coverUrl: item.coverUrl,
          releaseDate: item.releaseDate,
          datePrecision: item.datePrecision,
          isOneOff: true,
          isManual: item.source === 'manual',
          readingStatus: 'todo',
          addedToTodoAt: nowIso,
          updatedAt: nowIso,
        };

        return { ...prev, books: [...prev.books, newBook] };
      });

      showToast(`Added "${item.title}" to your To-Do list`);
    },
    [showToast]
  );

  const handleSaveSettings = useCallback(
    (next: AppSettings) => {
      setSettings(next);
      try {
        localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
      } catch {}
      showToast('Settings saved');
    },
    [showToast]
  );

  const handleApplyBatchImport = useCallback(
    async (payload: {
      booksToUpsert: BookItem[];
      newAuthors: SearchAuthorResult[];
      createChallenge?: { year: number; goalCount: number };
      onAuthorSyncProgress?: (
        current: number,
        total: number,
        authorName: string
      ) => void;
      shouldAbort?: () => boolean;
    }): Promise<{ syncedAuthors: number }> => {
      const nowIso = new Date().toISOString();
      const createdFollowedAuthors: FollowedAuthor[] = [];

      setState((prev) => {
        const authorByNorm = new Map<string, FollowedAuthor>();
        const nextAuthors = [...prev.authors];
        for (const a of nextAuthors) {
          authorByNorm.set(a.name.toLowerCase().trim(), a);
        }

        for (const cand of payload.newAuthors) {
          const norm = cand.name.toLowerCase().trim();
          if (authorByNorm.has(norm)) continue;
          const followed: FollowedAuthor = {
            id: cand.id,
            source: cand.source,
            externalId: cand.externalId,
            name: cand.name,
            imageUrl: cand.imageUrl,
            bio: cand.bio || cand.topWork,
            followedAt: nowIso,
            updatedAt: nowIso,
          };
          nextAuthors.push(followed);
          authorByNorm.set(norm, followed);
          createdFollowedAuthors.push(followed);
        }

        // Merge incoming books cleanly by ID or normalized (title, authorName)
        const booksMap = new Map<string, BookItem>();
        const normToId = new Map<string, string>();
        for (const existing of prev.books) {
          booksMap.set(existing.id, existing);
          normToId.set(
            normBookMatchKey(existing.title, existing.authorName),
            existing.id
          );
        }

        for (const incoming of payload.booksToUpsert) {
          const matchedAuthor = authorByNorm.get(
            incoming.authorName.toLowerCase().trim()
          );
          const normKey = normBookMatchKey(incoming.title, incoming.authorName);
          const existingId = booksMap.has(incoming.id)
            ? incoming.id
            : normToId.get(normKey);

          if (existingId && booksMap.has(existingId)) {
            const current = booksMap.get(existingId)!;
            booksMap.set(existingId, {
              ...current,
              authorId: current.authorId || matchedAuthor?.id,
              coverUrl: current.coverUrl || incoming.coverUrl,
              releaseDate: incoming.releaseDate || current.releaseDate,
              datePrecision:
                incoming.datePrecision !== 'unknown'
                  ? incoming.datePrecision
                  : current.datePrecision,
              pageCount: current.pageCount || incoming.pageCount,
              isbn: current.isbn || incoming.isbn,
              hidden: false,
              isOneOff: current.isOneOff || incoming.isOneOff,
              readingStatus:
                incoming.readingStatus !== 'none'
                  ? incoming.readingStatus
                  : current.readingStatus,
              addedToTodoAt:
                incoming.readingStatus === 'todo'
                  ? incoming.addedToTodoAt || current.addedToTodoAt || nowIso
                  : current.addedToTodoAt,
              finishedAt: incoming.finishedAt || current.finishedAt,
              rating: incoming.rating ?? current.rating,
              notes: incoming.notes || current.notes,
              updatedAt: nowIso,
            });
          } else {
            const toInsert: BookItem = {
              ...incoming,
              authorId: incoming.authorId || matchedAuthor?.id,
              updatedAt: nowIso,
            };
            booksMap.set(toInsert.id, toInsert);
            normToId.set(normKey, toInsert.id);
          }
        }

        let nextChallenges = prev.challenges;
        if (
          payload.createChallenge &&
          !prev.challenges.some((c) => c.year === payload.createChallenge!.year)
        ) {
          nextChallenges = [
            ...prev.challenges,
            {
              id: `challenge:${payload.createChallenge.year}`,
              year: payload.createChallenge.year,
              goalCount: payload.createChallenge.goalCount,
              title: `${payload.createChallenge.year} Reading Challenge`,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ];
        }

        return {
          authors: nextAuthors,
          books: Array.from(booksMap.values()),
          challenges: nextChallenges,
        };
      });

      // Sequentially sync each newly followed author with polite pacing
      let syncedCount = 0;
      for (let i = 0; i < createdFollowedAuthors.length; i++) {
        if (payload.shouldAbort?.()) break;
        const author = createdFollowedAuthors[i];
        payload.onAuthorSyncProgress?.(
          i + 1,
          createdFollowedAuthors.length,
          author.name
        );
        await syncAuthorCatalog(author, true);
        syncedCount += 1;
        if (i + 1 < createdFollowedAuthors.length) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      return { syncedAuthors: syncedCount };
    },
    [syncAuthorCatalog]
  );

  // Visible books segmented into Upcoming and Released
  const visibleBooks = useMemo(
    () => state.books.filter((b) => !b.hidden),
    [state.books]
  );

  const upcomingBooks = useMemo(
    () =>
      visibleBooks.filter(
        (b) => classifyReleaseTiming(b, todayStr) === 'upcoming'
      ),
    [visibleBooks, todayStr]
  );

  const releasedBooks = useMemo(
    () =>
      visibleBooks.filter(
        (b) => classifyReleaseTiming(b, todayStr) === 'released'
      ),
    [visibleBooks, todayStr]
  );

  const todoCount = useMemo(
    () => visibleBooks.filter((b) => b.readingStatus === 'todo').length,
    [visibleBooks]
  );

  const navItems: Array<{
    key: TabKey;
    label: string;
    shortLabel: string;
    icon: LucideIcon;
    badge?: number;
  }> = [
    {
      key: 'upcoming',
      label: 'Upcoming',
      shortLabel: 'Upcoming',
      icon: CalendarClock,
      badge: upcomingBooks.length || undefined,
    },
    {
      key: 'released',
      label: 'Released',
      shortLabel: 'Released',
      icon: BookOpen,
    },
    {
      key: 'reading',
      label: 'Reading',
      shortLabel: 'Reading',
      icon: BookCheck,
      badge: todoCount || undefined,
    },
    {
      key: 'friends',
      label: 'Friends',
      shortLabel: 'Friends',
      icon: Users,
    },
    {
      key: 'authors',
      label: 'Authors',
      shortLabel: 'Authors',
      icon: Feather,
      badge: state.authors.length || undefined,
    },
    {
      key: 'search',
      label: 'Search',
      shortLabel: 'Search',
      icon: Search,
    },
  ];

  const syncDotClass =
    cloudSyncStatus === 'synced'
      ? 'bg-moss'
      : cloudSyncStatus === 'syncing'
      ? 'bg-gilt animate-pulse'
      : cloudSyncStatus === 'error'
      ? 'bg-claret'
      : '';

  const runningDate = (() => {
    const d = parseISO(todayStr);
    return Number.isNaN(d.getTime()) ? '' : format(d, 'EEEE, d MMMM yyyy');
  })();

  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="animate-pulse font-display text-[34px] font-medium italic text-ink-faint">
          Folio
        </span>
      </div>
    );
  }

  return (
    <div className="relative z-[1] min-h-screen pb-28 md:pb-0">
      {/* Masthead */}
      <header className="sticky top-0 z-30 border-b border-rule bg-paper">
        <div className="mx-auto max-w-5xl px-5 sm:px-8">
          <div className="relative flex h-14 items-center justify-between gap-4 md:h-16">
            <p className="caps-sm hidden w-56 text-ink-muted md:block">{runningDate}</p>

            <button
              type="button"
              onClick={() => setActiveTab('upcoming')}
              className="group flex items-baseline gap-2 md:absolute md:left-1/2 md:-translate-x-1/2"
              title="Folio"
            >
              <span className="font-display text-[30px] font-semibold italic leading-none tracking-[-0.01em] text-ink md:text-[34px]">
                Folio
              </span>
              {demoMode && <span className="tag tag-claret">Sample library</span>}
            </button>

            <div className="flex items-center justify-end gap-0.5 md:w-56">
              <button
                type="button"
                onClick={() => setImportModalState({ open: true, mode: 'goodreads' })}
                title="Import a Goodreads export or a list"
                className="btn btn-ghost btn-sm hidden sm:inline-flex"
              >
                <Upload strokeWidth={1.5} className="h-3.5 w-3.5" />
                Import
              </button>
              <button
                type="button"
                onClick={() => setImportModalState({ open: true, mode: 'goodreads' })}
                title="Import"
                className="icon-btn sm:hidden"
              >
                <Upload strokeWidth={1.5} className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => setSettingsModalOpen(true)}
                title={
                  cloudSyncStatus === 'synced'
                    ? 'Settings · synced'
                    : cloudSyncStatus === 'error'
                    ? 'Settings · sync problem'
                    : 'Settings'
                }
                className="icon-btn relative"
              >
                {cloudSyncStatus === 'synced' ? (
                  <Cloud strokeWidth={1.5} className="h-4 w-4" />
                ) : (
                  <Settings strokeWidth={1.5} className="h-4 w-4" />
                )}
                {syncDotClass && (
                  <span
                    className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${syncDotClass}`}
                  />
                )}
              </button>

              <button
                type="button"
                onClick={toggleDarkMode}
                title={darkMode ? 'Daylight' : 'Lamplight'}
                className="icon-btn"
              >
                {darkMode ? (
                  <Sun strokeWidth={1.5} className="h-4 w-4" />
                ) : (
                  <Moon strokeWidth={1.5} className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Table of contents */}
          <nav className="hidden h-11 items-center justify-center gap-9 border-t border-rule md:flex">
            {navItems.map((item, index) => {
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`group relative flex h-full items-center gap-1.5 font-sans text-[13px] transition-colors ${
                    isActive ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  <span
                    className={`font-display text-[14px] italic ${
                      isActive ? 'text-claret' : 'text-ink-faint group-hover:text-ink-muted'
                    }`}
                  >
                    {toRoman(index + 1).toLowerCase()}.
                  </span>
                  {item.label}
                  {item.badge ? (
                    <sup className="font-serif text-[11px] italic text-ink-faint nums-old">
                      {item.badge}
                    </sup>
                  ) : null}
                  <span
                    className={`absolute inset-x-0 -bottom-px h-px ${
                      isActive ? 'bg-claret' : 'bg-transparent'
                    }`}
                  />
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-5xl px-5 pt-8 sm:px-8 md:pt-12">
        {activeTab === 'upcoming' && (
          <UpcomingTab
            books={upcomingBooks}
            authors={state.authors}
            todayStr={todayStr}
            isSyncing={isSyncingAll || syncingAuthorIds.size > 0}
            onToggleTodo={handleToggleTodo}
            onToggleRead={handleToggleRead}
            onEditBook={(book) => setBookModalState({ open: true, book })}
            onRemoveOrHideBook={handleRemoveOrHideBook}
            onAddManualBook={() => setBookModalState({ open: true })}
            onSyncAllAuthors={handleSyncAllAuthors}
            onGoToSearch={(prefill) => {
              if (prefill) setSearchPrefill(prefill);
              setActiveTab('search');
            }}
            onSelectAuthorFilter={(authorId) => {
              setReleasedAuthorFilter(authorId);
              setActiveTab('released');
            }}
            onOpenImport={() =>
              setImportModalState({ open: true, mode: 'goodreads' })
            }
          />
        )}

        {activeTab === 'released' && (
          <ReleasedTab
            books={releasedBooks}
            authors={state.authors}
            todayStr={todayStr}
            selectedAuthorIdFilter={releasedAuthorFilter}
            onClearAuthorFilter={() => setReleasedAuthorFilter(null)}
            onSelectAuthorFilter={(authorId) => setReleasedAuthorFilter(authorId)}
            onToggleTodo={handleToggleTodo}
            onToggleRead={handleToggleRead}
            onOpenReadDetails={(book) => setReadLogBook(book)}
            onEditBook={(book) => setBookModalState({ open: true, book })}
            onRemoveOrHideBook={handleRemoveOrHideBook}
            onAddManualBook={() => setBookModalState({ open: true })}
            onGoToSearch={() => setActiveTab('search')}
          />
        )}

        {activeTab === 'reading' && (
          <ReadingTab
            books={visibleBooks}
            authors={state.authors}
            challenges={state.challenges}
            todayStr={todayStr}
            vellumUrl={settings.vellumUrl || 'http://localhost:3030'}
            onToggleTodo={handleToggleTodo}
            onToggleRead={handleToggleRead}
            onOpenReadDetails={(book) => setReadLogBook(book)}
            onEditBook={(book) => setBookModalState({ open: true, book })}
            onOpenChallengeModal={(year, existing) =>
              setChallengeModalState({ open: true, year, existing })
            }
            onDeleteChallenge={handleDeleteChallenge}
            onAddManualBook={() => setBookModalState({ open: true })}
            onOpenGoodreadsImport={() =>
              setImportModalState({ open: true, mode: 'goodreads' })
            }
          />
        )}

        {activeTab === 'friends' && (
          <FriendsTab
            cloudConfig={cloudConfig}
            authUserId={authUserId}
            authEmail={authEmail}
            userProfile={userProfile}
            pendingJoinCode={pendingJoinCode}
            onClearPendingJoinCode={handleClearPendingJoinCode}
            personalBooks={visibleBooks}
            personalChallenges={state.challenges}
            todayStr={todayStr}
            onOpenSettings={() => setSettingsModalOpen(true)}
            onOpenChallengeModal={(year, existing) =>
              setChallengeModalState({ open: true, year, existing })
            }
            onSendMagicLink={handleSendMagicLink}
            onSignOut={handleSignOut}
            onUpdateProfile={handleUpdateProfile}
            onAddFriendBookToTodo={handleAddFriendBookToTodo}
            onShowToast={showToast}
          />
        )}

        {activeTab === 'authors' && (
          <AuthorsTab
            authors={state.authors}
            books={visibleBooks}
            todayStr={todayStr}
            syncingAuthorIds={syncingAuthorIds}
            isSyncingAll={isSyncingAll}
            onSyncAuthor={(author) => syncAuthorCatalog(author, false)}
            onSyncAllAuthors={handleSyncAllAuthors}
            onUnfollowAuthor={handleUnfollowAuthor}
            onAddManualAuthor={() => setAuthorModalOpen(true)}
            onOpenBatchImport={() =>
              setImportModalState({ open: true, mode: 'authors' })
            }
            onAddBookForAuthor={(authorId) =>
              setBookModalState({ open: true, defaultAuthorId: authorId })
            }
            onViewAuthorReleased={(authorId) => {
              setReleasedAuthorFilter(authorId);
              setActiveTab('released');
            }}
            onGoToSearch={() => setActiveTab('search')}
          />
        )}

        {activeTab === 'search' && (
          <SearchTab
            initialQuery={searchPrefill}
            onConsumeInitialQuery={() => setSearchPrefill(undefined)}
            authors={state.authors}
            books={visibleBooks}
            todayStr={todayStr}
            hardcoverToken={settings.hardcoverToken}
            syncingAuthorIds={syncingAuthorIds}
            onFollowSearchAuthor={handleFollowSearchAuthor}
            onUnfollowAuthor={handleUnfollowAuthor}
            onTrackOneOffBook={handleTrackOneOffBook}
            onAddSearchBookToTodo={handleAddSearchBookToTodo}
            onMarkSearchBookRead={handleMarkSearchBookRead}
            onAddManualAuthor={() => setAuthorModalOpen(true)}
            onAddManualBook={() => setBookModalState({ open: true })}
          />
        )}
      </main>

      {/* Colophon */}
      <footer className="mx-auto mt-24 hidden max-w-5xl px-8 pb-12 text-center md:block">
        <Fleuron />
        <p className="mt-4 font-serif text-[14px] italic text-ink-faint">
          Folio is set in Cormorant &amp; EB Garamond. Bibliographic records courtesy of Hardcover,
          Google Books &amp; Open Library.
        </p>
      </footer>

      {/* Mobile table of contents */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
        <div className="grid h-[58px] grid-cols-6">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`relative flex flex-col items-center justify-center gap-1 transition-colors ${
                  isActive ? 'text-ink' : 'text-ink-faint'
                }`}
              >
                <span
                  className={`absolute inset-x-4 top-0 h-px ${isActive ? 'bg-claret' : 'bg-transparent'}`}
                />
                <span className="relative">
                  <Icon strokeWidth={isActive ? 1.6 : 1.3} className="h-[19px] w-[19px]" />
                  {item.badge ? (
                    <span className="absolute -right-3 -top-1.5 font-serif text-[11px] italic leading-none text-claret nums-old">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  ) : null}
                </span>
                <span className="font-sans text-[9.5px] font-medium tracking-[0.04em]">
                  {item.shortLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Modals */}
      {bookModalState.open && (
        <BookFormModal
          initialBook={bookModalState.book}
          authors={state.authors}
          todayStr={todayStr}
          defaultAuthorId={bookModalState.defaultAuthorId}
          onClose={() => setBookModalState({ open: false })}
          onSave={handleSaveBookModal}
        />
      )}

      {authorModalOpen && (
        <AuthorFormModal
          onClose={() => setAuthorModalOpen(false)}
          onSave={handleSaveManualAuthor}
        />
      )}

      {readLogBook && (
        <ReadLogModal
          book={readLogBook}
          todayStr={todayStr}
          onClose={() => setReadLogBook(null)}
          onSave={handleSaveReadDetails}
        />
      )}

      {challengeModalState.open && (
        <ChallengeModal
          year={challengeModalState.year}
          existing={challengeModalState.existing}
          onClose={() =>
            setChallengeModalState((prev) => ({ ...prev, open: false }))
          }
          onSave={handleSaveChallenge}
        />
      )}

      {settingsModalOpen && (
        <SettingsModal
          settings={settings}
          serverStatus={serverStatus}
          cloudConfig={cloudConfig}
          authUserId={authUserId}
          cloudSyncStatus={cloudSyncStatus}
          cloudSyncError={cloudSyncError}
          authEmail={authEmail}
          userDisplayName={userProfile?.displayName}
          lastVellumSyncAt={effectiveLastVellumSyncAt}
          stateSnapshot={state}
          onClose={() => setSettingsModalOpen(false)}
          onSaveSettings={handleSaveSettings}
          onTriggerCloudSync={() => triggerCloudPullAndPush(settings)}
          onGoToFriendsSignIn={() => setActiveTab('friends')}
          onImportState={(imported) => {
            setState(imported);
            showToast('Imported backup data');
          }}
        />
      )}

      {importModalState.open && (
        <ImportModal
          initialMode={importModalState.mode}
          existingAuthors={state.authors}
          hasCurrentYearChallenge={state.challenges.some(
            (c) => c.year === Number(todayStr.slice(0, 4))
          )}
          todayStr={todayStr}
          hardcoverToken={settings.hardcoverToken}
          onClose={() =>
            setImportModalState((prev) => ({ ...prev, open: false }))
          }
          onApplyBatchImport={handleApplyBatchImport}
          onNavigateTab={(tab) => setActiveTab(tab)}
        />
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 animate-fade-up md:bottom-8"
        >
          <div className="max-w-[90vw] rounded-[2px] bg-inverse px-5 py-2.5 font-serif text-[15px] italic text-inverse-ink shadow-lg">
            {toastMessage}
          </div>
        </div>
      )}
    </div>
  );
}
