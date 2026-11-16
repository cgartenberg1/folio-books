'use client';

import React, { useEffect, useState } from 'react';

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
  onClick?: () => void;
  actionTitle?: string;
}

export function BookCover({
  title,
  authorName,
  coverUrl,
  size = 'md',
  className = '',
  onClick,
  actionTitle,
}: BookCoverProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    setImgFailed(false);
    setImgLoaded(false);
    setNaturalDims(null);
  }, [coverUrl]);

  const tiny = size === 'xs' || size === 'sm';
  const showImage = Boolean(coverUrl) && !imgFailed;

  const ratio =
    naturalDims && naturalDims.h > 0 ? naturalDims.w / naturalDims.h : null;
  const isNaturalPortrait =
    ratio !== null && ratio >= 0.52 && ratio <= 0.84;
  const isNonStandardShape =
    ratio !== null && (ratio > 0.84 || ratio < 0.52);

  // Adapt md/lg covers to the real jacket's portrait ratio so titles, author names,
  // and side borders are never cropped; lock self-start so flex rows never stretch height.
  const computedAspectRatio =
    showImage && imgLoaded && !tiny && isNaturalPortrait && naturalDims
      ? `${naturalDims.w} / ${naturalDims.h}`
      : '2 / 3';

  const base = `relative shrink-0 self-start overflow-hidden rounded-[1.5px] shadow-book ${SIZE_CLASSES[size]} ${
    onClick ? 'cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 focus-visible:ring-1 focus-visible:ring-claret' : ''
  } ${className}`;

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

  return (
    <div
      className={base}
      style={{
        backgroundColor: cloth,
        backgroundImage: LINEN,
        aspectRatio: computedAspectRatio,
      }}
      aria-label={actionTitle || `${title} by ${authorName}`}
      title={actionTitle}
      role={onClick ? 'button' : 'img'}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* Cloth-bound edition — doubles as the loading state beneath real artwork, hidden once loaded so transparent PNGs stay clean */}
      {!tiny && !imgLoaded && (
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
      {tiny && !imgLoaded && (
        <span
          aria-hidden
          className="absolute left-1/2 top-[22%] h-[38%] w-px -translate-x-1/2"
          style={{ backgroundColor: `${stamp}aa` }}
        />
      )}

      {showImage && (
        <>
          {/* Softly toned backdrop when displaying square/wide/angled graphics so nothing is cropped */}
          {imgLoaded && isNonStandardShape && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt=""
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-40 blur-md"
            />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            onLoad={(e) => {
              const nw = e.currentTarget.naturalWidth;
              const nh = e.currentTarget.naturalHeight;
              // Some catalogues return a 1×1 pixel instead of a 404 when no cover exists
              if (nw < 10 || nh < 10) {
                setImgFailed(true);
              } else {
                setNaturalDims({ w: nw, h: nh });
                setImgLoaded(true);
              }
            }}
            onError={() => setImgFailed(true)}
            className={`absolute inset-0 h-full w-full transition-opacity duration-300 ${
              isNonStandardShape
                ? 'object-contain p-0.5'
                : tiny
                ? 'object-cover'
                : 'object-contain'
            } ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
          />
        </>
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
          className="h-full w-full object-cover grayscale contrast-[1.06]"
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
