export const CUSTOM_COVER_FRAGMENT = '#folio-custom';

/**
 * Returns true if the cover URL was explicitly uploaded or hand-picked by the user.
 * Uses either an inline `data:image/...` payload or a harmless RFC-3986 URI fragment
 * (`#folio-custom`) which browsers never send over HTTP to image CDNs, while persisting
 * cleanly in localStorage and Supabase `tracked_books.cover_url`.
 */
export function isCustomCoverUrl(url?: string | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith('data:image/') ||
    trimmed.toLowerCase().endsWith(CUSTOM_COVER_FRAGMENT)
  );
}

/**
 * Marks a user-chosen cover URL so future author bibliography syncs and canonical merges
 * never overwrite manual cover artwork.
 */
export function markCustomCoverUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  const withoutFragment = trimmed.split('#')[0]?.trim() || '';
  if (!withoutFragment) return undefined;
  const normalized = cleanGoogleCoverUrl(withoutFragment) || withoutFragment;
  return `${normalized}${CUSTOM_COVER_FRAGMENT}`;
}

/**
 * Strips the internal `#folio-custom` marker for display in text inputs or URL deduplication.
 */
export function stripCustomCoverMarker(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('data:image/')) return trimmed;
  if (trimmed.toLowerCase().endsWith(CUSTOM_COVER_FRAGMENT)) {
    return trimmed.slice(0, -CUSTOM_COVER_FRAGMENT.length);
  }
  return trimmed;
}

/**
 * Normalizes Google Books cover URLs to HTTPS and strips `&edge=curl` / `?edge=curl`
 * so Google does not add an artificial curled-page graphic on the bottom-right corner.
 */
