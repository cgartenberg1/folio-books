import { NextRequest, NextResponse } from 'next/server';
import { fetchBookCoverCandidates } from '@/lib/bookProviders';
import { DataSource } from '@/types/books';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title')?.trim() || '';
  const authorName = searchParams.get('author')?.trim() || '';
  const isbn = searchParams.get('isbn')?.trim() || undefined;
  const externalId = searchParams.get('externalId')?.trim() || undefined;
  const source = (searchParams.get('source')?.trim() || undefined) as
    | DataSource
    | undefined;

  if (!title) {
    return NextResponse.json(
      { error: 'Missing book title', covers: [] },
      { status: 400 }
    );
  }

  const headerToken = request.headers.get('x-hardcover-token')?.trim();
  const hardcoverToken = headerToken || process.env.HARDCOVER_API_KEY?.trim();
  const googleApiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim();

  try {
    const covers = await fetchBookCoverCandidates({
      title,
      authorName,
      isbn,
      externalId,
      source,
      hardcoverToken,
      googleApiKey,
    });
    return NextResponse.json({ covers });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load cover options',
        covers: [],
      },
      { status: 500 }
    );
  }
}
