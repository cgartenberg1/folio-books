#!/usr/bin/env node
/**
 * Generates Folio's fine-press "Stack of Books" app icon suite across all platforms:
 * - Native iOS Liquid Glass multi-layer bundle (`icons/ios/AppIcon.icon` — Light, Dark, Clear, Tinted)
 * - iOS Universal fallback `icons/ios/AppIcon.appiconset` (Light, Dark, Tinted 1024×1024 24-bit RGB)
 * - Native Android Adaptive Day/Night + Material You Monochrome (`icons/android/res/`)
 * - Web & PWA icons (`public/icon.svg` with prefers-color-scheme, Light/Dark PNGs,
 *   Android Maskable safe-zone PNGs, Android WebAPK Monochrome PNG, and 180×180 `apple-touch-icon.png`)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const f = (n) => Number(n.toFixed(2));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// PNG Encoders (24-bit RGB for opaque icons, 32-bit RGBA for monochrome mask)
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, buffer, channels = 3) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2; // 6 = RGBA, 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    buffer.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canonical 1024×1024 Stack-of-Books Geometry
// ---------------------------------------------------------------------------
const TOP_SPEC = {
  xLeft: 228,
  xRight: 808,
  yTop: 262,
  yBot: 420,
  spineSide: 'left',
  boardThick: 24,
  spineBand: 44,
  lip: 20,
  concave: 15,
};
const MID_SPEC = {
  xLeft: 196,
  xRight: 824,
  yTop: 423,
  yBot: 588,
  spineSide: 'right',
  boardThick: 25,
  spineBand: 46,
  lip: 21,
  concave: 16,
};
const BOT_SPEC = {
  xLeft: 174,
  xRight: 850,
  yTop: 591,
  yBot: 764,
  spineSide: 'left',
  boardThick: 26,
  spineBand: 48,
  lip: 22,
  concave: 17,
};

const RIB_SPEC = {
  left: 640,
  right: 708,
  top: 286,
  bot: 468,
  notch: 19,
};

function buildCoverPath({
  xLeft,
  xRight,
  yTop,
  yBot,
  spineSide,
  boardThick,
  lip,
  concave,
}) {
  const h = yBot - yTop;
  const rSpine = f(h * 0.48);
  const rTip = f(boardThick * 0.48);
  const yInnerTop = f(yTop + boardThick);
  const yInnerBot = f(yBot - boardThick);
  const yMid = f((yTop + yBot) / 2);

  if (spineSide === 'left') {
    const xSpineJoin = f(xLeft + rSpine);
    const xTipOuter = f(xRight);
    const xTipStart = f(xRight - rTip);
    const xForeEdge = f(xRight - lip);
    const xForeCtrl = f(xForeEdge - concave);

    return [
      `M ${xSpineJoin} ${yTop}`,
      `L ${xTipStart} ${yTop}`,
      `Q ${xTipOuter} ${yTop} ${xTipOuter} ${f(yTop + rTip)}`,
      `L ${xTipOuter} ${f(yInnerTop - rTip)}`,
      `Q ${xTipOuter} ${yInnerTop} ${xTipStart} ${yInnerTop}`,
      `L ${xForeEdge} ${yInnerTop}`,
      `Q ${xForeCtrl} ${yMid} ${xForeEdge} ${yInnerBot}`,
      `L ${xTipStart} ${yInnerBot}`,
      `Q ${xTipOuter} ${yInnerBot} ${xTipOuter} ${f(yInnerBot + rTip)}`,
      `L ${xTipOuter} ${f(yBot - rTip)}`,
      `Q ${xTipOuter} ${yBot} ${xTipStart} ${yBot}`,
      `L ${xSpineJoin} ${yBot}`,
      `C ${f(xLeft + rSpine * 0.25)} ${yBot} ${xLeft} ${f(yBot - h * 0.18)} ${xLeft} ${yMid}`,
      `C ${xLeft} ${f(yTop + h * 0.18)} ${f(xLeft + rSpine * 0.25)} ${yTop} ${xSpineJoin} ${yTop}`,
      'Z',
    ].join(' ');
  }

  const xSpineJoin = f(xRight - rSpine);
  const xTipOuter = f(xLeft);
  const xTipStart = f(xLeft + rTip);
  const xForeEdge = f(xLeft + lip);
  const xForeCtrl = f(xForeEdge + concave);

  return [
    `M ${xSpineJoin} ${yTop}`,
    `C ${f(xRight - rSpine * 0.25)} ${yTop} ${xRight} ${f(yTop + h * 0.18)} ${xRight} ${yMid}`,
    `C ${xRight} ${f(yBot - h * 0.18)} ${f(xRight - rSpine * 0.25)} ${yBot} ${xSpineJoin} ${yBot}`,
    `L ${xTipStart} ${yBot}`,
    `Q ${xTipOuter} ${yBot} ${xTipOuter} ${f(yBot - rTip)}`,
    `L ${xTipOuter} ${f(yInnerBot + rTip)}`,
    `Q ${xTipOuter} ${yInnerBot} ${xTipStart} ${yInnerBot}`,
    `L ${xForeEdge} ${yInnerBot}`,
    `Q ${xForeCtrl} ${yMid} ${xForeEdge} ${yInnerTop}`,
    `L ${xTipStart} ${yInnerTop}`,
    `Q ${xTipOuter} ${yInnerTop} ${xTipOuter} ${f(yInnerTop - rTip)}`,
    `L ${xTipOuter} ${f(yTop + rTip)}`,
    `Q ${xTipOuter} ${yTop} ${xTipStart} ${yTop}`,
    `L ${xSpineJoin} ${yTop}`,
    'Z',
  ].join(' ');
}

function buildPagesPath({
  xLeft,
  xRight,
  yTop,
  yBot,
  spineSide,
  boardThick,
  spineBand,
  lip,
  concave,
}) {
  const yPTop = f(yTop + boardThick);
  const yPBot = f(yBot - boardThick);
  const pH = yPBot - yPTop;
  const yMid = f((yPTop + yPBot) / 2);
  const rInner = f(pH * 0.34);

  if (spineSide === 'left') {
    const xApex = f(xLeft + spineBand);
    const xShoulder = f(xApex + rInner);
    const xFore = f(xRight - lip + 2);
    const xForeCtrl = f(xFore - concave);

    return [
      `M ${xShoulder} ${yPTop}`,
      `L ${xFore} ${yPTop}`,
      `Q ${xForeCtrl} ${yMid} ${xFore} ${yPBot}`,
      `L ${xShoulder} ${yPBot}`,
      `C ${f(xApex + rInner * 0.26)} ${yPBot} ${xApex} ${f(yPBot - pH * 0.18)} ${xApex} ${yMid}`,
      `C ${xApex} ${f(yPTop + pH * 0.18)} ${f(xApex + rInner * 0.26)} ${yPTop} ${xShoulder} ${yPTop}`,
      'Z',
    ].join(' ');
  }

  const xApex = f(xRight - spineBand);
  const xShoulder = f(xApex - rInner);
  const xFore = f(xLeft + lip - 2);
  const xForeCtrl = f(xFore + concave);

  return [
    `M ${xFore} ${yPTop}`,
    `L ${xShoulder} ${yPTop}`,
    `C ${f(xApex - rInner * 0.26)} ${yPTop} ${xApex} ${f(yPTop + pH * 0.18)} ${xApex} ${yMid}`,
    `C ${xApex} ${f(yPBot - pH * 0.18)} ${f(xApex - rInner * 0.26)} ${yPBot} ${xShoulder} ${yPBot}`,
    `L ${xFore} ${yPBot}`,
    `Q ${xForeCtrl} ${yMid} ${xFore} ${yPTop}`,
    'Z',
  ].join(' ');
}

function buildRibbonPath(r = RIB_SPEC) {
  const mid = (r.left + r.right) / 2;
  return [
    `M ${r.left} ${r.top + 6}`,
    `Q ${r.left} ${r.top} ${r.left + 7} ${r.top}`,
    `L ${r.right - 7} ${r.top}`,
    `Q ${r.right} ${r.top} ${r.right} ${r.top + 6}`,
    `L ${r.right} ${r.bot}`,
    `C ${r.right} ${r.bot + 7} ${r.right - 8} ${r.bot + 10} ${r.right - 13} ${r.bot + 5}`,
    `L ${mid} ${r.bot - r.notch}`,
    `L ${r.left + 13} ${r.bot + 5}`,
    `C ${r.left + 8} ${r.bot + 10} ${r.left} ${r.bot + 7} ${r.left} ${r.bot}`,
    'Z',
  ].join(' ');
}

/**
 * C-shaped hardcover casing outline (spine + top board + bottom board, open interior)
 * used for Android Material You `<monochrome>` and WebAPK monochrome silhouettes
 * with clean negative-space moats around the recessed vellum page blocks.
 */
