# Folio — A Ledger of Books Forthcoming & Read

A fine-press responsive web app & installable Progressive Web App (PWA) for tracking forthcoming English-language book releases by week, browsing published bibliographies in reverse chronological order, importing Goodreads libraries, completing annual reading challenges, and sharing reading circles with friends.

## Features

- **Six Chapters (`i.` – `vi.`):**
  1. **Upcoming:** Forthcoming releases from followed authors and one-off picks, arranged chronologically by calendar week (`This Week`, `Next Week`, `Week of …`, plus `Unscheduled` titles).
  2. **Released:** Published books arranged by publication year in reverse chronological order with cover plates, titles, authors, release dates, and 1-tap **To read** and **Mark read** controls.
  3. **Reading:** Yearly Reading Challenge bookshelf (goal presets, day-of-year pace comparison, and interactive cloth-spine shelf) alongside your **To read** queue and **Read** ledger (with finish dates, 1–5 ratings, and commonplace notes).
  4. **Friends:** Passwordless **Magic Link** reader accounts + **Invite-Code Reading Circles** featuring annual challenge standings and a reverse-chronological commonplace feed of friends' finished books, ratings, and reviews (with 1-tap **Add to my list**).
  5. **Authors:** Surname-indexed directory (`A`–`Z`) of followed authors with 1-click bibliography refresh and manual entry for small-press or unindexed writers.
  6. **Search:** English-edition live search across the **Hardcover GraphQL API** (primary, with 15-minute server-side caching) and automatic **Google Books + Open Library** fallback. Follow full author bibliographies or click **Track release** on individual titles without following the author.
- **Goodreads & Batch Importer:** Upload `goodreads_library_export.csv` (preserving shelves, finish dates, ratings, and reviews while rolling up authors to follow) or paste batch lists of authors or books.
- **Privacy-First Multi-User Sync:** Instant local-first storage paired with **Supabase Auth + Row-Level Security (RLS)** — followed authors and reading queues remain private per account, while only finished (`read`) books and annual challenge goals are shared with members of your invite-code circles (with a 1-click pause toggle).

## Getting Started Locally

1. Copy `.env.local.example` to `.env.local` and add your Hardcover key:
   ```bash
   cp .env.local.example .env.local
   ```
2. Start the development server:
   ```bash
   ./start-dev.sh
   # or, if node/npm are on your PATH:
   npm run dev
   ```
3. Open `http://localhost:3000`.

## Sharing Folio with Friends (Multi-User Setup)

1. **Create a Free Supabase Project:**
   - Go to [supabase.com](https://supabase.com), create a project, open **SQL Editor -> New Query**, paste [`supabase/schema.sql`](./supabase/schema.sql), and click **Run**.
2. **Configure Magic Link Redirect URLs:**
   - In Supabase **Authentication -> URL Configuration**, set **Site URL** to your deployed domain (e.g. `https://your-folio.vercel.app`) and add both `https://your-folio.vercel.app/**` and `http://localhost:3000/**` under **Redirect URLs**.
3. **Deploy to Vercel (or Netlify):**
   - Push this folder to GitHub and import it in Vercel with 3 environment variables:
     - `HARDCOVER_API_KEY` (kept server-side so friends never need their own API keys)
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. **Invite Your Friends:**
   - Sign in on the **Friends** tab via Magic Link, click **New circle**, and click **Copy link** (`https://your-folio.vercel.app/?join=CODE`). Friends who open that link sign in with their email and automatically join your circle.

## Linking with Vellum (Native iOS / iPadOS / Android & Web Ebook Reader)

Folio includes a built-in two-way `/api/vellum-bridge` integration with **Vellum**:
- **Cloud / Vercel Deployment (Recommended for Native Mobile):** Once signed into Folio via Supabase, open **Settings → Vellum Ebook Reader Link** to copy your **Folio URL** (`https://your-folio.vercel.app`) and your personal **Bridge Token** (`fbr_...`). Paste both into **Vellum → Folio Link** on your iPhone, iPad, or Android device. Reading progress (`On the lectern`), finished books, ratings, yearly challenge spines, and Reading Circle activity sync directly to your personal Supabase account—isolated from other friends on the same Folio site.
- **Local Desktop / LAN Mode:** When running Folio locally (`http://localhost:3000` or `http://192.168.x.x:3000`), Vellum can connect directly without a token (or with an optional `FOLIO_BRIDGE_TOKEN` in `.env.local`).

## Installing on Mobile

- **iOS (Safari):** Open your deployed URL and tap **Share -> Add to Home Screen** for a full-screen standalone app experience.
- **Android (Chrome):** Open your deployed URL and tap **Install app** from the browser menu.
