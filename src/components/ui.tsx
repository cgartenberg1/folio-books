'use client';

import React from 'react';
import { Star } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Small typographic helpers                                           */
/* ------------------------------------------------------------------ */

const SMALL_NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

const TENS_WORDS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spells out counts below one hundred the way a printed book would ("twenty-four titles"). */
export function countWord(n: number, capitalize = false): string {
  let word: string;
  if (n >= 0 && n <= 20) {
    word = SMALL_NUMBER_WORDS[n];
  } else if (n > 20 && n < 100) {
    const tens = TENS_WORDS[Math.floor(n / 10)];
    const ones = n % 10;
    word = ones ? `${tens}-${SMALL_NUMBER_WORDS[ones]}` : tens;
  } else {
    word = n.toLocaleString();
  }
  return capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : pluralForm || `${singular}s`;
}

const ROMAN: Array<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(num: number): string {
  let n = Math.max(0, Math.floor(num));
  let out = '';
  for (const [value, glyph] of ROMAN) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ornaments                                                           */
/* ------------------------------------------------------------------ */

export function Fleuron({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`flex items-center justify-center gap-4 text-ink-faint ${className}`}
    >
      <span className="h-px w-12 bg-rule-strong" />
      <span className="font-display text-lg leading-none">❦</span>
      <span className="h-px w-12 bg-rule-strong" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page header — a chapter opener                                      */
/* ------------------------------------------------------------------ */

interface PageHeaderProps {
  numeral: string;
  kicker: string;
  title: string;
  dek?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ numeral, kicker, title, dek, actions }: PageHeaderProps) {
  return (
    <header className="animate-fade-up">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="caps flex items-center gap-2 text-claret">
            <span className="font-display text-[13px] font-semibold normal-case tracking-normal">
              {numeral}.
            </span>
            {kicker}
          </p>
          <h1 className="mt-2 font-display text-[44px] font-medium leading-[0.95] tracking-[-0.01em] text-ink sm:text-[56px]">
            {title}
          </h1>
          {dek && (
            <p className="mt-3 max-w-xl font-serif text-[17px] italic leading-snug text-ink-muted text-pretty">
              {dek}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
        )}
      </div>
      <div className="rule-double mt-6" />
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Section heading inside a page                                       */
/* ------------------------------------------------------------------ */

export function SectionHeading({
  title,
  meta,
  className = '',
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 border-b border-rule pb-2 ${className}`}
    >
      <h2 className="caps text-ink-soft">{title}</h2>
      {meta && (
        <span className="font-serif text-[14px] italic text-ink-muted">{meta}</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tabline — understated filter / segment control                      */
/* ------------------------------------------------------------------ */

interface TablineOption<T extends string> {
  key: T;
  label: string;
  count?: number;
}

export function Tabline<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: Array<TablineOption<T>>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`flex items-center gap-5 overflow-x-auto scrollbar-none ${className}`}
    >
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={`relative shrink-0 pb-1.5 font-sans text-[13px] transition-colors ${
              active
                ? 'text-ink font-medium'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span className="ml-1.5 font-serif text-[13px] italic text-ink-faint nums-old">
                {opt.count}
              </span>
            )}
            <span
              className={`absolute inset-x-0 -bottom-px h-px transition-colors ${
                active ? 'bg-claret' : 'bg-transparent'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state — a quiet colophon rather than an icon badge             */
/* ------------------------------------------------------------------ */

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="animate-fade-up px-4 py-16 text-center sm:py-20">
      <Fleuron />
      <h3 className="mx-auto mt-6 max-w-lg font-display text-[30px] font-medium italic leading-tight text-ink text-balance">
        {title}
      </h3>
      {body && (
        <p className="mx-auto mt-3 max-w-md font-serif text-[16.5px] leading-relaxed text-ink-muted text-pretty">
          {body}
        </p>
      )}
      {children && (
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rating — five small marks, never a row of yellow stars              */
/* ------------------------------------------------------------------ */

export function Rating({
  value,
  size = 'sm',
  className = '',
}: {
  value: number;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const dim = size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3';
  return (
    <span
      className={`inline-flex items-center gap-[3px] ${className}`}
      aria-label={`${value} out of 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          strokeWidth={1.25}
          className={`${dim} ${
            n <= value ? 'fill-claret text-claret' : 'text-rule-strong'
          }`}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Ledger layout — label gutter on the left, entries on the right       */
/* ------------------------------------------------------------------ */

export function LedgerSection({
  gutter,
  children,
  stickyTop = 'top-[132px]',
}: {
  gutter: React.ReactNode;
  children: React.ReactNode;
  stickyTop?: string;
}) {
  return (
    <section className="grid grid-cols-1 gap-x-10 border-t border-rule md:grid-cols-[168px_minmax(0,1fr)]">
      <div className="pt-5 md:pb-6">
        <div className={`md:sticky ${stickyTop}`}>{gutter}</div>
      </div>
      <div>{children}</div>
    </section>
  );
}
