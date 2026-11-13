'use client';

import React, { useState } from 'react';

/**
 * Bookcloth palettes for placeholder covers & shelf spines.
 * Each entry: [cloth, stamp] — cloth colour and the foil used for lettering.
 */
const CLOTHS: Array<[string, string]> = [
  ['#6E1F24', '#E2C58E'], // oxblood / gilt
  ['#24372D', '#D9C08A'], // bottle green / gilt
  ['#1F2A40', '#D8C79E'], // navy buckram / pale gilt
  ['#8A6A2F', '#F3E6C4'], // ochre linen / cream
  ['#3A3430', '#D6BE8C'], // charcoal / gilt
  ['#4E2A3A', '#E6CFA0'], // aubergine / gilt
  ['#5B6B5A', '#F1E8D2'], // sage / cream
  ['#9A4A2E', '#F4E2C2'], // terracotta / cream
];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function clothFor(seed: string): [string, string] {
  return CLOTHS[hashSeed(seed) % CLOTHS.length];
}

const LINEN =
  'repeating-linear-gradient(0deg, rgba(255,255,255,0.035) 0px, rgba(255,255,255,0.035) 1px, transparent 1px, transparent 3px), repeating-linear-gradient(90deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 3px)';

type CoverSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<CoverSize, string> = {
  xs: 'w-8',
  sm: 'w-11',
  md: 'w-[64px] sm:w-[72px]',
  lg: 'w-24 sm:w-28',
};

interface BookCoverProps {
  title: string;
  authorName: string;
  coverUrl?: string;
  size?: CoverSize;
  className?: string;
}

export function BookCover({
  title,
  authorName,
  coverUrl,
  size = 'md',
  className = '',
}: BookCoverProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const base = `relative shrink-0 aspect-[2/3] overflow-hidden rounded-[1.5px] shadow-book ${SIZE_CLASSES[size]} ${className}`;

  // Hinge + sheen overlays that make a flat image read as a bound object
  const binding = (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[7%] bg-gradient-to-r from-black/25 via-black/5 to-transparent"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-[7%] w-px bg-white/15"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/10"
      />
    </>
  );

  const [cloth, stamp] = clothFor(`${title}:${authorName}`);
  const tiny = size === 'xs' || size === 'sm';
  const showImage = Boolean(coverUrl) && !imgFailed;

  return (
    <div
      className={base}
      style={{ backgroundColor: cloth, backgroundImage: LINEN }}
      aria-label={`${title} by ${authorName}`}
      role="img"
    >
      {/* Cloth-bound edition — doubles as the loading state beneath real artwork */}
      {!tiny && (
        <div
          className="absolute inset-[6%] flex flex-col items-center justify-between py-[10%] text-center"
          style={{ border: `0.5px solid ${stamp}66`, color: stamp }}
        >
          <span className="block h-px w-1/3" style={{ backgroundColor: `${stamp}88` }} />
          <p
            className={`px-1.5 font-display font-medium leading-[1.05] line-clamp-4 ${
              size === 'lg' ? 'text-[15px]' : 'text-[10.5px]'
            }`}
          >
            {title}
          </p>
          <p
            className={`px-1 font-sans uppercase leading-tight line-clamp-2 ${
              size === 'lg' ? 'text-[7.5px] tracking-[0.18em]' : 'text-[5.5px] tracking-[0.14em]'
            }`}
            style={{ opacity: 0.85 }}
          >
            {authorName}
          </p>
        </div>
      )}
      {tiny && (
        <span
          aria-hidden
          className="absolute left-1/2 top-[22%] h-[38%] w-px -translate-x-1/2"
          style={{ backgroundColor: `${stamp}aa` }}
        />
      )}

      {showImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          onLoad={(e) => {
            // Some catalogues return a 1×1 pixel instead of a 404 when no cover exists
            if (e.currentTarget.naturalWidth < 10) setImgFailed(true);
            else setImgLoaded(true);
          }}
          onError={() => setImgFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            imgLoaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
      {binding}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Spine — used for the reading-challenge bookshelf                     */
/* ------------------------------------------------------------------ */

export function BookSpine({
  seed,
  title,
  filled,
  onClick,
}: {
  seed: string;
  title?: string;
  filled: boolean;
  onClick?: () => void;
}) {
  const h = hashSeed(seed);
  const heightPct = 78 + (h % 22); // 78–99% of shelf height
  const [cloth, stamp] = clothFor(seed);

  if (!filled) {
    return (
      <span
        aria-hidden
        className="block min-w-[3px] flex-1 self-end rounded-t-[1px] border border-b-0 border-dashed border-rule-strong/70"
        style={{ height: `${heightPct}%` }}
      />
    );
  }

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="group relative block min-w-[3px] flex-1 self-end rounded-t-[1px] transition-transform duration-200 hover:-translate-y-1.5"
      style={{
        height: `${heightPct}%`,
        backgroundColor: cloth,
        backgroundImage:
          'linear-gradient(90deg, rgba(0,0,0,0.28) 0%, rgba(255,255,255,0.08) 35%, rgba(0,0,0,0.12) 100%)',
      }}
    >
      <span
        aria-hidden
        className="absolute inset-x-[18%] top-[12%] h-px"
        style={{ backgroundColor: `${stamp}aa` }}
      />
      <span
        aria-hidden
        className="absolute inset-x-[18%] bottom-[12%] h-px"
        style={{ backgroundColor: `${stamp}aa` }}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Author / reader portrait                                             */
/* ------------------------------------------------------------------ */

interface AuthorAvatarProps {
  name: string;
  imageUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function AuthorAvatar({ name, imageUrl, size = 'md' }: AuthorAvatarProps) {
  const [failed, setFailed] = useState(false);

  const sizeClasses =
    size === 'sm'
      ? 'w-8 h-8 text-[13px]'
      : size === 'lg'
      ? 'w-14 h-14 text-[22px]'
      : 'w-11 h-11 text-[17px]';

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');

  if (imageUrl && !failed) {
    return (
      <div
        className={`relative shrink-0 overflow-hidden rounded-full bg-paper-sunken ring-1 ring-rule ${sizeClasses}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={name}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover grayscale-[35%] sepia-[12%]"
        />
      </div>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full border border-rule-strong bg-paper-sunken font-display italic text-ink-soft ${sizeClasses}`}
    >
      {initials || '·'}
    </div>
  );
}