function buildMonochromeCasingPath(spec, moat = 9) {
  const { xLeft, xRight, yTop, yBot, spineSide, boardThick, spineBand } = spec;
  const h = yBot - yTop;
  const rSpine = f(h * 0.48);
  const rTip = f(boardThick * 0.46);
  const yInnerTop = f(yTop + boardThick - 2);
  const yInnerBot = f(yBot - boardThick + 2);
  const yMid = f((yTop + yBot) / 2);
  const pH = yInnerBot - yInnerTop;
  const rInner = f(pH * 0.34);

  if (spineSide === 'left') {
    const xSpineJoin = f(xLeft + rSpine);
    const xInnerApex = f(xLeft + spineBand - moat);
    const xInnerShoulder = f(xInnerApex + rInner);
    const xTipOuter = f(xRight);
    const xTipStart = f(xRight - rTip);

    return [
      `M ${xSpineJoin} ${yTop}`,
      `L ${xTipStart} ${yTop}`,
      `Q ${xTipOuter} ${yTop} ${xTipOuter} ${f(yTop + rTip)}`,
      `L ${xTipOuter} ${f(yInnerTop - rTip)}`,
      `Q ${xTipOuter} ${yInnerTop} ${xTipStart} ${yInnerTop}`,
      `L ${xInnerShoulder} ${yInnerTop}`,
      `C ${f(xInnerApex + rInner * 0.26)} ${yInnerTop} ${xInnerApex} ${f(yInnerTop + pH * 0.18)} ${xInnerApex} ${yMid}`,
      `C ${xInnerApex} ${f(yInnerBot - pH * 0.18)} ${f(xInnerApex + rInner * 0.26)} ${yInnerBot} ${xInnerShoulder} ${yInnerBot}`,
      `L ${xTipStart} ${yInnerBot}`,
      `Q ${xTipOuter} ${yInnerBot} ${xTipOuter} ${f(yInnerBot + rTip)}`,
      `L ${xTipOuter} ${f(yBot - rTip)}`,
      `Q ${xTipOuter} ${yBot} ${xTipStart} ${yBot}`,
      `L ${xSpineJoin} ${yBot}`,
      `C ${f(xLeft + rSpine * 0.25)} ${yBot} ${xLeft} ${f(yBot - h * 0.18)} ${xLeft} ${yMid}`,
      `C ${xLeft} ${f(yTop + h * 0.18)} ${f(xLeft + rSpine * 0.25)} ${yTop} ${xSpineJoin} ${yTop}`,
      'Z',
    ].join(' ');
  }

  const xSpineJoin = f(xRight - rSpine);
  const xInnerApex = f(xRight - spineBand + moat);
  const xInnerShoulder = f(xInnerApex - rInner);
  const xTipOuter = f(xLeft);
  const xTipStart = f(xLeft + rTip);

  return [
    `M ${xSpineJoin} ${yTop}`,
    `C ${f(xRight - rSpine * 0.25)} ${yTop} ${xRight} ${f(yTop + h * 0.18)} ${xRight} ${yMid}`,
    `C ${xRight} ${f(yBot - h * 0.18)} ${f(xRight - rSpine * 0.25)} ${yBot} ${xSpineJoin} ${yBot}`,
    `L ${xTipStart} ${yBot}`,
    `Q ${xTipOuter} ${yBot} ${xTipOuter} ${f(yBot - rTip)}`,
    `L ${xTipOuter} ${f(yInnerBot + rTip)}`,
    `Q ${xTipOuter} ${yInnerBot} ${xTipStart} ${yInnerBot}`,
    `L ${xInnerShoulder} ${yInnerBot}`,
    `C ${f(xInnerApex - rInner * 0.26)} ${yInnerBot} ${xInnerApex} ${f(yInnerBot - pH * 0.18)} ${xInnerApex} ${yMid}`,
    `C ${xInnerApex} ${f(yInnerTop + pH * 0.18)} ${f(xInnerApex - rInner * 0.26)} ${yInnerTop} ${xInnerShoulder} ${yInnerTop}`,
    `L ${xTipStart} ${yInnerTop}`,
    `Q ${xTipOuter} ${yInnerTop} ${xTipOuter} ${f(yInnerTop - rTip)}`,
    `L ${xTipOuter} ${f(yTop + rTip)}`,
    `Q ${xTipOuter} ${yTop} ${xTipStart} ${yTop}`,
    `L ${xSpineJoin} ${yTop}`,
    'Z',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// High-Precision Analytic Signed-Distance & Subpixel Rasterizer (1024 space)
// ---------------------------------------------------------------------------
function sdRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const hx = (x1 - x0) * 0.5;
  const hy = (y1 - y0) * 0.5;
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function evalCoverSdf(px, py, spec) {
  const { xLeft, xRight, yTop, yBot, spineSide, boardThick, lip, concave } = spec;
  const yMid = (yTop + yBot) * 0.5;
  const halfH = (yBot - yTop) * 0.5;
  const dy = Math.abs(py - yMid) - halfH;
  const rSpine = halfH * 0.96;
  const rTip = boardThick * 0.48;

  const yInnerTop = yTop + boardThick;
  const yInnerBot = yBot - boardThick;
  const vRecess = clamp01((py - yInnerTop) / (yInnerBot - yInnerTop));
  const parabola = 4 * vRecess * (1 - vRecess);

  if (spineSide === 'left') {
    const spineCenterX = xLeft + rSpine;
    // Top & bottom projecting boards
    const dTopBoard = sdRoundedRect(px, py, spineCenterX - 8, yTop, xRight, yInnerTop, rTip);
    const dBotBoard = sdRoundedRect(px, py, spineCenterX - 8, yInnerBot, xRight, yBot, rTip);

    // Core body from rounded left spine to concave right fore-edge
    const foreX = xRight - lip - concave * 0.52 * parabola;
    let dCore;
    if (px < spineCenterX) {
      const dRad = Math.hypot((px - spineCenterX) / rSpine, (py - yMid) / halfH) - 1;
      dCore = dRad * Math.min(rSpine, halfH);
    } else {
      dCore = Math.max(dy, px - foreX);
    }
    return Math.min(dCore, dTopBoard, dBotBoard);
  }

  const spineCenterX = xRight - rSpine;
  const dTopBoard = sdRoundedRect(px, py, xLeft, yTop, spineCenterX + 8, yInnerTop, rTip);
  const dBotBoard = sdRoundedRect(px, py, xLeft, yInnerBot, spineCenterX + 8, yBot, rTip);

  const foreX = xLeft + lip + concave * 0.52 * parabola;
  let dCore;
  if (px > spineCenterX) {
    const dRad = Math.hypot((px - spineCenterX) / rSpine, (py - yMid) / halfH) - 1;
    dCore = dRad * Math.min(rSpine, halfH);
  } else {
    dCore = Math.max(dy, foreX - px);
  }
  return Math.min(dCore, dTopBoard, dBotBoard);
}

function evalPagesSdf(px, py, spec) {
  const {
    xLeft,
    xRight,
    yTop,
    yBot,
    spineSide,
    boardThick,
    spineBand,
    lip,
    concave,
  } = spec;
  const yPTop = yTop + boardThick;
  const yPBot = yBot - boardThick;
  const pH = yPBot - yPTop;
  const halfH = pH * 0.5;
  const yMid = (yPTop + yPBot) * 0.5;
  const rInner = pH * 0.34;
  const dy = Math.abs(py - yMid) - halfH;

  const v = clamp01((py - yPTop) / pH);
  const parabola = 4 * v * (1 - v);

  if (spineSide === 'left') {
    const xApex = xLeft + spineBand;
    const spineCenterX = xApex + rInner;
    const xFore = xRight - lip + 2 - concave * 0.52 * parabola;
    if (px < spineCenterX) {
      const dEll =
        (Math.hypot((px - spineCenterX) / rInner, (py - yMid) / halfH) - 1) *
        Math.min(rInner, halfH);
      return Math.max(dEll, px - xFore);
    }
    return Math.max(dy, px - xFore);
  }

  const xApex = xRight - spineBand;
  const spineCenterX = xApex - rInner;
  const xFore = xLeft + lip - 2 + concave * 0.52 * parabola;
  if (px > spineCenterX) {
    const dEll =
      (Math.hypot((px - spineCenterX) / rInner, (py - yMid) / halfH) - 1) *
      Math.min(rInner, halfH);
    return Math.max(dEll, xFore - px);
  }
  return Math.max(dy, xFore - px);
}

function evalRibbonSdf(px, py, r = RIB_SPEC) {
  const midX = (r.left + r.right) * 0.5;
  const halfW = (r.right - r.left) * 0.5;
  const dx = Math.abs(px - midX);
  const notchY = r.bot - (1 - clamp01(dx / halfW)) * r.notch;
  const dX = dx - halfW;
  const dTop = r.top - py;
  const dBot = py - notchY;

  // Rounded top corners (radius 6)
  if (py < r.top + 6) {
    const qx = dx - halfW + 6;
    const qy = r.top + 6 - py;
    if (qx > 0 && qy > 0) {
      return Math.hypot(qx, qy) - 6;
    }
  }
  return Math.max(dX, dTop, dBot);
}

function sampleStackIcon(nx, ny, { bookScale = 1.0, mode = 'light' } = {}) {
  const isDark = mode === 'dark';
  const isTinted = mode === 'tinted';

  // 1. Tile Ground: Vellum-matched Oxblood-Claret (Light) vs Sleek Obsidian-Charcoal (Dark / Tinted)
  const gradT = clamp01(ny * 0.94 + Math.hypot(nx - 0.5, ny - 0.18) * 0.12);
  let r = isDark
    ? mix(0x2d, 0x12, gradT)
    : isTinted
    ? mix(0x20, 0x0e, gradT)
    : mix(0x9f, 0x47, gradT);
  let g = isDark
    ? mix(0x2a, 0x11, gradT)
    : isTinted
    ? mix(0x13, 0x08, gradT)
    : mix(0x23, 0x0d, gradT);
  let b = isDark
    ? mix(0x2d, 0x13, gradT)
    : isTinted
    ? mix(0x16, 0x0a, gradT)
    : mix(0x35, 0x16, gradT);

  // Map normalized [0, 1] into 1024×1024 icon space scaled around optical center (512, 513)
  const px = 512 + ((nx - 0.5) * 1024) / bookScale;
  const py = 513 + ((ny - 0.5) * 1024) / bookScale;
  const aa = 1.35 / bookScale;

  const applyBookLayer = (spec, palette) => {
    // Soft ambient shadow beneath each hardcover
    const dSh = evalCoverSdf(px, py - 14, spec);
    if (dSh < 28) {
      const shA =
        (1 - smoothstep(-6, 28, dSh)) * (isDark ? 0.36 : 0.25);
      r *= 1 - shA;
      g *= 1 - shA;
      b *= 1 - shA;
    }

    // Hardcover Casing
    const dCov = evalCoverSdf(px, py, spec);
    if (dCov < aa) {
      const cov = 1 - smoothstep(-aa, aa, dCov);
      const tY = clamp01((py - spec.yTop) / (spec.yBot - spec.yTop));
      const specRim = smoothstep(-6.5, -1.0, dCov) * (1 - tY * 0.45);
      const fillR = mix(r, mix(palette.top[0], palette.bot[0], tY), palette.opacity);
      const fillG = mix(g, mix(palette.top[1], palette.bot[1], tY), palette.opacity);
      const fillB = mix(b, mix(palette.top[2], palette.bot[2], tY), palette.opacity);
      const outR = mix(fillR, palette.rim[0], specRim * 0.44);
      const outG = mix(fillG, palette.rim[1], specRim * 0.44);
      const outB = mix(fillB, palette.rim[2], specRim * 0.44);
      r = mix(r, outR, cov);
      g = mix(g, outG, cov);
      b = mix(b, outB, cov);
    }

    // Sculpted Ivory-Vellum Page Block
    const dPg = evalPagesSdf(px, py, spec);
    if (dPg < aa) {
      const cov = 1 - smoothstep(-aa, aa, dPg);
      const yPTop = spec.yTop + spec.boardThick;
      const yPBot = spec.yBot - spec.boardThick;
      const vNorm = clamp01((py - yPTop) / (yPBot - yPTop));
      const specEdge = smoothstep(-5.5, -0.9, dPg) * (1 - vNorm * 0.4);
      const innerShadow =
        (1 - smoothstep(0, 10, py - yPTop)) * 0.05 +
        (1 - smoothstep(0, 8, yPBot - py)) * 0.04;

      let pgR;
      let pgG;
      let pgB;
      if (isDark) {
        pgR = mix(245, 217, vNorm) * (1 - innerShadow) + specEdge * 13;
        pgG = mix(238, 205, vNorm) * (1 - innerShadow) + specEdge * 13;
        pgB = mix(226, 188, vNorm) * (1 - innerShadow) + specEdge * 13;
      } else if (isTinted) {
        pgR = mix(214, 178, vNorm) * (1 - innerShadow) + specEdge * 14;
        pgG = mix(94, 72, vNorm) * (1 - innerShadow) + specEdge * 8;
        pgB = mix(116, 90, vNorm) * (1 - innerShadow) + specEdge * 10;
      } else {
        pgR = mix(254, 236, vNorm) * (1 - innerShadow) + specEdge * 12;
        pgG = mix(250, 227, vNorm) * (1 - innerShadow) + specEdge * 12;
        pgB = mix(243, 213, vNorm) * (1 - innerShadow) + specEdge * 12;
      }

      r = mix(r, Math.min(255, pgR), cov);
      g = mix(g, Math.min(255, pgG), cov);
      b = mix(b, Math.min(255, pgB), cov);
    }
  };

  const botPalette = isDark
    ? { top: [0xbe, 0x27, 0x3d], bot: [0x77, 0x11, 0x20], rim: [0xff, 0x7b, 0x91], opacity: 0.94 }
    : isTinted
    ? { top: [0x78, 0x32, 0x40], bot: [0x52, 0x20, 0x2a], rim: [0xb4, 0x5c, 0x6e], opacity: 0.90 }
    : { top: [0xf6, 0xd0, 0xd6], bot: [0xe8, 0xb8, 0xc1], rim: [0xff, 0xeb, 0xee], opacity: 0.56 };

  const midPalette = isDark
    ? { top: [0xe1, 0xb2, 0x69], bot: [0xa8, 0x74, 0x32], rim: [0xff, 0xe0, 0xa8], opacity: 0.94 }
    : isTinted
    ? { top: [0x8c, 0x3c, 0x4c], bot: [0x5e, 0x25, 0x31], rim: [0xc6, 0x6a, 0x7d], opacity: 0.92 }
    : { top: [0xea, 0xbf, 0x79], bot: [0xb9, 0x83, 0x3e], rim: [0xff, 0xe8, 0xbd], opacity: 0.92 };

  const topPalette = isDark
    ? { top: [0xe3, 0x34, 0x4c], bot: [0x96, 0x17, 0x29], rim: [0xff, 0x86, 0x9b], opacity: 0.95 }
    : isTinted
    ? { top: [0x6e, 0x2b, 0x38], bot: [0x46, 0x19, 0x22], rim: [0xa8, 0x54, 0x65], opacity: 0.92 }
    : { top: [0xdc, 0x35, 0x4c], bot: [0x93, 0x16, 0x28], rim: [0xff, 0x8c, 0x9f], opacity: 0.90 };

  // Stack bottom -> middle -> top so upper books cast natural contact shadows onto lower books
  applyBookLayer(BOT_SPEC, botPalette);
  applyBookLayer(MID_SPEC, midPalette);
  applyBookLayer(TOP_SPEC, topPalette);

  // Swallowtail Bookmark Ribbon + Soft Layer-Color Cast Shadow
  const dRibSh = evalRibbonSdf(px - 4, py - 10);
  if (dRibSh < 16) {
    const sh = (1 - smoothstep(-3, 16, dRibSh)) * 0.24;
    r = mix(r, isTinted ? 0x24 : 0x5c, sh);
    g = mix(g, 0x0e, sh);
    b = mix(b, isTinted ? 0x16 : 0x19, sh);
  }

  const dRib = evalRibbonSdf(px, py);
  if (dRib < aa) {
    const cov = 1 - smoothstep(-aa, aa, dRib);
    const tRib = clamp01((py - RIB_SPEC.top) / (RIB_SPEC.bot - RIB_SPEC.top));
    const specRim = smoothstep(-5.0, -0.8, dRib) * (1 - tRib * 0.38);

    let ribR;
    let ribG;
    let ribB;
    if (isDark) {
      ribR = mix(mix(0xeb, 0x9c, tRib), 0xff, specRim * 0.42);
      ribG = mix(mix(0x30, 0x15, tRib), 0x84, specRim * 0.36);
      ribB = mix(mix(0x48, 0x28, tRib), 0x98, specRim * 0.36);
    } else if (isTinted) {
      ribR = mix(mix(0x58, 0x3c, tRib), 0x9c, specRim * 0.35);
      ribG = mix(mix(0x1e, 0x13, tRib), 0x48, specRim * 0.35);
      ribB = mix(mix(0x29, 0x1b, tRib), 0x58, specRim * 0.35);
    } else {
      ribR = mix(mix(0xd8, 0x8d, tRib), 0xff, specRim * 0.40);
      ribG = mix(mix(0x2b, 0x13, tRib), 0x7c, specRim * 0.35);
      ribB = mix(mix(0x41, 0x24, tRib), 0x90, specRim * 0.35);
    }

    r = mix(r, ribR, cov);
    g = mix(g, ribG, cov);
    b = mix(b, ribB, cov);
  }

  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
}

function sampleMonochromeAlpha(nx, ny, bookScale = 0.80) {
  const px = 512 + ((nx - 0.5) * 1024) / bookScale;
  const py = 513 + ((ny - 0.5) * 1024) / bookScale;
  const aa = 1.6 / bookScale;
  const moat = 14;

  // Ribbon with clean negative-space moat carved out of Top & Middle books
  const dRib = evalRibbonSdf(px, py);
  if (dRib < aa) {
    return 1 - smoothstep(-aa, aa, dRib);
  }
  const inRibbonMoat = dRib < moat;

  let alpha = 0;
  for (const rawSpec of [TOP_SPEC, MID_SPEC, BOT_SPEC]) {
    // Give each stacked book a 3.5px vertical moat in 1-bit monochrome so all 3 books stay clearly distinct at 48dp
    const spec = {
      ...rawSpec,
      yTop: rawSpec.yTop + 3.5,
      yBot: rawSpec.yBot - 3.5,
      boardThick: rawSpec.boardThick - 2,
    };
    const dCov = evalCoverSdf(px, py, spec);
    if (dCov >= aa) continue;
    const dPgOuter = evalPagesSdf(px, py, spec);
    const dPgInner = evalPagesSdf(px, py, {
      ...spec,
      boardThick: spec.boardThick + 11,
      spineBand: spec.spineBand + 11,
      lip: spec.lip + 11,
    });
    let partAlpha = 0;
    if (dPgInner < aa) {
      partAlpha = 1 - smoothstep(-aa, aa, dPgInner);
    } else if (dPgOuter > -aa) {
      partAlpha = Math.min(
        1 - smoothstep(-aa, aa, dCov),
        smoothstep(-aa, aa, dPgOuter)
      );
    }
    if (inRibbonMoat) {
      partAlpha *= smoothstep(moat - aa * 1.6, moat, dRib);
    }
    alpha = Math.max(alpha, partAlpha);
  }

  return clamp01(alpha);
}

function renderRgbIconPng(size, opts = {}) {
  const buf = Buffer.alloc(size * size * 3);
  const sub = 3;
  const invSub = 1 / sub;
  const invTotal = 1 / (sub * sub);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sy = 0; sy < sub; sy++) {
        const ny = (y + (sy + 0.5) * invSub) / size;
        for (let sx = 0; sx < sub; sx++) {
          const nx = (x + (sx + 0.5) * invSub) / size;
          const [r, g, b] = sampleStackIcon(nx, ny, opts);
          sr += r;
          sg += g;
          sb += b;
        }
      }
      const idx = (y * size + x) * 3;
      buf[idx] = Math.round(sr * invTotal);
      buf[idx + 1] = Math.round(sg * invTotal);
      buf[idx + 2] = Math.round(sb * invTotal);
    }
  }
  return encodePng(size, size, buf, 3);
}

