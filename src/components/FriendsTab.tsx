'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trophy,
  UserPlus,
  Users,
} from 'lucide-react';
import { AuthorAvatar, BookCover } from '@/components/BookCover';
import { countWord, EmptyState, PageHeader, plural, Rating, Tabline, toRoman } from '@/components/ui';
import {
  CloudConnectionConfig,
  createFriendGroup,
  fetchGroupFeedAndStandings,
  fetchUserFriendGroups,
  joinFriendGroupByCode,
  leaveFriendGroup,
  signInWithEmailPassword,
  signUpWithEmailPassword,
  updateAccountPassword,
} from '@/lib/cloudSync';
import { formatReleaseDate } from '@/lib/dates';
import {
  BookItem,
  FriendChallengeStanding,
  FriendFinishedFeedItem,
  FriendGroup,
  ReadingChallenge,
  UserProfile,
} from '@/types/books';

function normMatchKey(title: string, authorName: string): string {
  const t = title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .split(':')[0]
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const a = authorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${t}::${a}`;
}

interface FriendsTabProps {
  cloudConfig: CloudConnectionConfig | null;
  authUserId: string | null;
  authEmail?: string;
  userProfile: UserProfile | null;
  pendingJoinCode: string | null;
  onClearPendingJoinCode: () => void;
  personalBooks: BookItem[];
  personalChallenges: ReadingChallenge[];
  todayStr: string;
  onOpenSettings: () => void;
  onOpenChallengeModal: (year: number, existing?: ReadingChallenge) => void;
  onSendMagicLink: (email: string, displayName?: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  onUpdateProfile: (updates: {
    displayName?: string;
    shareActivity?: boolean;
  }) => Promise<void>;
  onAddFriendBookToTodo: (item: FriendFinishedFeedItem) => void;
  onShowToast: (msg: string) => void;
}

export function FriendsTab({
  cloudConfig,
  authUserId,
  authEmail,
  userProfile,
  pendingJoinCode,
  onClearPendingJoinCode,
  personalBooks,
  personalChallenges,
  todayStr,
  onOpenSettings,
  onOpenChallengeModal,
  onSendMagicLink,
  onSignOut,
  onUpdateProfile,
  onAddFriendBookToTodo,
  onShowToast,
}: FriendsTabProps) {
  const currentYear = Number(todayStr.slice(0, 4)) || new Date().getFullYear();

  // Auth sign-in / sign-up form state
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | 'magic'>('signin');
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [sendingLink, setSendingLink] = useState(false);
  const [magicLinkSentTo, setMagicLinkSentTo] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Profile inline editing & password setting state
  const [editingName, setEditingName] = useState(false);
  const [draftDisplayName, setDraftDisplayName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Friend Groups state
  const [groups, setGroups] = useState<FriendGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupActionMode, setGroupActionMode] = useState<
    'none' | 'create' | 'join'
  >('none');
  const [newGroupName, setNewGroupName] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [submittingGroupAction, setSubmittingGroupAction] = useState(false);
  const [copiedType, setCopiedType] = useState<'link' | 'code' | null>(null);

  // Group Feed & Challenge Standings state
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [standings, setStandings] = useState<FriendChallengeStanding[]>([]);
  const [feedItems, setFeedItems] = useState<FriendFinishedFeedItem[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<'all' | 'friends' | 'reviewed'>(
    'all'
  );

  // Lookup map of user's own books for 1-tap To-Do / Read badges
  const personalBookStatusMap = useMemo(() => {
    const byId = new Map<string, BookItem>();
    const byNorm = new Map<string, BookItem>();
    for (const b of personalBooks) {
      byId.set(b.id, b);
      byNorm.set(normMatchKey(b.title, b.authorName), b);
    }
    return { byId, byNorm };
  }, [personalBooks]);

  const loadGroups = useCallback(async () => {
    if (!cloudConfig || !authUserId) {
      setGroups([]);
      setSelectedGroupId(null);
      return;
    }
    setLoadingGroups(true);
    setFeedError(null);
    try {
      const list = await fetchUserFriendGroups(cloudConfig);
      setGroups(list);
      setSelectedGroupId((prev) => {
        if (prev && list.some((g) => g.id === prev)) return prev;
        return list[0]?.id || null;
      });
    } catch (err) {
      setFeedError(
        err instanceof Error
          ? err.message
          : 'Could not load friend groups. Make sure supabase/schema.sql has been run.'
      );
    } finally {
      setLoadingGroups(false);
    }
  }, [cloudConfig, authUserId]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Auto-join pending invite code once signed in
  useEffect(() => {
    if (!cloudConfig || !authUserId || !pendingJoinCode) return;
    let cancelled = false;

    (async () => {
      try {
        const joined = await joinFriendGroupByCode(
          cloudConfig,
          pendingJoinCode
        );
        if (cancelled) return;
        onClearPendingJoinCode();
        onShowToast(`Joined "${joined.name}"!`);
        const list = await fetchUserFriendGroups(cloudConfig);
        if (!cancelled) {
          setGroups(list);
          setSelectedGroupId(joined.id);
        }
      } catch (err) {
        if (!cancelled) {
          setJoinCodeInput(pendingJoinCode);
          setGroupActionMode('join');
          onClearPendingJoinCode();
          onShowToast(
            err instanceof Error ? err.message : 'Could not join with invite code'
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    cloudConfig,
    authUserId,
    pendingJoinCode,
    onClearPendingJoinCode,
    onShowToast,
  ]);

  const loadGroupActivity = useCallback(async () => {
    if (!cloudConfig || !authUserId || !selectedGroupId) {
      setStandings([]);
      setFeedItems([]);
      return;
    }

    setLoadingFeed(true);
    setFeedError(null);
    try {
      const { standings: nextStandings, feed: nextFeed } =
        await fetchGroupFeedAndStandings(
          cloudConfig,
          selectedGroupId,
          selectedYear,
          authUserId
        );
      setStandings(nextStandings);
      setFeedItems(nextFeed);
    } catch (err) {
      setFeedError(
        err instanceof Error ? err.message : 'Failed to load group feed.'
      );
    } finally {
      setLoadingFeed(false);
    }
  }, [cloudConfig, authUserId, selectedGroupId, selectedYear]);

  useEffect(() => {
    loadGroupActivity();
  }, [loadGroupActivity]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );

  const myChallengeForSelectedYear = useMemo(
    () => personalChallenges.find((c) => c.year === selectedYear),
    [personalChallenges, selectedYear]
  );

  const filteredFeedItems = useMemo(() => {
    return feedItems.filter((item) => {
      if (feedFilter === 'friends' && item.isCurrentUser) return false;
      if (
        feedFilter === 'reviewed' &&
        !item.rating &&
        !(item.notes && item.notes.trim().length > 0)
      ) {
        return false;
      }
      return true;
    });
  }, [feedItems, feedFilter]);

  const handleMagicLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput.trim()) return;
    setSendingLink(true);
    setAuthError(null);
    try {
      await onSendMagicLink(emailInput.trim(), nameInput.trim() || undefined);
      setMagicLinkSentTo(emailInput.trim());
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Could not send magic link.'
      );
    } finally {
      setSendingLink(false);
    }
  };

  const handlePasswordAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudConfig || !emailInput.trim() || !passwordInput) return;
    setSendingLink(true);
    setAuthError(null);
    try {
      if (authMode === 'signin') {
        await signInWithEmailPassword(
          cloudConfig,
          emailInput.trim(),
          passwordInput
        );
        onShowToast('Signed in');
      } else {
        const redirectTo =
          typeof window !== 'undefined' ? window.location.origin : '';
        const res = await signUpWithEmailPassword(
          cloudConfig,
          emailInput.trim(),
          passwordInput,
          redirectTo,
          nameInput.trim() || undefined
        );
        if (res.signedInImmediately) {
          onShowToast('Account created & signed in');
        } else {
          setMagicLinkSentTo(emailInput.trim());
        }
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Authentication failed.'
      );
    } finally {
      setSendingLink(false);
    }
  };

  const handleSaveNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudConfig || !newAccountPassword) return;
    setSavingPassword(true);
    try {
      await updateAccountPassword(cloudConfig, newAccountPassword);
      setNewAccountPassword('');
      setSettingPassword(false);
      onShowToast('Password saved — you can now sign in with it on any device');
    } catch (err) {
      onShowToast(
        err instanceof Error ? err.message : 'Could not update password'
      );
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSaveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftDisplayName.trim()) return;
    setSavingProfile(true);
    try {
      await onUpdateProfile({ displayName: draftDisplayName.trim() });
      setEditingName(false);
      await loadGroupActivity();
    } finally {
      setSavingProfile(false);
    }
  };

  const handleToggleShareActivity = async () => {
    if (!userProfile) return;
    setSavingProfile(true);
    try {
      await onUpdateProfile({ shareActivity: !userProfile.shareActivity });
      await loadGroupActivity();
    } finally {
      setSavingProfile(false);
    }
  };

  const handleCreateGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudConfig || !newGroupName.trim()) return;
    setSubmittingGroupAction(true);
    try {
      const created = await createFriendGroup(cloudConfig, newGroupName.trim());
      const updated = await fetchUserFriendGroups(cloudConfig);
      setGroups(updated);
      setSelectedGroupId(created.id);
      setNewGroupName('');
      setGroupActionMode('none');
      onShowToast(`Created group "${created.name}" (${created.inviteCode})`);
    } catch (err) {
      onShowToast(
        err instanceof Error ? err.message : 'Could not create group'
      );
    } finally {
      setSubmittingGroupAction(false);
    }
  };

  const handleJoinGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudConfig || !joinCodeInput.trim()) return;
    setSubmittingGroupAction(true);
    try {
      const joined = await joinFriendGroupByCode(
        cloudConfig,
        joinCodeInput.trim()
      );
      const updated = await fetchUserFriendGroups(cloudConfig);
      setGroups(updated);
      setSelectedGroupId(joined.id);
      setJoinCodeInput('');
      setGroupActionMode('none');
      onShowToast(`Joined "${joined.name}"!`);
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Invalid invite code');
    } finally {
      setSubmittingGroupAction(false);
    }
  };

  const handleCopyInvite = async (mode: 'link' | 'code') => {
    if (!activeGroup) return;
    const text =
      mode === 'code'
        ? activeGroup.inviteCode
        : `${window.location.origin}/?join=${activeGroup.inviteCode}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(mode);
      setTimeout(() => setCopiedType(null), 2000);
      onShowToast(
        mode === 'link'
          ? 'Copied invite link to clipboard'
          : `Copied code ${activeGroup.inviteCode}`
      );
    } catch {
      onShowToast(`Invite code: ${activeGroup.inviteCode}`);
    }
  };

  const handleLeaveCurrentGroup = async () => {
    if (!cloudConfig || !authUserId || !activeGroup) return;
    const confirmed = window.confirm(
      `Leave "${activeGroup.name}"? You can always rejoin later with code ${activeGroup.inviteCode}.`
    );
    if (!confirmed) return;

    try {
      await leaveFriendGroup(cloudConfig, activeGroup.id, authUserId);
      onShowToast(`Left "${activeGroup.name}"`);
      await loadGroups();
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not leave group');
    }
  };

  const friendsHeader = (dek: React.ReactNode, actions?: React.ReactNode) => (
    <PageHeader
      numeral="IV"
      kicker="The Reading Circle"
      title="Friends"
      dek={dek}
      actions={actions}
    />
  );

  // --- STATE 1: SUPABASE NOT CONNECTED YET ---
  if (!cloudConfig) {
    return (
      <div className="space-y-10">
        {friendsHeader(
          'Invite a few people whose taste you trust, and compare the year’s reading: challenges, finished books, ratings and reviews.',
          <button type="button" onClick={onOpenSettings} className="btn btn-primary btn-sm">
            <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" />
            Connect Supabase
          </button>
        )}

        <p className="max-w-2xl font-serif text-[17px] leading-relaxed text-ink-soft">
          Each friend signs in with a passwordless email link and keeps their own private calendar
          and reading list. Only finished books and yearly goals are shared, and only within the
          invite-only circles you create. Setup takes three steps:
        </p>

        <ol className="grid grid-cols-1 gap-10 border-t border-rule pt-8 md:grid-cols-3">
          {[
            {
              n: 'i',
              title: 'Lay the foundations',
              body: (
                <>
                  Create a free project at{' '}
                  <a href="https://supabase.com" target="_blank" rel="noreferrer" className="link">
                    supabase.com
                  </a>{' '}
                  and run <code className="font-sans text-[13px] text-ink">supabase/schema.sql</code> in
                  its SQL editor.
                </>
              ),
            },
            {
              n: 'ii',
              title: 'Address the letters',
              body: (
                <>
                  Under <em>Authentication → URL Configuration</em>, add your site’s address (or{' '}
                  <code className="font-sans text-[13px] text-ink">http://localhost:3000</code>) so
                  sign-in links know where to return.
                </>
              ),
            },
            {
              n: 'iii',
              title: 'Send the invitations',
              body: (
                <>
                  Paste your project URL and anon key into Settings, start a circle, and share its
                  invitation link with friends.
                </>
              ),
            },
          ].map((step) => (
            <li key={step.n} className="flex gap-4">
              <span className="font-display text-[36px] italic leading-none text-claret">
                {step.n}.
              </span>
              <div>
                <h3 className="font-serif text-[19px] font-medium text-ink">{step.title}</h3>
                <p className="mt-1.5 font-serif text-[15.5px] leading-relaxed text-ink-muted">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // --- STATE 2: SUPABASE CONNECTED, USER SIGNED OUT ---
  if (!authUserId) {
    return (
      <div className="space-y-10">
        {friendsHeader('Sign in to keep your library in step across devices and join a circle of readers.')}

        <div className="mx-auto max-w-md">
          {pendingJoinCode && (
            <div className="mb-8 border-y border-claret/30 py-4 text-center">
              <p className="caps text-claret">An invitation awaits</p>
              <p className="mt-1.5 font-serif text-[16px] italic text-ink-soft">
                Sign in below and you’ll join circle{' '}
                <span className="font-sans text-[13px] not-italic tracking-[0.2em] text-ink">
                  {pendingJoinCode}
                </span>{' '}
                automatically.
              </p>
            </div>
          )}

          {magicLinkSentTo ? (
            <div className="text-center">
              <Mail strokeWidth={1.25} className="mx-auto h-8 w-8 text-claret" />
              <h2 className="mt-4 font-display text-[32px] font-medium italic text-ink">
                A letter is on its way.
              </h2>
              <p className="mt-2 font-serif text-[16.5px] leading-relaxed text-ink-muted">
                We’ve sent a confirmation link to <span className="text-ink">{magicLinkSentTo}</span>.
                Open it on this device to finish signing in.
              </p>
              <button
                type="button"
                onClick={() => setMagicLinkSentTo(null)}
                className="btn btn-ghost mt-5"
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <Tabline
                value={authMode}
                onChange={(next) => {
                  setAuthMode(next);
                  setAuthError(null);
                }}
                options={[
                  { key: 'signin', label: 'Sign in' },
                  { key: 'signup', label: 'Create account' },
                  { key: 'magic', label: 'Email link' },
                ]}
                className="border-b border-rule"
              />

              <form
                onSubmit={
                  authMode === 'magic'
                    ? handleMagicLinkSubmit
                    : handlePasswordAuthSubmit
                }
                className="space-y-5"
              >
                <div>
                  <label className="field-label">Email address</label>
                  <input
                    type="email"
                    required
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="you@example.com"
                    className="field"
                  />
                </div>

                {authMode !== 'magic' && (
                  <div>
                    <label className="field-label">
                      {authMode === 'signup'
                        ? 'Choose a password · 6+ characters'
                        : 'Password'}
                    </label>
                    <input
                      type="password"
                      required
                      minLength={6}
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="••••••••"
                      className="field"
                    />
                  </div>
                )}

                {authMode !== 'signin' && (
                  <div>
                    <label className="field-label">Your name, as friends will see it</label>
                    <input
                      type="text"
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      placeholder="e.g. Chaim"
                      className="field"
                    />
                  </div>
                )}

                {authError && (
                  <p className="border-l-2 border-claret pl-3 font-serif text-[15px] italic text-claret">
                    {authError}
                  </p>
                )}

                <button type="submit" disabled={sendingLink} className="btn btn-primary w-full">
                  {sendingLink ? (
                    <>
                      <Loader2 strokeWidth={1.5} className="h-4 w-4 animate-spin" />
                      {authMode === 'magic' ? 'Sending…' : 'Signing in…'}
                    </>
                  ) : authMode === 'signin' ? (
                    'Sign in'
                  ) : authMode === 'signup' ? (
                    'Create account'
                  ) : (
                    'Email me a sign-in link'
                  )}
                </button>

                <p className="text-center font-serif text-[14px] italic leading-relaxed text-ink-muted">
                  Anything already saved in this browser will be folded into your account when you sign in.
                </p>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- STATE 3: SIGNED IN ---
  const displayName = userProfile?.displayName || 'Reader';
  const shareActivity = userProfile?.shareActivity ?? true;

  return (
    <div className="space-y-8">
      {friendsHeader(
        groups.length === 0
          ? 'Start a circle, or join one with a friend’s invitation code.'
          : `You belong to ${countWord(groups.length)} ${plural(groups.length, 'circle')}. Only finished books and yearly goals are shared; your list and authors stay private.`,
        <>
          <button
            type="button"
            onClick={() => setGroupActionMode((m) => (m === 'create' ? 'none' : 'create'))}
            className="btn btn-outline btn-sm"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
            New circle
          </button>
          <button
            type="button"
            onClick={() => setGroupActionMode((m) => (m === 'join' ? 'none' : 'join'))}
            className="btn btn-outline btn-sm"
          >
            <UserPlus strokeWidth={1.5} className="h-3.5 w-3.5" />
            Join with a code
          </button>
        </>
      )}

      {/* Reader's card */}
      <div className="flex flex-col gap-4 border-b border-rule pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <AuthorAvatar name={displayName} imageUrl={userProfile?.avatarUrl} size="lg" />
          <div className="min-w-0">
            {editingName ? (
              <form onSubmit={handleSaveDisplayName} className="flex items-center gap-2">
                <input
                  type="text"
                  value={draftDisplayName}
                  onChange={(e) => setDraftDisplayName(e.target.value)}
                  autoFocus
                  className="field field-sm w-48"
                />
                <button type="submit" disabled={savingProfile} className="btn btn-primary btn-sm">
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  className="btn btn-ghost btn-sm"
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-1">
                <h2 className="font-display text-[28px] font-medium leading-tight text-ink">
                  {displayName}
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setDraftDisplayName(displayName);
                    setEditingName(true);
                  }}
                  title="Edit your name"
                  className="icon-btn h-7 w-7"
                >
                  <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <p className="font-serif text-[15px] italic text-ink-muted">{authEmail || 'Signed in'}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <button
            type="button"
            disabled={savingProfile}
            onClick={handleToggleShareActivity}
            data-active={shareActivity}
            className="entry-action"
            title={shareActivity ? 'Pause sharing' : 'Resume sharing'}
          >
            {shareActivity ? (
              <Eye strokeWidth={1.5} className="h-3.5 w-3.5" />
            ) : (
              <EyeOff strokeWidth={1.5} className="h-3.5 w-3.5" />
            )}
            {shareActivity ? 'Sharing with your circles' : 'Sharing paused'}
          </button>
          <button
            type="button"
            onClick={() => setSettingPassword((v) => !v)}
            data-active={settingPassword}
            className="entry-action"
          >
            <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" />
            Set password
          </button>
          <button type="button" onClick={() => onSignOut()} className="entry-action">
            <LogOut strokeWidth={1.5} className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </div>

      {settingPassword && (
        <form
          onSubmit={handleSaveNewPassword}
          className="panel flex flex-wrap items-end gap-3 p-4 sm:p-5"
        >
          <div className="min-w-[220px] flex-1">
            <label className="field-label">
              Set a password for instant phone &amp; desktop sign-in (6+ characters)
            </label>
            <input
              type="password"
              required
              minLength={6}
              autoFocus
              value={newAccountPassword}
              onChange={(e) => setNewAccountPassword(e.target.value)}
              placeholder="Choose a password…"
              className="field field-sm mt-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={savingPassword}
              className="btn btn-primary btn-sm"
            >
              {savingPassword ? 'Saving…' : 'Save password'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSettingPassword(false);
                setNewAccountPassword('');
              }}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Circle switcher */}
      <div className="space-y-4">
        {groups.length > 0 && (
          <Tabline
            value={selectedGroupId || ''}
            onChange={(id) => setSelectedGroupId(id)}
            options={groups.map((g) => ({ key: g.id, label: g.name, count: g.memberCount }))}
            className="border-b border-rule"
          />
        )}

        {/* Inline create / join forms */}
        {groupActionMode === 'create' && (
          <form
            onSubmit={handleCreateGroupSubmit}
            className="flex animate-fade-up flex-col items-stretch gap-3 border-y border-rule bg-paper-raised/60 px-4 py-4 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <label className="field-label">Name your circle</label>
              <input
                type="text"
                required
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. The Thursday Book Club"
                className="field"
              />
            </div>
            <div className="flex items-center gap-1">
              <button type="submit" disabled={submittingGroupAction} className="btn btn-primary">
                {submittingGroupAction ? 'Creating…' : 'Create circle'}
              </button>
              <button type="button" onClick={() => setGroupActionMode('none')} className="btn btn-ghost">
                Cancel
              </button>
            </div>
          </form>
        )}

        {groupActionMode === 'join' && (
          <form
            onSubmit={handleJoinGroupSubmit}
            className="flex animate-fade-up flex-col items-stretch gap-3 border-y border-rule bg-paper-raised/60 px-4 py-4 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <label className="field-label">Invitation code</label>
              <input
                type="text"
                required
                autoFocus
                maxLength={10}
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                placeholder="Six letters, e.g. K7M4P9"
                className="field font-sans uppercase tracking-[0.3em] placeholder:normal-case placeholder:tracking-normal"
              />
            </div>
            <div className="flex items-center gap-1">
              <button type="submit" disabled={submittingGroupAction} className="btn btn-primary">
                {submittingGroupAction ? 'Joining…' : 'Join circle'}
              </button>
              <button type="button" onClick={() => setGroupActionMode('none')} className="btn btn-ghost">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {feedError && (
        <p className="border-l-2 border-claret pl-3 font-serif text-[15px] italic text-claret">
          {feedError}
        </p>
      )}

      {!loadingGroups && groups.length === 0 && groupActionMode === 'none' && (
        <EmptyState
          title="No circles yet."
          body="Start one for your book club, your family, or two friends with good taste. Everyone’s yearly progress and finished books gather in one place."
        >
          <button type="button" onClick={() => setGroupActionMode('create')} className="btn btn-primary">
            Start a circle
          </button>
          <button type="button" onClick={() => setGroupActionMode('join')} className="btn btn-outline">
            I have a code
          </button>
        </EmptyState>
      )}

      {activeGroup && (
        <div className="space-y-12">
          {/* Invitation slip */}
          <div className="flex flex-col gap-4 border border-dashed border-rule-strong px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="caps text-ink-muted">Invitation to {activeGroup.name}</p>
              <p className="mt-1 flex items-baseline gap-3">
                <span className="font-sans text-[22px] font-medium tracking-[0.32em] text-claret">
                  {activeGroup.inviteCode}
                </span>
                <span className="font-serif text-[14px] italic text-ink-muted">
                  Friends who open your link join after signing in.
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => handleCopyInvite('link')} className="btn btn-primary btn-sm">
                {copiedType === 'link' ? (
                  <Check strokeWidth={2} className="h-3.5 w-3.5" />
                ) : (
                  <Link2 strokeWidth={1.5} className="h-3.5 w-3.5" />
                )}
                Copy link
              </button>
              <button type="button" onClick={() => handleCopyInvite('code')} className="btn btn-outline btn-sm">
                {copiedType === 'code' ? (
                  <Check strokeWidth={2} className="h-3.5 w-3.5" />
                ) : (
                  <Copy strokeWidth={1.5} className="h-3.5 w-3.5" />
                )}
                Code
              </button>
              <button
                type="button"
                onClick={() => loadGroupActivity()}
                disabled={loadingFeed}
                title="Refresh"
                className="icon-btn"
              >
                <RefreshCw strokeWidth={1.5} className={`h-3.5 w-3.5 ${loadingFeed ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={handleLeaveCurrentGroup} className="btn btn-danger btn-sm">
                Leave
              </button>
            </div>
          </div>

          {/* The year's standings */}
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule">
              <h2 className="caps pb-2 text-ink-soft">The {selectedYear} standings</h2>
              <div className="flex items-center gap-4 pb-1.5">
                {!myChallengeForSelectedYear && (
                  <button
                    type="button"
                    onClick={() => onOpenChallengeModal(selectedYear)}
                    className="entry-action !text-claret"
                  >
                    <Plus strokeWidth={1.5} className="h-3 w-3" />
                    Set your goal
                  </button>
                )}
                <Tabline
                  value={String(selectedYear)}
                  onChange={(y) => setSelectedYear(Number(y))}
                  options={[currentYear, currentYear - 1, currentYear - 2].map((yr) => ({
                    key: String(yr),
                    label: String(yr),
                  }))}
                  className="-mb-1.5"
                />
              </div>
            </div>

            {loadingFeed && standings.length === 0 ? (
              <p className="py-10 text-center font-serif text-[16px] italic text-ink-muted">
                Tallying the year…
              </p>
            ) : (
              <ol>
                {standings.map((member, index) => {
                  const pct = member.goalCount
                    ? Math.min(100, Math.round((member.booksReadCount / member.goalCount) * 100))
                    : 0;
                  const goalReached =
                    Boolean(member.goalCount) && member.booksReadCount >= (member.goalCount || 0);
                  const visible = member.shareActivity || member.isCurrentUser;

                  return (
                    <li
                      key={member.userId}
                      className="flex flex-col gap-4 border-b border-rule py-5 sm:flex-row sm:items-center"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-4">
                        <span className="w-7 shrink-0 text-center font-display text-[26px] italic leading-none text-ink-faint">
                          {toRomanLower(index + 1)}
                        </span>
                        <AuthorAvatar name={member.displayName} imageUrl={member.avatarUrl} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="truncate font-serif text-[19px] font-medium text-ink">
                              {member.displayName}
                            </span>
                            {member.isCurrentUser && <span className="tag">You</span>}
                            {!member.shareActivity && <span className="tag">Sharing paused</span>}
                          </div>

                          {visible ? (
                            <div className="mt-1.5 max-w-md">
                              <div className="flex items-baseline justify-between font-serif text-[15px] italic text-ink-muted">
                                <span>
                                  {member.goalCount
                                    ? `${countWord(member.booksReadCount, true)} of ${countWord(member.goalCount)}`
                                    : `${countWord(member.booksReadCount, true)} ${plural(member.booksReadCount, 'book')} read`}
                                </span>
                                {member.goalCount ? (
                                  <span className={`caps-sm not-italic nums-lining ${goalReached ? 'text-moss' : 'text-claret'}`}>
                                    {pct}%
                                  </span>
                                ) : null}
                              </div>
                              {member.goalCount ? (
                                <div className="mt-1.5 h-px w-full bg-rule-strong">
                                  <div
                                    className={`-mt-px h-[3px] transition-all duration-700 ${goalReached ? 'bg-moss' : 'bg-claret'}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <p className="font-serif text-[15px] italic text-ink-faint">Keeping their reading private for now.</p>
                          )}
                        </div>
                      </div>

                      {member.recentCovers.length > 0 && (
                        <div className="flex shrink-0 items-end gap-1.5 pl-11 sm:pl-0">
                          {member.recentCovers.map((cov) => (
                            <div
                              key={`${member.userId}-${cov.id}`}
                              title={`${cov.title} — ${cov.authorName}`}
                              className="transition-transform hover:-translate-y-0.5"
                            >
                              <BookCover title={cov.title} authorName={cov.authorName} coverUrl={cov.coverUrl} size="xs" />
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* Commonplace book: finished books & reviews */}
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule">
              <h2 className="caps pb-2 text-ink-soft">Lately finished</h2>
              <Tabline
                value={feedFilter}
                onChange={setFeedFilter}
                options={[
                  { key: 'all', label: 'Everyone' },
                  { key: 'friends', label: 'Friends only' },
                  { key: 'reviewed', label: 'With reviews' },
                ]}
                className="-mb-px"
              />
            </div>

            {filteredFeedItems.length === 0 ? (
              <EmptyState
                title={
                  feedFilter === 'friends'
                    ? 'Your friends haven’t finished anything yet.'
                    : feedFilter === 'reviewed'
                    ? 'No reviews written yet.'
                    : 'Nothing finished in this circle yet.'
                }
                body="When anyone here marks a book as read, or leaves a rating and a few words, it will appear in these pages."
              />
            ) : (
              <div>
                {filteredFeedItems.map((item) => {
                  const matchedPersonal =
                    personalBookStatusMap.byId.get(item.bookId) ||
                    personalBookStatusMap.byNorm.get(normMatchKey(item.title, item.authorName));
                  const myStatus = matchedPersonal?.readingStatus || 'none';

                  return (
                    <article
                      key={`${item.userId}-${item.bookId}`}
                      className="grid grid-cols-1 gap-4 border-b border-rule py-6 md:grid-cols-[168px_minmax(0,1fr)] md:gap-10"
                    >
                      <div className="flex items-center gap-3 md:block">
                        <AuthorAvatar name={item.userDisplayName} imageUrl={item.userAvatarUrl} size="sm" />
                        <div className="md:mt-2">
                          <p className="font-serif text-[16px] text-ink">
                            {item.isCurrentUser ? 'You' : item.userDisplayName}
                          </p>
                          {item.finishedAt && (
                            <p className="caps-sm mt-0.5 text-ink-faint">
                              {formatReleaseDate(item.finishedAt, 'day')}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-5">
                        <BookCover title={item.title} authorName={item.authorName} coverUrl={item.coverUrl} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <h3 className="book-title text-[20px]">{item.title}</h3>
                          <p className="byline mt-0.5 text-[15.5px]">
                            <span className="text-ink-muted">by </span>
                            {item.authorName}
                          </p>
                          {item.rating && item.rating > 0 ? (
                            <Rating value={item.rating} size="md" className="mt-2" />
                          ) : null}
                          {item.notes && item.notes.trim().length > 0 && (
                            <blockquote className="mt-3 whitespace-pre-line border-l border-claret/50 pl-4 font-serif text-[16.5px] italic leading-relaxed text-ink-soft">
                              {item.notes}
                            </blockquote>
                          )}

                          {!item.isCurrentUser && (
                            <div className="mt-auto pt-3">
                              {myStatus === 'read' ? (
                                <span className="entry-action !text-moss">
                                  <Check strokeWidth={2} className="h-3.5 w-3.5" />
                                  You’ve read this
                                </span>
                              ) : myStatus === 'todo' ? (
                                <span className="entry-action !text-claret">
                                  <BookmarkCheck strokeWidth={1.5} className="h-3.5 w-3.5 fill-claret/15" />
                                  On your list
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => onAddFriendBookToTodo(item)}
                                  className="entry-action"
                                >
                                  <BookmarkPlus strokeWidth={1.5} className="h-3.5 w-3.5" />
                                  Add to your list
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function toRomanLower(n: number): string {
  return toRoman(n).toLowerCase();
}
