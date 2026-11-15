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
import {
  areSameCanonicalWork,
  computeTrackedFromUpcoming,
  consolidateDuplicateBooks,
  getCanonicalWorkKey,
  hasEditionDecorationInTitle,
  isCuratedReleasedBook,
  isProtectedUserManualBook,
  isStrictSecondaryReissueTitle,
  pickCanonicalReleaseDate,
  pickCleanerTitle,
  pruneUnengagedAuthorBacklist,
  reconcileRefreshedBookDate,
} from '@/lib/bookDedupe';
import { isCustomCoverUrl, pickPreferredCoverUrl } from '@/lib/coverArt';
import { buildDemoLibrary } from '@/lib/demoLibrary';
import { format, parseISO } from 'date-fns';
import {
  type CloudSyncBroadcastPayload,
  deleteCloudRecords,
  getCurrentSessionAndProfile,
  hasDirtyCloudState,
  mergeLocalAndCloudState,
  pullCloudDelta,
  pullCloudState,
  pushFullStateToCloud,
  resetCloudSyncFingerprints,
  resolveCloudConfig,
  sendMagicLink,
  signOutUser,
  subscribeToAuthChanges,
  subscribeToCloudSyncBroadcast,
  syncCloudSettingsPreference,
  updateUserProfile,
  upsertCloudBooks,
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
const DISMISSED_WORKS_KEY = 'folio_dismissed_works_v1';

const DEFAULT_SETTINGS: AppSettings = {
  hardcoverToken: '',
  supabaseUrl: '',
  supabaseAnonKey: '',
  vellumUrl: 'http://localhost:3030',
  includeAuthorBacklist: false,
};

const EMPTY_STATE: TrackerState = {
  authors: [],
  books: [],
  challenges: [],
};

function normBookMatchKey(title: string, authorName: string): string {
  return getCanonicalWorkKey(title, authorName);
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
  const dismissedWorkKeysRef = useRef<Set<string>>(new Set());
  const demoModeRef = useRef(false);
  demoModeRef.current = demoMode;

  const persistDismissedWorks = useCallback(() => {
    if (demoModeRef.current) return;
    try {
      localStorage.setItem(
        DISMISSED_WORKS_KEY,
        JSON.stringify(Array.from(dismissedWorkKeysRef.current))
      );
    } catch {}
  }, []);

  const markWorkDismissed = useCallback(
    (title: string, authorName: string) => {
      const key = normBookMatchKey(title, authorName);
      if (!key) return;
      dismissedWorkKeysRef.current.add(key);
      persistDismissedWorks();
    },
    [persistDismissedWorks]
  );

  const clearWorkDismissed = useCallback(
    (title: string, authorName: string) => {
      const key = normBookMatchKey(title, authorName);
      if (!key) return;
      if (dismissedWorkKeysRef.current.delete(key)) {
        persistDismissedWorks();
      }
    },
    [persistDismissedWorks]
  );

  const syncDismissedWorksWithBooks = useCallback(
    (books: BookItem[]): BookItem[] => {
      let mutatedRegistry = false;
      for (const b of books) {
        const key = normBookMatchKey(b.title, b.authorName);
        if (!key) continue;
        if (b.hidden && b.readingStatus === 'none') {
          if (!dismissedWorkKeysRef.current.has(key)) {
            dismissedWorkKeysRef.current.add(key);
            mutatedRegistry = true;
          }
        } else if (
          !b.hidden &&
          (b.readingStatus === 'todo' || b.readingStatus === 'read')
        ) {
          if (dismissedWorkKeysRef.current.delete(key)) {
            mutatedRegistry = true;
          }
        }
      }
      if (mutatedRegistry) {
        persistDismissedWorks();
      }
      let anyHiddenApplied = false;
      const mapped = books.map((b) => {
        if (
          !b.hidden &&
          b.readingStatus === 'none' &&
          !b.isOneOff &&
          dismissedWorkKeysRef.current.has(
            normBookMatchKey(b.title, b.authorName)
          )
        ) {
          anyHiddenApplied = true;
          return { ...b, hidden: true };
        }
        return b;
      });
      return anyHiddenApplied ? mapped : books;
    },
    [persistDismissedWorks]
  );

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
  const [isRepairingLedger, setIsRepairingLedger] = useState(false);
  const isSyncingAllRef = useRef(false);
  const syncingAuthorCountRef = useRef(0);

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

      const rawDismissed = localStorage.getItem(DISMISSED_WORKS_KEY);
      if (rawDismissed) {
        const parsedDismissed = JSON.parse(rawDismissed);
        if (Array.isArray(parsedDismissed)) {
          dismissedWorkKeysRef.current = new Set(
            parsedDismissed.filter((x): x is string => typeof x === 'string')
          );
        }
      }

      let loadedIncludeBacklist = false;
      const rawSettings = localStorage.getItem(LOCAL_SETTINGS_KEY);
      if (rawSettings) {
        const parsedSettings = JSON.parse(rawSettings);
        loadedIncludeBacklist = Boolean(parsedSettings?.includeAuthorBacklist);
        setSettings((prev) => ({ ...prev, ...parsedSettings }));
      }

      const rawState = localStorage.getItem(LOCAL_STATE_KEY);
      const isDemo = new URL(window.location.href).searchParams.has('demo');
      if (isDemo) {
        // Preview mode: load a sample library that is never persisted
        setDemoMode(true);
        setState(buildDemoLibrary(getLocalTodayStr()));
      } else if (rawState) {
        const parsed = JSON.parse(rawState);
        if (parsed && Array.isArray(parsed.books)) {
          const localToday = getLocalTodayStr();
          const { books: cleanedBooks, removedIds } = consolidateDuplicateBooks(
            parsed.books || [],
            localToday
          );
          const syncedBooks = syncDismissedWorksWithBooks(cleanedBooks);
          const { books: scopedBooks, prunedIds } = loadedIncludeBacklist
            ? { books: syncedBooks, prunedIds: [] as string[] }
            : pruneUnengagedAuthorBacklist(syncedBooks, localToday);
          if (removedIds.length > 0 || prunedIds.length > 0) {
            deletedBookIdsRef.current.push(...removedIds, ...prunedIds);
          }
          setState({
            authors: parsed.authors || [],
            books: scopedBooks,
            challenges: parsed.challenges || [],
          });
        }
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

    let swReg: ServiceWorkerRegistration | null = null;
    const onSwVis = () => {
      if (document.visibilityState === 'visible') {
        const latestDay = getLocalTodayStr();
        setTodayStr((prev) => (prev === latestDay ? prev : latestDay));
        swReg?.update().catch(() => {});
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          swReg = reg;
          reg.update().catch(() => {});
        })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', onSwVis);
    window.addEventListener('focus', onSwVis);

    setMounted(true);
    return () => {
      document.removeEventListener('visibilitychange', onSwVis);
      window.removeEventListener('focus', onSwVis);
    };
  }, [syncDismissedWorksWithBooks]);

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
              `${x.id}|${x.updatedAt}|${x.hidden ? 1 : 0}|${x.trackedFromUpcoming ? 1 : 0}|${x.releaseDate || ''}|${x.datePrecision}|${x.readingStatus}|${x.finishedAt || ''}|${
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
    async (
      activeSettings: AppSettings,
      explicitUserId?: string | null,
      options?: { replaceLocalCache?: boolean; showFeedback?: boolean }
    ) => {
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
        let prevOwnerId: string | null = null;
        try {
          prevOwnerId = localStorage.getItem(LAST_AUTH_USER_KEY);
        } catch {}

        const shouldReplaceLocal =
          Boolean(options?.replaceLocalCache) ||
          Boolean(prevOwnerId && prevOwnerId !== targetUserId);

        if (shouldReplaceLocal) {
          resetCloudSyncFingerprints(targetUserId);
        }

        const remote = await pullCloudState(cfg, targetUserId);

        const localToday = getLocalTodayStr();
        setTodayStr((prev) => (prev === localToday ? prev : localToday));

        let settledBooksCount = 0;
        const allowFullBacklist = Boolean(activeSettings.includeAuthorBacklist);

        if (shouldReplaceLocal) {
          // Different account or explicit "Reload from cloud": replace local cache cleanly
          dismissedWorkKeysRef.current = new Set();
          persistDismissedWorks();
          const { books: cleanedRemoteBooks, removedIds } =
            consolidateDuplicateBooks(remote.books, localToday);
          const syncedRemoteBooks =
            syncDismissedWorksWithBooks(cleanedRemoteBooks);
          const { books: scopedRemoteBooks, prunedIds } = allowFullBacklist
            ? { books: syncedRemoteBooks, prunedIds: [] as string[] }
            : pruneUnengagedAuthorBacklist(syncedRemoteBooks, localToday);
          const keepIds = new Set(scopedRemoteBooks.map((b) => b.id));
          const orphanRemoteIds = remote.books
            .map((b) => b.id)
            .filter((id) => !keepIds.has(id));
          const allCleanupIds = Array.from(
            new Set([...removedIds, ...prunedIds, ...orphanRemoteIds])
          );

          setState({ ...remote, books: scopedRemoteBooks });
          settledBooksCount = scopedRemoteBooks.filter((b) => !b.hidden).length;

          if (allCleanupIds.length > 0) {
            await deleteCloudRecords(
              cfg,
              targetUserId,
              'tracked_books',
              allCleanupIds
            ).catch(() => {});
          }
          await pushFullStateToCloud(cfg, targetUserId, {
            ...remote,
            books: scopedRemoteBooks,
          });
        } else {
          // Same user or first-time upgrade: drop unengaged local ghosts & backlist bloat
          const rawMerged = mergeLocalAndCloudState(stateRef.current, remote, {
            preferCloudDeletions: prevOwnerId === targetUserId,
          });
          const { books: cleanedMergedBooks, removedIds } =
            consolidateDuplicateBooks(rawMerged.books, localToday);
          const syncedMergedBooks =
            syncDismissedWorksWithBooks(cleanedMergedBooks);
          const { books: scopedMergedBooks, prunedIds } = allowFullBacklist
            ? { books: syncedMergedBooks, prunedIds: [] as string[] }
            : pruneUnengagedAuthorBacklist(syncedMergedBooks, localToday);
          const merged = { ...rawMerged, books: scopedMergedBooks };
          setState(merged);
          settledBooksCount = scopedMergedBooks.filter((b) => !b.hidden).length;

          const keepIds = new Set(scopedMergedBooks.map((b) => b.id));
          const orphanRemoteIds = remote.books
            .map((b) => b.id)
            .filter((id) => !keepIds.has(id));
          const allCleanupIds = Array.from(
            new Set([...removedIds, ...prunedIds, ...orphanRemoteIds])
          );

          if (allCleanupIds.length > 0) {
            await deleteCloudRecords(
              cfg,
              targetUserId,
              'tracked_books',
              allCleanupIds
            ).catch(() => {});
          }
          await pushFullStateToCloud(cfg, targetUserId, merged);
        }

        try {
          localStorage.setItem(LAST_AUTH_USER_KEY, targetUserId);
        } catch {}

        initialCloudSyncDoneRef.current = true;
        lastCloudPullMsRef.current = Date.now();
        setCloudSyncStatus('synced');

        if (options?.showFeedback) {
          showToast(
            options.replaceLocalCache
              ? `Reloaded ${settledBooksCount.toLocaleString()} titles from cloud`
              : `Synced ${settledBooksCount.toLocaleString()} titles across cloud`
          );
        }
      } catch (err) {
        setCloudSyncStatus('error');
        setCloudSyncError(
          err instanceof Error ? err.message : 'Cloud sync failed'
        );
      }
    },
    [authUserId, persistDismissedWorks, syncDismissedWorksWithBooks, showToast]
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
    const applyRemoteBacklistPref = (remotePref?: boolean) => {
      if (typeof remotePref !== 'boolean') return;
      setSettings((prev) => {
        if (Boolean(prev.includeAuthorBacklist) === remotePref) return prev;
        const next = { ...prev, includeAuthorBacklist: remotePref };
        settingsRef.current = next;
        try {
          localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    };

    getCurrentSessionAndProfile(cloudConfig)
      .then((snap) => {
        if (!active) return;
        applyRemoteBacklistPref(snap.includeAuthorBacklist);
        setAuthUserId(snap.userId);
        setAuthEmail(snap.email);
        setUserProfile(snap.profile);
      })
      .catch(() => {});

    const unsubscribe = subscribeToAuthChanges(cloudConfig, (snap) => {
      if (!active) return;
      applyRemoteBacklistPref(snap.includeAuthorBacklist);
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
      triggerCloudPullAndPush(settingsRef.current, authUserId);
    } else {
      initialCloudSyncDoneRef.current = false;
      setCloudSyncStatus('local');
    }
  }, [mounted, demoMode, cloudConfig, authUserId, triggerCloudPullAndPush]);

  // Debounced diff-only background push on state edits when signed in
  const lastCloudPullMsRef = useRef<number>(0);

  useEffect(() => {
    if (!mounted || demoMode || !cloudConfig || !authUserId) return;
    if (!initialCloudSyncDoneRef.current) return;
    // Coalesce multi-chunk background repair & bibliography syncs into a single settled push
    if (isRepairingLedger || isSyncingAll || syncingAuthorIds.size > 0) return;
    if (!hasDirtyCloudState(authUserId, state)) return;

    const timer = setTimeout(async () => {
      const latestState = stateRef.current;
      if (!hasDirtyCloudState(authUserId, latestState)) return;
      try {
        setCloudSyncStatus('syncing');
        await pushFullStateToCloud(cloudConfig, authUserId, latestState);
        setCloudSyncStatus('synced');
        setCloudSyncError(undefined);
      } catch (err) {
        setCloudSyncStatus('error');
        setCloudSyncError(
          err instanceof Error ? err.message : 'Cloud sync failed'
        );
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [
    state,
    cloudConfig,
    authUserId,
    mounted,
    demoMode,
    isRepairingLedger,
    isSyncingAll,
    syncingAuthorIds.size,
  ]);

  // Live sub-second cross-device Realtime sync + incremental delta pull on focus/heartbeat
  useEffect(() => {
    if (!mounted || demoMode || !cloudConfig || !authUserId) return;

    let cancelled = false;
    let deltaInFlight = false;
    let queuedDeltaOpts: {
      explicitBookIds?: string[];
      explicitAuthorIds?: string[];
      includeIdManifest?: boolean;
    } | null = null;
    let lastHiddenAtMs = 0;

    const applyBroadcastDeletions = (payload: CloudSyncBroadcastPayload) => {
      const delBooks = payload.deletedBookIds?.filter(Boolean) || [];
      const delAuthors = payload.deletedAuthorIds?.filter(Boolean) || [];
      const delChallenges = payload.deletedChallengeIds?.filter(Boolean) || [];
      if (
        delBooks.length === 0 &&
        delAuthors.length === 0 &&
        delChallenges.length === 0
      ) {
        return;
      }
      const delBookSet = new Set(delBooks);
      const delAuthorSet = new Set(delAuthors);
      const delChallengeSet = new Set(delChallenges);

      setState((prev) => {
        const nextBooks =
          delBookSet.size > 0
            ? prev.books.filter((b) => !delBookSet.has(b.id))
            : prev.books;
        const nextAuthors =
          delAuthorSet.size > 0
            ? prev.authors.filter((a) => !delAuthorSet.has(a.id))
            : prev.authors;
        const nextChallenges =
          delChallengeSet.size > 0
            ? prev.challenges.filter((c) => !delChallengeSet.has(c.id))
            : prev.challenges;
        if (
          nextBooks.length === prev.books.length &&
          nextAuthors.length === prev.authors.length &&
          nextChallenges.length === prev.challenges.length
        ) {
          return prev;
        }
        return {
          authors: nextAuthors,
          books: nextBooks,
          challenges: nextChallenges,
        };
      });
    };

    const runDeltaRefresh = async (opts?: {
      explicitBookIds?: string[];
      explicitAuthorIds?: string[];
      includeIdManifest?: boolean;
      bypassThrottle?: boolean;
    }) => {
      if (cancelled) return;
      if (!initialCloudSyncDoneRef.current) return;
      if (
        ledgerRepairRunningRef.current ||
        isSyncingAllRef.current ||
        syncingAuthorCountRef.current > 0
      ) {
        return;
      }

      const now = Date.now();
      if (!opts?.bypassThrottle && now - lastCloudPullMsRef.current < 1_500) {
        return;
      }

      if (deltaInFlight) {
        queuedDeltaOpts = {
          explicitBookIds: Array.from(
            new Set([
              ...(queuedDeltaOpts?.explicitBookIds || []),
              ...(opts?.explicitBookIds || []),
            ])
          ),
          explicitAuthorIds: Array.from(
            new Set([
              ...(queuedDeltaOpts?.explicitAuthorIds || []),
              ...(opts?.explicitAuthorIds || []),
            ])
          ),
          includeIdManifest: Boolean(
            queuedDeltaOpts?.includeIdManifest || opts?.includeIdManifest
          ),
        };
        return;
      }

      deltaInFlight = true;
      lastCloudPullMsRef.current = now;

      try {
        const delta = await pullCloudDelta(cloudConfig, authUserId, {
          explicitBookIds: opts?.explicitBookIds,
          explicitAuthorIds: opts?.explicitAuthorIds,
          includeIdManifest: opts?.includeIdManifest,
        });
        if (cancelled) return;

        const hasChanges =
          delta.authors.length > 0 ||
          delta.books.length > 0 ||
          delta.challenges.length > 0 ||
          Boolean(
            delta.remoteAuthorIds ||
              delta.remoteBookIds ||
              delta.remoteChallengeIds
          );

        if (!hasChanges) return;

        const localToday = getLocalTodayStr();
        setTodayStr((prev) => (prev === localToday ? prev : localToday));
        const recentGraceCutoffMs = Date.now() - 2 * 60 * 1000;

        setState((prev) => {
          let nextAuthors = prev.authors;
          if (delta.remoteAuthorIds && delta.remoteAuthorIds.size > 0) {
            nextAuthors = nextAuthors.filter((a) => {
              if (delta.remoteAuthorIds!.has(a.id)) return true;
              const ts = Date.parse(a.updatedAt || a.followedAt || '') || 0;
              return ts >= recentGraceCutoffMs;
            });
          }
          if (delta.authors.length > 0) {
            const authorMap = new Map<string, FollowedAuthor>();
            for (const a of nextAuthors) authorMap.set(a.id, a);
            for (const inc of delta.authors) {
              const cur = authorMap.get(inc.id);
              if (!cur || inc.updatedAt >= cur.updatedAt) {
                authorMap.set(inc.id, inc);
              }
            }
            nextAuthors = Array.from(authorMap.values());
          }

          let nextChallenges = prev.challenges;
          if (delta.remoteChallengeIds) {
            nextChallenges = nextChallenges.filter((c) => {
              if (delta.remoteChallengeIds!.has(c.id)) return true;
              const ts = Date.parse(c.updatedAt || c.createdAt || '') || 0;
              return ts >= recentGraceCutoffMs;
            });
          }
          if (delta.challenges.length > 0) {
            nextChallenges = mergeChallengeLists(
              nextChallenges,
              delta.challenges
            );
          }

          let nextBooks = prev.books;
          if (delta.remoteBookIds && delta.remoteBookIds.size > 0) {
            nextBooks = nextBooks.filter((b) => {
              if (delta.remoteBookIds!.has(b.id)) return true;
              const ts = Date.parse(b.updatedAt || '') || 0;
              return ts >= recentGraceCutoffMs;
            });
          }
          if (delta.books.length > 0) {
            const mergedBooks = mergeBookLists(nextBooks, delta.books);
            const { books: cleanedBooks } = consolidateDuplicateBooks(
              mergedBooks,
              localToday
            );
            const syncedBooks = syncDismissedWorksWithBooks(cleanedBooks);
            nextBooks = settingsRef.current.includeAuthorBacklist
              ? syncedBooks
              : pruneUnengagedAuthorBacklist(syncedBooks, localToday).books;
          }

          const authorsUnchanged =
            nextAuthors.length === prev.authors.length &&
            nextAuthors.every(
              (a, idx) =>
                a.id === prev.authors[idx]?.id &&
                a.updatedAt === prev.authors[idx]?.updatedAt
            );

          const prevFp = computeBridgeFingerprint(prev.books, prev.challenges);
          const nextFp = computeBridgeFingerprint(nextBooks, nextChallenges);
          if (authorsUnchanged && prevFp === nextFp) {
            return prev;
          }
          return {
            authors: nextAuthors,
            books: nextBooks,
            challenges: nextChallenges,
          };
        });
      } catch {
        // Silent background delta refresh
      } finally {
        deltaInFlight = false;
        if (!cancelled && queuedDeltaOpts) {
          const nextOpts = queuedDeltaOpts;
          queuedDeltaOpts = null;
          void runDeltaRefresh({ ...nextOpts, bypassThrottle: true });
        }
      }
    };

    const unsubscribeBroadcast = subscribeToCloudSyncBroadcast(
      cloudConfig,
      authUserId,
      (payload) => {
        if (typeof payload.includeAuthorBacklist === 'boolean') {
          const nextBacklist = payload.includeAuthorBacklist;
          setSettings((prev) => {
            if (Boolean(prev.includeAuthorBacklist) === nextBacklist) {
              return prev;
            }
            const next = { ...prev, includeAuthorBacklist: nextBacklist };
            settingsRef.current = next;
            try {
              localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
            } catch {}
            return next;
          });
          if (!nextBacklist) {
            const localToday = getLocalTodayStr();
            setState((prev) => {
              const { books: pruned, prunedIds } = pruneUnengagedAuthorBacklist(
                prev.books,
                localToday
              );
              return prunedIds.length > 0 ? { ...prev, books: pruned } : prev;
            });
          }
        }
        applyBroadcastDeletions(payload);
        void runDeltaRefresh({
          explicitBookIds: payload.changedBookIds,
          explicitAuthorIds: payload.changedAuthorIds,
          bypassThrottle: true,
        });
      }
    );

    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      const hiddenDurationMs =
        lastHiddenAtMs > 0 ? Date.now() - lastHiddenAtMs : 0;
      lastHiddenAtMs = 0;
      void runDeltaRefresh({
        includeIdManifest: hiddenDurationMs > 45_000,
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAtMs = Date.now();
        return;
      }
      if (document.visibilityState === 'visible') {
        onFocus();
      }
    };

    const heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void runDeltaRefresh({ includeIdManifest: false });
      }
    }, 15_000);

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribeBroadcast();
      clearInterval(heartbeat);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    mounted,
    demoMode,
    cloudConfig,
    authUserId,
    computeBridgeFingerprint,
    syncDismissedWorksWithBooks,
  ]);

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
    async (author: FollowedAuthor, silent = false, forceRefresh = false) => {
      syncingAuthorCountRef.current += 1;
      setSyncingAuthorIds((prev) => new Set(prev).add(author.id));
      try {
        const headers: Record<string, string> = {};
        if (settings.hardcoverToken?.trim()) {
          headers['x-hardcover-token'] = settings.hardcoverToken.trim();
        }
        const localToday = getLocalTodayStr();
        const params = new URLSearchParams({
          authorId: author.id,
          name: author.name,
          source: author.source,
          today: localToday,
        });
        if (author.externalId) {
          params.set('externalId', author.externalId);
        }
        if (forceRefresh) {
          params.set('refresh', '1');
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
        const cloudCleanupIds: string[] = [];

        const allowFullBacklist = Boolean(
          settingsRef.current.includeAuthorBacklist
        );

        setState((prev) => {
          const matchedExistingIds = new Set<string>();
          const nextBooksMap = new Map<string, BookItem>();
          for (const b of prev.books) {
            nextBooksMap.set(b.id, b);
          }

          for (const incoming of fetchedBooks) {
            const matched = prev.books.find(
              (b) =>
                b.id === incoming.id || areSameCanonicalWork(b, incoming)
            );

            if (matched) {
              matchedExistingIds.add(matched.id);
              // Preserve user state (readingStatus, hidden, notes, rating, one-off flag)
              const isUserManualEntry = isProtectedUserManualBook(matched);
              const bestDate = reconcileRefreshedBookDate(
                matched,
                incoming,
                localToday
              );
              const nextTitle = isUserManualEntry
                ? matched.title
                : pickCleanerTitle(matched.title, incoming.title);
              const nextAuthorId = matched.authorId || author.id;
              const nextCover = isCustomCoverUrl(matched.coverUrl)
                ? matched.coverUrl
                : pickPreferredCoverUrl(
                    incoming.coverUrl,
                    matched.coverUrl,
                    incoming.title,
                    matched.title
                  ) || incoming.coverUrl || matched.coverUrl;
              const nextIsbn = matched.isbn || incoming.isbn;
              const nextPages = matched.pageCount || incoming.pageCount;
              const isDismissedWork =
                matched.readingStatus === 'none' &&
                !matched.isOneOff &&
                dismissedWorkKeysRef.current.has(
                  normBookMatchKey(nextTitle, matched.authorName)
                );
              const nextHidden = Boolean(matched.hidden || isDismissedWork);

              const candidateUpdated: BookItem = {
                ...matched,
                title: nextTitle,
                authorId: nextAuthorId,
                coverUrl: nextCover,
                isbn: nextIsbn,
                releaseDate: bestDate.releaseDate,
                datePrecision: bestDate.datePrecision,
                pageCount: nextPages,
                hidden: nextHidden,
              };
              const nextTrackedFromUpcoming = computeTrackedFromUpcoming(
                matched,
                candidateUpdated,
                localToday
              )
                ? true
                : undefined;

              const didBookChange =
                nextTitle !== matched.title ||
                nextAuthorId !== matched.authorId ||
                nextCover !== matched.coverUrl ||
                nextIsbn !== matched.isbn ||
                bestDate.releaseDate !== matched.releaseDate ||
                bestDate.datePrecision !== matched.datePrecision ||
                nextPages !== matched.pageCount ||
                nextHidden !== Boolean(matched.hidden) ||
                Boolean(nextTrackedFromUpcoming) !==
                  Boolean(matched.trackedFromUpcoming);

              if (didBookChange) {
                nextBooksMap.set(matched.id, {
                  ...candidateUpdated,
                  trackedFromUpcoming: nextTrackedFromUpcoming,
                  updatedAt: nowIso,
                });
              }
            } else {
              const incomingIsUpcoming =
                classifyReleaseTiming(incoming, localToday) === 'upcoming';
              if (!incomingIsUpcoming && !allowFullBacklist) {
                continue;
              }
              const isDismissedWork = dismissedWorkKeysRef.current.has(
                normBookMatchKey(incoming.title, incoming.authorName)
              );
              const nextHidden = Boolean(incoming.hidden || isDismissedWork);
              const { description: _unusedDesc, ...slimIncoming } = incoming;
              nextBooksMap.set(incoming.id, {
                ...slimIncoming,
                authorId: author.id,
                hidden: nextHidden,
                trackedFromUpcoming:
                  incomingIsUpcoming && !nextHidden ? true : undefined,
                updatedAt: nowIso,
              });
            }
          }

          // Prune stale unengaged catalog duplicates previously fetched for this author
          // that are no longer part of the canonical bibliography
          if (fetchedBooks.length > 0) {
            for (const b of prev.books) {
              const isStaleUnengagedAuthorRow =
                b.authorId === author.id &&
                !matchedExistingIds.has(b.id) &&
                b.readingStatus === 'none' &&
                !b.hidden &&
                !b.isManual &&
                !b.isOneOff &&
                !b.trackedFromUpcoming &&
                !b.rating &&
                !b.notes &&
                !b.vellumBookId;
              if (isStaleUnengagedAuthorRow) {
                nextBooksMap.delete(b.id);
                cloudCleanupIds.push(b.id);
              }
            }
          }

          const { books: consolidatedBooks, removedIds } =
            consolidateDuplicateBooks(
              Array.from(nextBooksMap.values()),
              localToday
            );
          const { books: scopedBooks, prunedIds } = allowFullBacklist
            ? { books: consolidatedBooks, prunedIds: [] as string[] }
            : pruneUnengagedAuthorBacklist(consolidatedBooks, localToday);
          if (removedIds.length > 0 || prunedIds.length > 0) {
            cloudCleanupIds.push(...removedIds, ...prunedIds);
          }

          const updatedAuthors = prev.authors.map((a) =>
            a.id === author.id
              ? { ...a, lastSyncedAt: nowIso, updatedAt: nowIso }
              : a
          );

          return {
            ...prev,
            authors: updatedAuthors,
            books: scopedBooks,
          };
        });

        if (cloudCleanupIds.length > 0) {
          deletedBookIdsRef.current.push(...cloudCleanupIds);
          if (cloudConfig && authUserId) {
            deleteCloudRecords(
              cloudConfig,
              authUserId,
              'tracked_books',
              Array.from(new Set(cloudCleanupIds))
            ).catch(() => {});
          }
        }

        if (!silent) {
          const upcomingCount = fetchedBooks.filter(
            (b) => classifyReleaseTiming(b, todayStr) === 'upcoming'
          ).length;
          showToast(
            allowFullBacklist
              ? `Synced ${fetchedBooks.length} books for ${author.name}${
                  upcomingCount > 0 ? ` (${upcomingCount} upcoming)` : ''
                }`
              : upcomingCount > 0
              ? `Synced ${author.name} (${upcomingCount} upcoming)`
              : `Checked ${author.name} (no new upcoming releases)`
          );
        }
      } catch (err) {
        if (!silent) {
          showToast(
            err instanceof Error ? err.message : `Could not sync ${author.name}`
          );
        }
      } finally {
        syncingAuthorCountRef.current = Math.max(
          0,
          syncingAuthorCountRef.current - 1
        );
        setSyncingAuthorIds((prev) => {
          const next = new Set(prev);
          next.delete(author.id);
          return next;
        });
      }
    },
    [settings.hardcoverToken, cloudConfig, authUserId, showToast, todayStr]
  );

  // Repairs missing/placeholder release dates, 2024-2026 paperback/deluxe/Book Club reissues,
  // publisher release-date pushbacks, and post-finish dates across tracked & one-off books.
  const ledgerRepairRunningRef = useRef(false);
  const autoRepairInFlightKeyRef = useRef<string | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const repairTrackedBookDatesAndReissues = useCallback(async (): Promise<{
    updatedCount: number;
    ok: boolean;
  }> => {
    if (demoMode || ledgerRepairRunningRef.current) {
      return { updatedCount: 0, ok: false };
    }
    ledgerRepairRunningRef.current = true;
    setIsRepairingLedger(true);

    try {
      const localToday = getLocalTodayStr();
      const canAutoRepairBook = (b: BookItem) => {
        if (b.id.startsWith('demo:')) return false;
        if (isProtectedUserManualBook(b)) return false;
        return true;
      };
      const hasImpossibleFinishVsRelease = (b: BookItem): boolean =>
        Boolean(
          b.finishedAt &&
            b.releaseDate &&
            /^\d{4}-\d{2}-\d{2}$/.test(b.finishedAt) &&
            b.releaseDate > b.finishedAt
        );
      const candidatePriority = (b: BookItem): number => {
        if (
          hasImpossibleFinishVsRelease(b) ||
          hasEditionDecorationInTitle(b.title) ||
          isStrictSecondaryReissueTitle(b.title) ||
          Boolean(b.releaseDate && b.releaseDate >= '2024')
        ) {
          return 0;
        }
        if (!b.releaseDate || b.datePrecision === 'unknown') {
          return 1;
        }
        return 2;
      };
      const allowFullBacklist = Boolean(
        settingsRef.current.includeAuthorBacklist
      );
      const candidates = stateRef.current.books
        .filter((b) => {
          if (!canAutoRepairBook(b)) return false;
          if (
            !allowFullBacklist &&
            classifyReleaseTiming(b, localToday) === 'released' &&
            !isCuratedReleasedBook(b)
          ) {
            return false;
          }
          if (!b.releaseDate || b.datePrecision === 'unknown') return true;
          if (hasImpossibleFinishVsRelease(b)) return true;
          if (b.releaseDate >= '2024') return true;
          if (
            hasEditionDecorationInTitle(b.title) ||
            isStrictSecondaryReissueTitle(b.title)
          ) {
            return true;
          }
          if (
            b.releaseDate >= '2020' &&
            (b.datePrecision !== 'day' || /-(01-01|12-31)$/.test(b.releaseDate))
          ) {
            return true;
          }
          return false;
        })
        .sort((a, b) => {
          const hidDiff = Number(Boolean(a.hidden)) - Number(Boolean(b.hidden));
          if (hidDiff !== 0) return hidDiff;
          const prioDiff = candidatePriority(a) - candidatePriority(b);
          if (prioDiff !== 0) return prioDiff;
          return (b.releaseDate || '').localeCompare(a.releaseDate || '');
        })
        .slice(0, 800);

      if (candidates.length === 0) {
        return { updatedCount: 0, ok: true };
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const hcTok = settingsRef.current.hardcoverToken?.trim();
      if (hcTok) {
        headers['x-hardcover-token'] = hcTok;
      }

      let updatedCount = 0;
      let allChunksOk = true;
      const chunkSize = 25;

      for (let i = 0; i < candidates.length; i += chunkSize) {
        if (unmountedRef.current) {
          allChunksOk = false;
          break;
        }
        const slice = candidates.slice(i, i + chunkSize);
        const items = slice.map((b) => ({
          clientKey: b.id,
          title: b.title,
          authorName: b.authorName,
          isbn13: b.isbn && b.isbn.length === 13 ? b.isbn : undefined,
          isbn10: b.isbn && b.isbn.length === 10 ? b.isbn : undefined,
        }));

        let res: Response;
        try {
          res = await fetch('/api/import/enrich', {
            method: 'POST',
            headers,
            body: JSON.stringify({ action: 'books', items, todayStr: localToday }),
          });
        } catch {
          allChunksOk = false;
          continue;
        }
        if (!res.ok) {
          allChunksOk = false;
          continue;
        }
        const payload = await res.json();
        const matches = payload?.matches || {};
        if (Object.keys(matches).length === 0) continue;

        const nowIso = new Date().toISOString();
        const removedBatchIds: string[] = [];

        setState((prev) => {
          let changedInBatch = false;
          const nextBooks = prev.books.map((b) => {
            const m = matches[b.id];
            if (!m) return b;
            if (!canAutoRepairBook(b)) return b;

            const bestDate = reconcileRefreshedBookDate(
              b,
              {
                ...b,
                source: m.source || b.source,
                title: m.title || b.title,
                releaseDate: m.releaseDate,
                datePrecision: m.datePrecision,
                isManual: false,
                userEdited: false,
              },
              localToday
            );
            const nextTitle = pickCleanerTitle(b.title, m.title || b.title);
            const nextCover = isCustomCoverUrl(b.coverUrl)
              ? b.coverUrl
              : pickPreferredCoverUrl(
                  b.coverUrl,
                  m.coverUrl,
                  b.title,
                  m.title || b.title
                ) || b.coverUrl || m.coverUrl;
            const nextIsbn = b.isbn || m.isbn;
            const nextPages = b.pageCount || m.pageCount;

            const candidateUpdated: BookItem = {
              ...b,
              title: nextTitle,
              releaseDate: bestDate.releaseDate,
              datePrecision: bestDate.datePrecision,
              coverUrl: nextCover,
              isbn: nextIsbn,
              pageCount: nextPages,
            };
            const nextTrackedFromUpcoming = computeTrackedFromUpcoming(
              b,
              candidateUpdated,
              localToday
            )
              ? true
              : undefined;

            const didChange =
              nextTitle !== b.title ||
              bestDate.releaseDate !== b.releaseDate ||
              bestDate.datePrecision !== b.datePrecision ||
              nextCover !== b.coverUrl ||
              nextIsbn !== b.isbn ||
              nextPages !== b.pageCount ||
              Boolean(nextTrackedFromUpcoming) !==
                Boolean(b.trackedFromUpcoming);

            if (!didChange) return b;
            changedInBatch = true;
            updatedCount += 1;

            return {
              ...candidateUpdated,
              trackedFromUpcoming: nextTrackedFromUpcoming,
              updatedAt: nowIso,
            };
          });

          if (!changedInBatch) return prev;

          const { books: consolidated, removedIds } = consolidateDuplicateBooks(
            nextBooks,
            localToday
          );
          const { books: scoped, prunedIds } = settingsRef.current
            .includeAuthorBacklist
            ? { books: consolidated, prunedIds: [] as string[] }
            : pruneUnengagedAuthorBacklist(consolidated, localToday);
          if (removedIds.length > 0 || prunedIds.length > 0) {
            removedBatchIds.push(...removedIds, ...prunedIds);
          }

          return {
            ...prev,
            books: scoped,
          };
        });

        if (removedBatchIds.length > 0) {
          deletedBookIdsRef.current.push(...removedBatchIds);
          if (cloudConfig && authUserId) {
            deleteCloudRecords(
              cloudConfig,
              authUserId,
              'tracked_books',
              Array.from(new Set(removedBatchIds))
            ).catch(() => {});
          }
        }
      }

      return { updatedCount, ok: allChunksOk && !unmountedRef.current };
    } catch {
      return { updatedCount: 0, ok: false };
    } finally {
      ledgerRepairRunningRef.current = false;
      if (!unmountedRef.current) {
        setIsRepairingLedger(false);
      }
    }
  }, [demoMode, cloudConfig, authUserId]);

  // Run one-time automatic background repair on existing ledgers without being cancelled
  // mid-flight when cloudSyncStatus transitions between 'synced' and 'syncing'.
  useEffect(() => {
    if (!mounted || demoMode) return;
    if (cloudConfig && (!authUserId || cloudSyncStatus !== 'synced')) return;
    if (
      stateRef.current.books.length === 0 &&
      stateRef.current.authors.length === 0
    ) {
      return;
    }

    const repairKey = `folio:ledger-repair:v7:${authUserId || 'local'}`;
    if (autoRepairInFlightKeyRef.current === repairKey) return;
    try {
      if (localStorage.getItem(repairKey) === '1') return;
    } catch {
      return;
    }

    autoRepairInFlightKeyRef.current = repairKey;
    isSyncingAllRef.current = true;
    setIsSyncingAll(true);

    (async () => {
      try {
        const repairRes = await repairTrackedBookDatesAndReissues();
        const authorsSnapshot = [...stateRef.current.authors];
        for (let i = 0; i < authorsSnapshot.length; i++) {
          if (unmountedRef.current) return;
          await syncAuthorCatalog(authorsSnapshot[i], true, true);
          if (i + 1 < authorsSnapshot.length) {
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        if (repairRes.ok && !unmountedRef.current) {
          try {
            localStorage.setItem(repairKey, '1');
          } catch {}
        }
      } finally {
        isSyncingAllRef.current = false;
        if (!unmountedRef.current) {
          setIsSyncingAll(false);
        }
        if (autoRepairInFlightKeyRef.current === repairKey) {
          autoRepairInFlightKeyRef.current = null;
        }
      }
    })();
  }, [
    mounted,
    demoMode,
    cloudConfig,
    authUserId,
    cloudSyncStatus,
    repairTrackedBookDatesAndReissues,
    syncAuthorCatalog,
  ]);

  const handleSyncAllAuthors = useCallback(async () => {
    if (
      (state.authors.length === 0 && state.books.length === 0) ||
      isSyncingAll
    ) {
      return;
    }
    isSyncingAllRef.current = true;
    setIsSyncingAll(true);
    try {
      if (cloudConfig && authUserId) {
        await triggerCloudPullAndPush(settingsRef.current, authUserId);
      }
      await repairTrackedBookDatesAndReissues();
      const currentAuthors = [...stateRef.current.authors];
      for (const author of currentAuthors) {
        await syncAuthorCatalog(author, true, true);
      }
      showToast(
        currentAuthors.length > 0
          ? `Refreshed & deduplicated ${currentAuthors.length} authors + tracked dates`
          : 'Refreshed tracked book release dates'
      );
    } finally {
      isSyncingAllRef.current = false;
      setIsSyncingAll(false);
    }
  }, [
    state.authors.length,
    state.books.length,
    isSyncingAll,
    cloudConfig,
    authUserId,
    triggerCloudPullAndPush,
    syncAuthorCatalog,
    repairTrackedBookDatesAndReissues,
    showToast,
  ]);

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
      clearWorkDismissed(candidate.title, candidate.authorName);

      const snap = stateRef.current;
      const matchNorm = normBookMatchKey(candidate.title, candidate.authorName);
      const existingSnap = snap.books.find(
        (b) =>
          b.id === candidate.id ||
          normBookMatchKey(b.title, b.authorName) === matchNorm
      );
      const matchedFollowedSnap = snap.authors.find(
        (a) =>
          a.name.toLowerCase().trim() ===
          candidate.authorName.toLowerCase().trim()
      );

      const finalItem: BookItem = existingSnap
        ? {
            ...existingSnap,
            hidden: false,
            ...updater(existingSnap),
            updatedAt: nowIso,
          }
        : {
            id: candidate.id,
            source: candidate.source,
            externalId: candidate.externalId,
            title: candidate.title,
            authorName: candidate.authorName,
            authorId: matchedFollowedSnap?.id,
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
            ...updater(undefined),
          };

      setState((prev) => {
        const existingIdx = prev.books.findIndex(
          (b) =>
            b.id === candidate.id ||
            normBookMatchKey(b.title, b.authorName) === matchNorm
        );
        if (existingIdx >= 0) {
          const copy = [...prev.books];
          copy[existingIdx] = finalItem;
          return { ...prev, books: copy };
        }
        return { ...prev, books: [...prev.books, finalItem] };
      });

      if (cloudConfig && authUserId) {
        upsertCloudBooks(cloudConfig, authUserId, [finalItem]).catch(() => {});
      }

      return finalItem;
    },
    [clearWorkDismissed, cloudConfig, authUserId]
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
      if (nextStatus === 'todo') {
        clearWorkDismissed(book.title, book.authorName);
      }

      const updatedBook: BookItem = {
        ...book,
        hidden: false,
        readingStatus: nextStatus,
        addedToTodoAt: nextStatus === 'todo' ? nowIso : undefined,
        updatedAt: nowIso,
      };

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) => (b.id === book.id ? updatedBook : b)),
      }));

      if (cloudConfig && authUserId) {
        upsertCloudBooks(cloudConfig, authUserId, [updatedBook]).catch(
          () => {}
        );
      }

      showToast(
        nextStatus === 'todo'
          ? `Added "${book.title}" to To-Do`
          : `Removed "${book.title}" from To-Do`
      );
    },
    [clearWorkDismissed, cloudConfig, authUserId, showToast]
  );

  const handleToggleRead = useCallback(
    (book: BookItem) => {
      const nowIso = new Date().toISOString();
      const nextStatus: ReadingStatus =
        book.readingStatus === 'read' ? 'none' : 'read';
      if (nextStatus === 'read') {
        clearWorkDismissed(book.title, book.authorName);
      }

      const updatedBook: BookItem = {
        ...book,
        hidden: false,
        readingStatus: nextStatus,
        finishedAt:
          nextStatus === 'read' ? book.finishedAt || todayStr : undefined,
        updatedAt: nowIso,
      };

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) => (b.id === book.id ? updatedBook : b)),
      }));

      if (cloudConfig && authUserId) {
        upsertCloudBooks(cloudConfig, authUserId, [updatedBook]).catch(
          () => {}
        );
      }

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
    [
      todayStr,
      state.challenges,
      clearWorkDismissed,
      cloudConfig,
      authUserId,
      showToast,
    ]
  );

  const handleSaveReadDetails = useCallback(
    (updates: { finishedAt?: string; rating?: number; notes?: string }) => {
      if (!readLogBook) return;
      const nowIso = new Date().toISOString();
      clearWorkDismissed(readLogBook.title, readLogBook.authorName);

      const updatedBook: BookItem = {
        ...readLogBook,
        hidden: false,
        readingStatus: 'read',
        finishedAt: updates.finishedAt,
        rating: updates.rating,
        notes: updates.notes,
        updatedAt: nowIso,
      };

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) =>
          b.id === readLogBook.id ? updatedBook : b
        ),
      }));

      if (cloudConfig && authUserId) {
        upsertCloudBooks(cloudConfig, authUserId, [updatedBook]).catch(
          () => {}
        );
      }

      setReadLogBook(null);
      showToast('Updated reading log');
    },
    [readLogBook, clearWorkDismissed, cloudConfig, authUserId, showToast]
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
      clearWorkDismissed(data.title, data.authorName);

      if (data.id) {
        const buildUpdated = (b: BookItem): BookItem => {
          const userEditedBiblio =
            data.title !== b.title ||
            data.authorName !== b.authorName ||
            parsedDate.releaseDate !== b.releaseDate ||
            parsedDate.datePrecision !== b.datePrecision;
          return {
            ...b,
            hidden: false,
            title: data.title,
            authorName: data.authorName,
            authorId: data.authorId,
            coverUrl: data.coverUrl,
            releaseDate: parsedDate.releaseDate,
            datePrecision: parsedDate.datePrecision,
            isOneOff: data.isOneOff,
            userEdited: Boolean(b.userEdited || userEditedBiblio),
            isManual: Boolean(
              (b.isManual && b.id.startsWith('manual:book:')) ||
                b.userEdited ||
                userEditedBiblio
            ),
            readingStatus: data.readingStatus,
            addedToTodoAt:
              data.readingStatus === 'todo'
                ? b.addedToTodoAt || nowIso
                : undefined,
            finishedAt:
              data.readingStatus === 'read' ? data.finishedAt : undefined,
            updatedAt: nowIso,
          };
        };
        const snapMatch = stateRef.current.books.find((b) => b.id === data.id);
        const savedItem = snapMatch ? buildUpdated(snapMatch) : null;

        setState((prev) => ({
          ...prev,
          books: prev.books.map((b) =>
            b.id === data.id ? buildUpdated(b) : b
          ),
        }));
        if (cloudConfig && authUserId && savedItem) {
          upsertCloudBooks(cloudConfig, authUserId, [savedItem]).catch(
            () => {}
          );
        }
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
          userEdited: true,
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
        if (cloudConfig && authUserId) {
          upsertCloudBooks(cloudConfig, authUserId, [newBook]).catch(() => {});
        }
        showToast(`Added "${data.title}"`);
      }

      setBookModalState({ open: false });
    },
    [clearWorkDismissed, cloudConfig, authUserId, showToast]
  );

  const handleRemoveOrHideBook = useCallback(
    (book: BookItem) => {
      const nowIso = new Date().toISOString();
      // Only hard-delete purely hand-entered manual rows; keep hidden tombstones for all
      // catalog/one-off/imported works so author syncs and cloud merges never resurrect them.
      if (book.id.startsWith('manual:book:')) {
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
        return;
      }

      if (book.readingStatus !== 'read') {
        markWorkDismissed(book.title, book.authorName);
      }

      const toHiddenRow = (b: BookItem): BookItem => ({
        ...b,
        hidden: true,
        isOneOff: false,
        trackedFromUpcoming: undefined,
        readingStatus: b.readingStatus === 'todo' ? 'none' : b.readingStatus,
        addedToTodoAt: b.readingStatus === 'todo' ? undefined : b.addedToTodoAt,
        updatedAt: nowIso,
      });

      const shouldHideRow = (b: BookItem): boolean => {
        if (b.id === book.id) return true;
        return (
          book.readingStatus !== 'read' &&
          b.readingStatus !== 'read' &&
          areSameCanonicalWork(b, book)
        );
      };

      const hiddenRows = stateRef.current.books
        .filter(shouldHideRow)
        .map(toHiddenRow);

      setState((prev) => ({
        ...prev,
        books: prev.books.map((b) => (shouldHideRow(b) ? toHiddenRow(b) : b)),
      }));

      if (cloudConfig && authUserId && hiddenRows.length > 0) {
        upsertCloudBooks(cloudConfig, authUserId, hiddenRows).catch(() => {});
      }

      showToast(
        book.isOneOff && !book.authorId
          ? `Removed "${book.title}"`
          : `Hid "${book.title}" from feed`
      );
    },
    [cloudConfig, authUserId, markWorkDismissed, showToast]
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
      clearWorkDismissed(item.title, item.authorName);
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
    [clearWorkDismissed, showToast]
  );

  const handleSaveSettings = useCallback(
    (next: AppSettings) => {
      const prevBacklist = Boolean(settingsRef.current.includeAuthorBacklist);
      const nextBacklist = Boolean(next.includeAuthorBacklist);
      settingsRef.current = next;
      setSettings(next);
      try {
        localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
      } catch {}

      if (prevBacklist !== nextBacklist) {
        const prefPromise =
          cloudConfig && authUserId
            ? syncCloudSettingsPreference(cloudConfig, authUserId, {
                includeAuthorBacklist: nextBacklist,
              }).catch(() => {})
            : Promise.resolve();

        if (!nextBacklist) {
          const localToday = getLocalTodayStr();
          const { books: prunedBooks, prunedIds } =
            pruneUnengagedAuthorBacklist(stateRef.current.books, localToday);
          if (prunedIds.length > 0) {
            deletedBookIdsRef.current.push(...prunedIds);
            setState((prev) => ({ ...prev, books: prunedBooks }));
            if (cloudConfig && authUserId) {
              deleteCloudRecords(
                cloudConfig,
                authUserId,
                'tracked_books',
                prunedIds
              ).catch(() => {});
            }
          }
          showToast('Released set to Upcoming + Goodreads & manual books');
          return;
        } else {
          showToast(
            stateRef.current.authors.length > 0
              ? 'Full author backlists enabled — syncing authors…'
              : 'Full author backlists enabled'
          );
          if (stateRef.current.authors.length > 0) {
            void prefPromise.then(() => handleSyncAllAuthors());
          }
          return;
        }
      }

      showToast('Settings saved');
    },
    [cloudConfig, authUserId, handleSyncAllAuthors, showToast]
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
      for (const incoming of payload.booksToUpsert) {
        if (incoming.readingStatus !== 'none' || incoming.isOneOff) {
          clearWorkDismissed(incoming.title, incoming.authorName);
        }
      }

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

        const { books: deduplicatedImportBooks } = consolidateDuplicateBooks(
          Array.from(booksMap.values()),
          todayStr
        );
        const scopedImportBooks = settingsRef.current.includeAuthorBacklist
          ? deduplicatedImportBooks
          : pruneUnengagedAuthorBacklist(deduplicatedImportBooks, todayStr).books;

        return {
          authors: nextAuthors,
          books: scopedImportBooks,
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
    [syncAuthorCatalog, clearWorkDismissed, todayStr]
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
        (b) =>
          classifyReleaseTiming(b, todayStr) === 'released' &&
          (demoMode ||
            Boolean(settings.includeAuthorBacklist) ||
            isCuratedReleasedBook(b))
      ),
    [visibleBooks, todayStr, demoMode, settings.includeAuthorBacklist]
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

              {cloudConfig && !authUserId && !demoMode && (
                <button
                  type="button"
                  onClick={() => setActiveTab('friends')}
                  title="Sign in to sync this device with your cloud library"
                  className="btn btn-outline btn-sm mr-1 text-claret"
                >
                  Sign in
                </button>
              )}

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
            isSyncing={
              isSyncingAll || isRepairingLedger || syncingAuthorIds.size > 0
            }
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
            includeAuthorBacklist={Boolean(settings.includeAuthorBacklist)}
            isSyncing={
              isSyncingAll || isRepairingLedger || syncingAuthorIds.size > 0
            }
            onSyncAllAuthors={handleSyncAllAuthors}
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
            onRemoveOrHideBook={handleRemoveOrHideBook}
            onSelectAuthor={(authorId) => {
              setReleasedAuthorFilter(authorId);
              setActiveTab('released');
            }}
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
            onSyncAuthor={(author) => syncAuthorCatalog(author, false, true)}
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
          hardcoverToken={settings.hardcoverToken}
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
          onEditBookDetails={() => {
            const target = readLogBook;
            setReadLogBook(null);
            setBookModalState({ open: true, book: target });
          }}
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
          onTriggerCloudSync={() =>
            triggerCloudPullAndPush(settings, undefined, { showFeedback: true })
          }
          onResetLocalFromCloud={() =>
            triggerCloudPullAndPush(settings, undefined, {
              replaceLocalCache: true,
              showFeedback: true,
            })
          }
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