export function cleanGoogleCoverUrl(rawUrl?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;

  let cleaned = trimmed.replace(/^http:\/\//i, 'https://');
  if (/books\.google\.|googleusercontent\.com/i.test(cleaned)) {
    cleaned = cleaned
      .replace(/([?&])edge=curl(&?)/gi, (_m, prefix: string, suffix: string) => {
        if (prefix === '?' && suffix === '&') return '?';
        if (prefix === '&' && suffix === '&') return '&';
        return '';
      })
      .replace(/[?&]$/, '');
  }
  return cleaned;
}

export interface CoverCandidateMeta {
  url?: string | null;
  label?: string;
  source?: string;
  isCanonicalBookImage?: boolean;
  editionTitle?: string | null;
  editionFormat?: string | null;
  editionInfo?: string | null;
  /** Hardcover reading_format_id: 1 = Print, 2 = Audiobook, 4 = E-Book */
  readingFormatId?: number | null;
  isbn13?: string | null;
  isbn10?: string | null;
  usersCount?: number | null;
}

const PLACEHOLDER_URL_RE =
  /\b(nophoto|no[_-]?cover|placeholder|default[_-]?cover|missing[_-]?cover|blank|avatar)\b/i;

const ANGLED_OR_PROMO_URL_RE =
  /(?:^|[^a-z0-9])(3d|mockup|mock[_-]?up|angled?|perspective|banner|promo|reveal|social|1200x630|opengraph|og[_-]?image|boxset|slipcase|sprayed)(?:[^a-z0-9]|$)/i;

const SPRAYED_OR_3D_EDITION_RE =
  /\b(sprayed\s+edges?|stenciled\s+edges?|painted\s+edges?|fore-?edge|slipcase|box\s*set|boxed\s+set|bundle|omnibus)\b/i;

const BOOK_BOX_OR_EXCLUSIVE_RE =
  /\b(fairyloot|illumicrate|owlcrate|litjoy|broken\s+binding|bookish\s+box|arcane\s+society|dazzling\s+bookish|goldsboro|subterranean\s+press|folio\s+society|waterstones|barnes\s*(?:&|and)\s*noble|b&n|target\s+exclusive|walmart\s+exclusive|indie\s+exclusive|exclusive\s+edition|signed|autographed)\b/i;

const SPECIAL_COLLECTOR_EDITION_RE =
  /\b(deluxe|collector'?s?|special\s+edition|limited\s+edition|anniversary|leatherbound|clothbound|heirloom|tie-?in|motion\s+picture)\b/i;

const AUDIO_FORMAT_RE =
  /\b(audible|audiobook|audio\s+cd|mp3\s+cd|listening\s+library|recorded\s+books|blackstone\s+audio|graphicaudio)\b/i;

/**
 * Scores a cover URL + edition metadata to strongly favor flat, head-on 2D front cover
 * jackets (ONIX publisher print ISBNs and standard Kindle/eBook covers) while penalizing
 * 3D angled mockups, sprayed-edge book-box renders, wide cover-reveal graphics, and 1:1 audiobooks.
 */
export function scoreCoverCandidate(meta: CoverCandidateMeta): number {
  const rawUrl = stripCustomCoverMarker(meta.url);
  if (!rawUrl) return -9999;

  if (PLACEHOLDER_URL_RE.test(rawUrl)) {
    return -9999;
  }

  let score = 0;
  const descriptor = [
    meta.editionTitle || '',
    meta.editionFormat || '',
    meta.editionInfo || '',
    meta.label || '',
  ]
    .join(' ')
    .trim();

  // 1. Disqualify / heavily penalize Audiobooks (square 1:1 covers with Audible ribbons)
  if (meta.readingFormatId === 2 || AUDIO_FORMAT_RE.test(descriptor) || AUDIO_FORMAT_RE.test(rawUrl)) {
    score -= 140;
  }

  // 2. Penalize 3D angled mockups, sprayed-edge showcases, and book-box editions
  if (ANGLED_OR_PROMO_URL_RE.test(rawUrl)) {
    score -= 95;
  }
  if (SPRAYED_OR_3D_EDITION_RE.test(descriptor)) {
    score -= 95;
  }
  if (BOOK_BOX_OR_EXCLUSIVE_RE.test(descriptor)) {
    score -= 80;
  }
  if (SPECIAL_COLLECTOR_EDITION_RE.test(descriptor)) {
    score -= 42;
  }

  // 3. File format heuristics:
  // Publisher ONIX / Ingram / Kindle jackets are almost universally JPEG/WebP, whereas
  // 3D tilted book renders with transparent backgrounds/drop-shadows are overwhelmingly PNG.
  if (/\.png(?:[?#]|$)/i.test(rawUrl)) {
    score -= 28;
  } else if (/\.(?:jpe?g|webp)(?:[?#]|$)/i.test(rawUrl)) {
    score += 12;
  }

  // 4. Format & ISBN bonuses for flat 2D retail covers
  const isCleanStandardEdition =
    !SPRAYED_OR_3D_EDITION_RE.test(descriptor) &&
    !BOOK_BOX_OR_EXCLUSIVE_RE.test(descriptor) &&
    !SPECIAL_COLLECTOR_EDITION_RE.test(descriptor) &&
    meta.readingFormatId !== 2 &&
    !AUDIO_FORMAT_RE.test(descriptor);

  const fmt = (meta.editionFormat || '').toLowerCase();

  if (isCleanStandardEdition) {
    if (meta.readingFormatId === 4 || /\b(ebook|e-book|kindle|digital)\b/i.test(fmt)) {
      // Digital / eBook editions have strictly flat 2D front cover files
      score += 38;
    } else if (
      meta.readingFormatId === 1 ||
      /\b(hardcover|hardback|paperback)\b/i.test(fmt)
    ) {
      score += 34;
    }
  }

  const cleanIsbn13 = (meta.isbn13 || '').replace(/[^0-9X]/gi, '');
  const cleanIsbn10 = (meta.isbn10 || '').replace(/[^0-9X]/gi, '');
  if (/^97[89]\d{10}$/.test(cleanIsbn13)) {
    score += 18;
  } else if (cleanIsbn10.length === 10) {
    score += 10;
  }

  if (meta.isCanonicalBookImage) {
    // Small tie-breaker when canonical book.image is already clean, but easily beaten
    // by a standard ISBN Hardcover/E-Book edition if book.image is a .png 3D mockup
    score += 10;
  }

  if (typeof meta.usersCount === 'number' && meta.usersCount > 0) {
    score += Math.min(18, Math.round(Math.log10(meta.usersCount + 1) * 7));
  }

  if (rawUrl.startsWith('https://')) {
    score += 4;
  }

  return score;
}

/**
 * Picks the highest-scoring flat, head-on cover URL from a book's image candidates.
 */
export function pickBestHeadOnCoverUrl(
  candidates: CoverCandidateMeta[]
): string | undefined {
  let bestUrl: string | undefined;
  let bestScore = -9000;

  for (const cand of candidates) {
    const cleaned = cleanGoogleCoverUrl(cand.url) || cand.url?.trim();
    if (!cleaned) continue;
    const score = scoreCoverCandidate({ ...cand, url: cleaned });
    if (score > bestScore) {
      bestScore = score;
      bestUrl = cleaned;
    }
  }

  return bestUrl;
}

/**
 * Chooses the better cover between two BookItem records during deduplication or sync,
 * always honoring user-customized covers first.
 */
export function pickPreferredCoverUrl(
  primaryUrl?: string,
  secondaryUrl?: string,
  primaryTitle?: string,
  secondaryTitle?: string
): string | undefined {
  const aCustom = isCustomCoverUrl(primaryUrl);
  const bCustom = isCustomCoverUrl(secondaryUrl);

  if (aCustom && !bCustom) return primaryUrl;
  if (bCustom && !aCustom) return secondaryUrl;
  if (aCustom && bCustom) return primaryUrl || secondaryUrl;

  if (!primaryUrl) return secondaryUrl;
  if (!secondaryUrl) return primaryUrl;

  const scoreA = scoreCoverCandidate({
    url: primaryUrl,
    editionTitle: primaryTitle,
    isCanonicalBookImage: true,
  });
  const scoreB = scoreCoverCandidate({
    url: secondaryUrl,
    editionTitle: secondaryTitle,
  });

  return scoreB > scoreA ? secondaryUrl : primaryUrl;
}

/**
 * Detects uniform empty alpha padding around an uploaded PNG/WebP (common when copying
 * a cover graphic with transparent margins) and returns the tight non-transparent bounding box.
 */
function findTrimmedAlphaBounds(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): { sx: number; sy: number; sw: number; sh: number } {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let hasTransparency = false;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width * 4;
      for (let x = 0; x < width; x++) {
        const alpha = data[rowOffset + x * 4 + 3];
        if (alpha < 245) {
          hasTransparency = true;
        }
        if (alpha > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (!hasTransparency || maxX <= minX || maxY <= minY) {
      return { sx: 0, sy: 0, sw: width, sh: height };
    }

    const trimmedW = maxX - minX + 1;
    const trimmedH = maxY - minY + 1;
    if (trimmedW < width * 0.35 || trimmedH < height * 0.35) {
      return { sx: 0, sy: 0, sw: width, sh: height };
    }

    return { sx: minX, sy: minY, sw: trimmedW, sh: trimmedH };
  } catch {
    return { sx: 0, sy: 0, sw: width, sh: height };
  }
}

/**
 * Reads an uploaded/dropped/pasted image Blob in the browser, trims empty transparent padding,
 * scales proportionally to at most 480×720, and encodes a compact WebP/JPEG `data:image/...`
 * URL (~20–45 KB) that syncs cleanly across localStorage, Supabase, and Vellum.
 */
export async function compressUploadedCoverImage(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (JPEG, PNG, WebP, etc.).');
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('Image file is too large (max 15 MB).');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode that image file.'));
      el.src = objectUrl;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (srcW < 16 || srcH < 16) {
      throw new Error('Image is too small to use as a book cover.');
    }

    // First draw onto a working canvas to inspect/trim empty transparent borders
    const probeScale = Math.min(1, 900 / Math.max(srcW, srcH));
    const probeW = Math.max(1, Math.round(srcW * probeScale));
    const probeH = Math.max(1, Math.round(srcH * probeScale));

    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = probeW;
    probeCanvas.height = probeH;
    const probeCtx = probeCanvas.getContext('2d');
    if (!probeCtx) {
      throw new Error('Canvas is unavailable in this browser.');
    }
    probeCtx.drawImage(img, 0, 0, probeW, probeH);

    const bounds = findTrimmedAlphaBounds(probeCanvas.getContext('2d')!, probeW, probeH);

    const maxW = 480;
    const maxH = 720;
    const scale = Math.min(1, maxW / bounds.sw, maxH / bounds.sh);
    const outW = Math.max(1, Math.round(bounds.sw * scale));
    const outH = Math.max(1, Math.round(bounds.sh * scale));

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) {
      throw new Error('Canvas is unavailable in this browser.');
    }

    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(
      probeCanvas,
      bounds.sx,
      bounds.sy,
      bounds.sw,
      bounds.sh,
      0,
      0,
      outW,
      outH
    );

    // Prefer compact WebP (preserves crisp typography & optional alpha at ~25 KB), fallback to JPEG
    let dataUrl = outCanvas.toDataURL('image/webp', 0.85);
    if (!dataUrl.startsWith('data:image/webp') || dataUrl.length > 220_000) {
      const jpgCanvas = document.createElement('canvas');
      jpgCanvas.width = outW;
      jpgCanvas.height = outH;
      const jpgCtx = jpgCanvas.getContext('2d')!;
      jpgCtx.fillStyle = '#F7F2E9';
      jpgCtx.fillRect(0, 0, outW, outH);
      jpgCtx.drawImage(outCanvas, 0, 0);
      dataUrl = jpgCanvas.toDataURL('image/jpeg', 0.84);
    }

    if (dataUrl.length > 240_000) {
      dataUrl = outCanvas.toDataURL('image/jpeg', 0.72);
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
