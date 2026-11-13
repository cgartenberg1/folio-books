import { NextRequest, NextResponse } from 'next/server';
import { fetchAuthorBibliography } from '@/lib/bookProviders';
import { DataSource } from '@/types/books';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const authorId = searchParams.get('authorId')?.trim() || '';
  const authorName = searchParams.get('name')?.trim() || '';
  const source = (searchParams.get('source')?.trim() || 'google') as DataSource;
  const externalId = searchParams.get('externalId')?.trim() || undefined;
  const forceRefresh = searchParams.get('refresh') === '1';

  if (!authorId || !authorName) {
    return NextResponse.json(
      { error: 'Missing authorId or author name', books: [] },
      { status: 400 }
    );
  }

  const headerToken = request.headers.get('x-hardcover-token')?.trim();
  const hardcoverToken = headerToken || process.env.HARDCOVER_API_KEY?.trim();
  const googleApiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim();

  try {
    const result = await fetchAuthorBibliography({
      authorId,
      authorName,
      source,
      externalId,
      hardcoverToken,
      googleApiKey,
      forceRefresh,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Bibliography fetch failed',
        books: [],
      },
      { status: 500 }
    );
  }
}