function renderMonochromePng(size, bookScale = 0.80) {
  const buf = Buffer.alloc(size * size * 4);
  const sub = 3;
  const invSub = 1 / sub;
  const invTotal = 1 / (sub * sub);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sa = 0;
      for (let sy = 0; sy < sub; sy++) {
        const ny = (y + (sy + 0.5) * invSub) / size;
        for (let sx = 0; sx < sub; sx++) {
          const nx = (x + (sx + 0.5) * invSub) / size;
          sa += sampleMonochromeAlpha(nx, ny, bookScale);
        }
      }
      const idx = (y * size + x) * 4;
      buf[idx] = 255;
      buf[idx + 1] = 255;
      buf[idx + 2] = 255;
      buf[idx + 3] = Math.round(sa * invTotal * 255);
    }
  }
  return encodePng(size, size, buf, 4);
}

// ---------------------------------------------------------------------------
// 1. Native iOS Liquid Glass Bundle (`icons/ios/AppIcon.icon`)
// ---------------------------------------------------------------------------
const iosRoot = path.join(rootDir, 'icons', 'ios');
const liquidBundleDir = path.join(iosRoot, 'AppIcon.icon');
const liquidAssetsDir = path.join(liquidBundleDir, 'Assets');
fs.mkdirSync(liquidAssetsDir, { recursive: true });

const wrapSvg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n  <path d="${d}" fill="#FFFFFF"/>\n</svg>\n`;

const topCoverD = buildCoverPath(TOP_SPEC);
const topPagesD = buildPagesPath(TOP_SPEC);
const midCoverD = buildCoverPath(MID_SPEC);
const midPagesD = buildPagesPath(MID_SPEC);
const botCoverD = buildCoverPath(BOT_SPEC);
const botPagesD = buildPagesPath(BOT_SPEC);
const ribbonD = buildRibbonPath(RIB_SPEC);

fs.writeFileSync(path.join(liquidAssetsDir, 'top-cover.svg'), wrapSvg(topCoverD));
fs.writeFileSync(path.join(liquidAssetsDir, 'top-pages.svg'), wrapSvg(topPagesD));
fs.writeFileSync(path.join(liquidAssetsDir, 'mid-cover.svg'), wrapSvg(midCoverD));
fs.writeFileSync(path.join(liquidAssetsDir, 'mid-pages.svg'), wrapSvg(midPagesD));
fs.writeFileSync(path.join(liquidAssetsDir, 'bot-cover.svg'), wrapSvg(botCoverD));
fs.writeFileSync(path.join(liquidAssetsDir, 'bot-pages.svg'), wrapSvg(botPagesD));
fs.writeFileSync(path.join(liquidAssetsDir, 'ribbon.svg'), wrapSvg(ribbonD));

const liquidIconJson = {
  'fill-specializations': [
    {
      value: {
        'linear-gradient': [
          'extended-srgb:0.62400,0.13700,0.20800,1.00000',
          'extended-srgb:0.27800,0.05100,0.08800,1.00000',
        ],
      },
    },
    {
      appearance: 'dark',
      value: {
        'linear-gradient': [
          'extended-srgb:0.17300,0.16100,0.17300,1.00000',
          'extended-srgb:0.06700,0.06300,0.07100,1.00000',
        ],
      },
    },
  ],
  groups: [
    {
      name: 'Ribbon',
      specular: true,
      shadow: { kind: 'layer-color', opacity: 0.42 },
      translucency: { enabled: true, value: 0.04 },
      layers: [
        {
          name: 'Ribbon',
          'image-name': 'ribbon.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.84500,0.16800,0.25500,1.00000',
                  'extended-srgb:0.55300,0.07500,0.14100,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.92200,0.18800,0.28200,1.00000',
                  'extended-srgb:0.61200,0.08200,0.15700,1.00000',
                ],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Top Book Pages',
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.24 },
      translucency: { enabled: true, value: 0.06 },
      layers: [
        {
          name: 'Top Pages',
          'image-name': 'top-pages.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.99600,0.98600,0.96500,1.00000',
                  'extended-srgb:0.93800,0.90000,0.84500,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.96100,0.93300,0.88600,1.00000',
                  'extended-srgb:0.86700,0.82000,0.75300,1.00000',
                ],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Top Book Cover',
      'blur-material': 0.36,
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.42 },
      translucency: { enabled: true, value: 0.16 },
      layers: [
        {
          name: 'Top Cover',
          'image-name': 'top-cover.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.86500,0.20800,0.29800,1.00000',
                  'extended-srgb:0.57500,0.08600,0.15700,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.89000,0.20400,0.29800,1.00000',
                  'extended-srgb:0.59000,0.09000,0.16100,1.00000',
                ],
              },
            },
          ],
          'opacity-specializations': [
            { value: 0.90 },
            { appearance: 'dark', value: 0.95 },
          ],
        },
      ],
    },
    {
      name: 'Middle Book Pages',
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.24 },
      translucency: { enabled: true, value: 0.06 },
      layers: [
        {
          name: 'Middle Pages',
          'image-name': 'mid-pages.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.99000,0.97600,0.95100,1.00000',
                  'extended-srgb:0.92500,0.88400,0.82500,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.94500,0.91400,0.86700,1.00000',
                  'extended-srgb:0.84300,0.79600,0.72900,1.00000',
                ],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Middle Book Cover',
      'blur-material': 0.34,
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.42 },
      translucency: { enabled: true, value: 0.14 },
      layers: [
        {
          name: 'Middle Cover',
          'image-name': 'mid-cover.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.91800,0.74900,0.47500,1.00000',
                  'extended-srgb:0.72500,0.51400,0.24300,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.88200,0.69800,0.41200,1.00000',
                  'extended-srgb:0.65900,0.45500,0.19600,1.00000',
                ],
              },
            },
          ],
          'opacity-specializations': [
            { value: 0.92 },
            { appearance: 'dark', value: 0.94 },
          ],
        },
      ],
    },
    {
      name: 'Bottom Book Pages',
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.24 },
      translucency: { enabled: true, value: 0.06 },
      layers: [
        {
          name: 'Bottom Pages',
          'image-name': 'bot-pages.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                'linear-gradient': [
                  'extended-srgb:0.98600,0.97000,0.94200,1.00000',
                  'extended-srgb:0.91400,0.87000,0.80800,1.00000',
                ],
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.92900,0.89600,0.84700,1.00000',
                  'extended-srgb:0.82000,0.77000,0.70200,1.00000',
                ],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Bottom Book Cover',
      'blur-material': 0.45,
      specular: true,
      shadow: { kind: 'neutral', opacity: 0.46 },
      translucency: { enabled: true, value: 0.22 },
      layers: [
        {
          name: 'Bottom Cover',
          'image-name': 'bot-cover.svg',
          glass: true,
          'fill-specializations': [
            {
              value: {
                solid: 'extended-srgb:0.96500,0.81600,0.83900,1.00000',
              },
            },
            {
              appearance: 'dark',
              value: {
                'linear-gradient': [
                  'extended-srgb:0.74500,0.15300,0.23900,1.00000',
                  'extended-srgb:0.46700,0.06700,0.12500,1.00000',
                ],
              },
            },
          ],
          'opacity-specializations': [
            { value: 0.56 },
            { appearance: 'dark', value: 0.94 },
          ],
        },
      ],
    },
  ],
  'supported-platforms': {
    squares: ['iOS'],
  },
};

fs.writeFileSync(
  path.join(liquidBundleDir, 'icon.json'),
  JSON.stringify(liquidIconJson, null, 2) + '\n'
);
console.log('✓ Wrote native iOS Liquid Glass bundle at icons/ios/AppIcon.icon');

// ---------------------------------------------------------------------------
// 2. iOS AppIcon.appiconset (1024×1024 Light, Dark & Tinted 24-bit RGB)
// ---------------------------------------------------------------------------
const appIconSetDir = path.join(iosRoot, 'AppIcon.appiconset');
fs.mkdirSync(appIconSetDir, { recursive: true });

const masterLight1024 = renderRgbIconPng(1024, { bookScale: 1.0, mode: 'light' });
const masterDark1024 = renderRgbIconPng(1024, { bookScale: 1.0, mode: 'dark' });
const masterTinted1024 = renderRgbIconPng(1024, { bookScale: 1.0, mode: 'tinted' });

fs.writeFileSync(path.join(appIconSetDir, 'AppIcon-512@2x.png'), masterLight1024);
fs.writeFileSync(path.join(appIconSetDir, 'AppIcon-Dark-512@2x.png'), masterDark1024);
fs.writeFileSync(path.join(appIconSetDir, 'AppIcon-Tinted-512@2x.png'), masterTinted1024);
fs.writeFileSync(
  path.join(appIconSetDir, 'Contents.json'),
  JSON.stringify(
    {
      images: [
        {
          filename: 'AppIcon-512@2x.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
        {
          appearances: [{ appearance: 'luminosity', value: 'dark' }],
          filename: 'AppIcon-Dark-512@2x.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
        {
          appearances: [{ appearance: 'luminosity', value: 'tinted' }],
          filename: 'AppIcon-Tinted-512@2x.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
      ],
      info: { author: 'xcode', version: 1 },
    },
    null,
    2
  ) + '\n'
);
console.log('✓ Wrote Light, Dark & Tinted 1024×1024 icons in icons/ios/AppIcon.appiconset');

// ---------------------------------------------------------------------------
// 3. Web & PWA Icons (`public/`)
// ---------------------------------------------------------------------------
function buildResponsiveVectorSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="512" height="512">
  <defs>
    <linearGradient id="bgLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9F2335"/>
      <stop offset="100%" stop-color="#470D16"/>
    </linearGradient>
    <linearGradient id="bgDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2C292C"/>
      <stop offset="100%" stop-color="#111012"/>
    </linearGradient>
    <linearGradient id="topCovLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#DC354C"/>
      <stop offset="100%" stop-color="#931628"/>
    </linearGradient>
    <linearGradient id="topCovDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#E3344C"/>
      <stop offset="100%" stop-color="#961729"/>
    </linearGradient>
    <linearGradient id="midCovLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EABF79"/>
      <stop offset="100%" stop-color="#B9833E"/>
    </linearGradient>
    <linearGradient id="midCovDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#E1B269"/>
      <stop offset="100%" stop-color="#A87432"/>
    </linearGradient>
    <linearGradient id="botCovDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#BE273D"/>
      <stop offset="100%" stop-color="#771120"/>
    </linearGradient>
    <linearGradient id="pagesLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FEFBF6"/>
      <stop offset="100%" stop-color="#EFE5D7"/>
    </linearGradient>
    <linearGradient id="pagesDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F5EEE2"/>
      <stop offset="100%" stop-color="#D9CCB9"/>
    </linearGradient>
    <linearGradient id="ribLight" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#D82B41"/>
      <stop offset="100%" stop-color="#8D1324"/>
    </linearGradient>
    <linearGradient id="ribDark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EB3048"/>
      <stop offset="100%" stop-color="#9C1528"/>
    </linearGradient>
    <filter id="stackShadow" x="-12%" y="-10%" width="124%" height="128%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#1E0408" flood-opacity="0.36"/>
    </filter>
    <style>
      .bg { fill: url(#bgLight); }
      .bot-cov { fill: #F6D0D6; fill-opacity: 0.56; stroke: #FFE8EC; stroke-opacity: 0.42; stroke-width: 3; }
      .mid-cov { fill: url(#midCovLight); stroke: #FFE8BD; stroke-opacity: 0.45; stroke-width: 3; }
      .top-cov { fill: url(#topCovLight); stroke: #FF8C9F; stroke-opacity: 0.45; stroke-width: 3; }
      .pages { fill: url(#pagesLight); }
      .rib { fill: url(#ribLight); stroke: #FF8A9D; stroke-opacity: 0.45; stroke-width: 2.5; }
      @media (prefers-color-scheme: dark) {
        .bg { fill: url(#bgDark); }
        .bot-cov { fill: url(#botCovDark); fill-opacity: 0.95; stroke: #FF7B91; stroke-opacity: 0.40; }
        .mid-cov { fill: url(#midCovDark); stroke: #FFE0A8; stroke-opacity: 0.42; }
        .top-cov { fill: url(#topCovDark); stroke: #FF869B; stroke-opacity: 0.45; }
        .pages { fill: url(#pagesDark); }
        .rib { fill: url(#ribDark); stroke: #FF8FA2; stroke-opacity: 0.50; }
      }
    </style>
  </defs>

  <rect width="1024" height="1024" rx="228" class="bg"/>

  <g filter="url(#stackShadow)">
    <path d="${botCoverD}" class="bot-cov"/>
    <path d="${botPagesD}" class="pages"/>
    <path d="${midCoverD}" class="mid-cov"/>
    <path d="${midPagesD}" class="pages"/>
    <path d="${topCoverD}" class="top-cov"/>
    <path d="${topPagesD}" class="pages"/>
    <path d="${ribbonD}" fill="#5C0E19" fill-opacity="0.22" transform="translate(4, 10)"/>
    <path d="${ribbonD}" class="rib"/>
  </g>
</svg>
`;
}

const publicDir = path.join(rootDir, 'public');
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, 'icon.svg'), buildResponsiveVectorSvg(), 'utf8');

// Standard Light & Dark PWA icons + iOS Apple Touch Icons
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), renderRgbIconPng(180, { bookScale: 1.0, mode: 'light' }));
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon-dark.png'), renderRgbIconPng(180, { bookScale: 1.0, mode: 'dark' }));
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), renderRgbIconPng(192, { bookScale: 1.0, mode: 'light' }));
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), renderRgbIconPng(512, { bookScale: 1.0, mode: 'light' }));
fs.writeFileSync(path.join(publicDir, 'icon-dark-192.png'), renderRgbIconPng(192, { bookScale: 1.0, mode: 'dark' }));
fs.writeFileSync(path.join(publicDir, 'icon-dark-512.png'), renderRgbIconPng(512, { bookScale: 1.0, mode: 'dark' }));

// Android Maskable safe-zone icons (scaled to 0.78 so circle/squircle/teardrop masks never clip)
fs.writeFileSync(path.join(publicDir, 'icon-maskable-192.png'), renderRgbIconPng(192, { bookScale: 0.78, mode: 'light' }));
fs.writeFileSync(path.join(publicDir, 'icon-maskable-512.png'), renderRgbIconPng(512, { bookScale: 0.78, mode: 'light' }));

// Android Material You WebAPK Monochrome icon (RGBA white silhouette with negative-space moats)
fs.writeFileSync(path.join(publicDir, 'icon-monochrome-512.png'), renderMonochromePng(512, 0.78));
console.log('✓ Wrote responsive public/icon.svg, Light/Dark PNGs, Maskable PNGs, Monochrome PNG, and apple-touch-icon.png');

// ---------------------------------------------------------------------------
// 4. Native Android Adaptive Day/Night + Material You Monochrome (`icons/android/res/`)
// ---------------------------------------------------------------------------
const androidResDir = path.join(rootDir, 'icons', 'android', 'res');
const drawableDir = path.join(androidResDir, 'drawable');
const drawableNightDir = path.join(androidResDir, 'drawable-night');
const anydpiDir = path.join(androidResDir, 'mipmap-anydpi-v26');
const valuesDir = path.join(androidResDir, 'values');
const valuesNightDir = path.join(androidResDir, 'values-night');

for (const d of [drawableDir, drawableNightDir, anydpiDir, valuesDir, valuesNightDir]) {
  fs.mkdirSync(d, { recursive: true });
}

const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>
</adaptive-icon>
`;
fs.writeFileSync(path.join(anydpiDir, 'ic_launcher.xml'), adaptiveXml, 'utf8');
fs.writeFileSync(path.join(anydpiDir, 'ic_launcher_round.xml'), adaptiveXml, 'utf8');

fs.writeFileSync(
  path.join(valuesDir, 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#7A1827</color>\n</resources>\n`,
  'utf8'
);
fs.writeFileSync(
  path.join(valuesNightDir, 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1A171A</color>\n</resources>\n`,
  'utf8'
);

const buildAndroidBackgroundXml = (startHex, endHex) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <path android:pathData="M 0 0 H 1024 V 1024 H 0 Z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:startX="512"
                android:startY="0"
                android:endX="512"
                android:endY="1024"
                android:type="linear">
                <item android:offset="0" android:color="${startHex}"/>
                <item android:offset="1" android:color="${endHex}"/>
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;

fs.writeFileSync(
  path.join(drawableDir, 'ic_launcher_background.xml'),
  buildAndroidBackgroundXml('#FF9F2335', '#FF470D16'),
  'utf8'
);
fs.writeFileSync(
  path.join(drawableNightDir, 'ic_launcher_background.xml'),
  buildAndroidBackgroundXml('#FF2C292C', '#FF111012'),
  'utf8'
);

const buildAndroidForegroundXml = (isNight) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <group
        android:pivotX="512"
        android:pivotY="513"
        android:scaleX="0.70"
        android:scaleY="0.70">
        <!-- Bottom Book Casing & Pages -->
        <path
            android:pathData="${botCoverD}"
            android:strokeColor="${isNight ? '#66FF7B91' : '#66FFE8EC'}"
            android:strokeWidth="4"
            ${
              isNight
                ? `>`
                : `android:fillColor="#8FF6D0D6"/>`
            }
            ${
              isNight
                ? `<aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="591" android:endX="512" android:endY="764" android:type="linear">
                    <item android:offset="0" android:color="#F0BE273D"/>
                    <item android:offset="1" android:color="#F0771120"/>
                </gradient>
            </aapt:attr>
        </path>`
                : ''
            }
        <path android:pathData="${botPagesD}">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="617" android:endX="512" android:endY="738" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#FFF1E9DD' : '#FFFCF9F2'}"/>
                    <item android:offset="1" android:color="${isNight ? '#FFD4C7B4' : '#FFEBE0D0'}"/>
                </gradient>
            </aapt:attr>
        </path>

        <!-- Middle Book Burnished Gilt Casing & Pages -->
        <path
            android:pathData="${midCoverD}"
            android:strokeColor="${isNight ? '#66FFE0A8' : '#73FFE8BD'}"
            android:strokeWidth="4">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="423" android:endX="512" android:endY="588" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#F0E1B269' : '#EBEABF79'}"/>
                    <item android:offset="1" android:color="${isNight ? '#F0A87432' : '#EBB9833E'}"/>
                </gradient>
            </aapt:attr>
        </path>
        <path android:pathData="${midPagesD}">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="448" android:endX="512" android:endY="563" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#FFF3ECE0' : '#FFFDF9F3'}"/>
                    <item android:offset="1" android:color="${isNight ? '#FFD8CBB8' : '#FFEDE2D3'}"/>
                </gradient>
            </aapt:attr>
        </path>

        <!-- Top Book Ruby-Claret Casing & Pages -->
        <path
            android:pathData="${topCoverD}"
            android:strokeColor="${isNight ? '#73FF869B' : '#73FF8C9F'}"
            android:strokeWidth="4">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="262" android:endX="512" android:endY="420" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#F2E3344C' : '#E6DC354C'}"/>
                    <item android:offset="1" android:color="${isNight ? '#F2961729' : '#E6931628'}"/>
                </gradient>
            </aapt:attr>
        </path>
        <path android:pathData="${topPagesD}">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="512" android:startY="286" android:endX="512" android:endY="396" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#FFF5EEE2' : '#FFFEFBF6'}"/>
                    <item android:offset="1" android:color="${isNight ? '#FFDDD1C0' : '#FFF1E8DB'}"/>
                </gradient>
            </aapt:attr>
        </path>

        <!-- Swallowtail Bookmark Ribbon -->
        <path
            android:pathData="${ribbonD}"
            android:strokeColor="${isNight ? '#80FF8FA2' : '#73FF8A9D'}"
            android:strokeWidth="3">
            <aapt:attr name="android:fillColor">
                <gradient android:startX="674" android:startY="286" android:endX="674" android:endY="472" android:type="linear">
                    <item android:offset="0" android:color="${isNight ? '#FFEB3048' : '#FFD82B41'}"/>
                    <item android:offset="1" android:color="${isNight ? '#FF9C1528' : '#FF8D1324'}"/>
                </gradient>
            </aapt:attr>
        </path>
    </group>
</vector>
`;

fs.writeFileSync(
  path.join(drawableDir, 'ic_launcher_foreground.xml'),
  buildAndroidForegroundXml(false),
  'utf8'
);
fs.writeFileSync(
  path.join(drawableNightDir, 'ic_launcher_foreground.xml'),
  buildAndroidForegroundXml(true),
  'utf8'
);

// Monochrome VectorDrawable with negative-space moats around ribbon & page blocks
const ribMoatLeft = RIB_SPEC.left - 16;
const ribMoatRight = RIB_SPEC.right + 16;
const ribMoatTop = RIB_SPEC.top - 12;
const ribMoatBot = RIB_SPEC.bot + 20;
const ribMoatMid = (RIB_SPEC.left + RIB_SPEC.right) / 2;
const ribbonMoatCutout = `M ${ribMoatLeft} ${ribMoatTop} L ${ribMoatRight} ${ribMoatTop} L ${ribMoatRight} ${ribMoatBot} L ${ribMoatMid} ${ribMoatBot - 22} L ${ribMoatLeft} ${ribMoatBot} Z`;

const monoBookSpec = (s) => ({
  ...s,
  yTop: s.yTop + 3.5,
  yBot: s.yBot - 3.5,
  boardThick: s.boardThick - 2,
});

const shrinkPageSpec = (s, inset = 11) => ({
  ...s,
  boardThick: s.boardThick + inset,
  spineBand: s.spineBand + inset,
  lip: s.lip + inset,
});

const monoBot = monoBookSpec(BOT_SPEC);
const monoMid = monoBookSpec(MID_SPEC);
const monoTop = monoBookSpec(TOP_SPEC);

const monochromeXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <group
        android:pivotX="512"
        android:pivotY="513"
        android:scaleX="0.68"
        android:scaleY="0.68">
        <!-- Bottom Book Casing & Inset Page Block -->
        <path android:pathData="${buildMonochromeCasingPath(monoBot)}" android:fillColor="#FFFFFFFF"/>
        <path android:pathData="${buildPagesPath(shrinkPageSpec(monoBot))}" android:fillColor="#FFFFFFFF"/>

        <!-- Middle Book Casing & Inset Page Block (with negative-space ribbon moat) -->
        <path android:fillType="evenOdd" android:pathData="${buildMonochromeCasingPath(monoMid)} ${ribbonMoatCutout}" android:fillColor="#FFFFFFFF"/>
        <path android:fillType="evenOdd" android:pathData="${buildPagesPath(shrinkPageSpec(monoMid))} ${ribbonMoatCutout}" android:fillColor="#FFFFFFFF"/>

        <!-- Top Book Casing & Inset Page Block (with negative-space ribbon moat) -->
        <path android:fillType="evenOdd" android:pathData="${buildMonochromeCasingPath(monoTop)}" android:fillColor="#FFFFFFFF"/>
        <path android:fillType="evenOdd" android:pathData="${buildPagesPath(shrinkPageSpec(monoTop))} ${ribbonMoatCutout}" android:fillColor="#FFFFFFFF"/>

        <!-- Swallowtail Bookmark Ribbon Nested Inside Moat -->
        <path android:pathData="${ribbonD}" android:fillColor="#FFFFFFFF"/>
    </group>
</vector>
`;
fs.writeFileSync(path.join(drawableDir, 'ic_launcher_monochrome.xml'), monochromeXml, 'utf8');

// Android legacy mipmap PNGs (48..192)
const tmpMaster = path.join(androidResDir, '_tmp-master-1024.png');
fs.writeFileSync(tmpMaster, masterLight1024);
const mipmapSizes = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];
for (const m of mipmapSizes) {
  const targetDir = path.join(androidResDir, m.dir);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of ['ic_launcher.png', 'ic_launcher_round.png']) {
    spawnSync('/usr/bin/sips', ['-z', String(m.size), String(m.size), tmpMaster, '--out', path.join(targetDir, file)], {
      stdio: 'ignore',
    });
  }
}
fs.rmSync(tmpMaster, { force: true });
console.log('✓ Wrote Android Adaptive Day/Night, Material You Monochrome, and mipmap icons in icons/android/res/');
