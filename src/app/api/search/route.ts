import { NextRequest, NextResponse } from 'next/server';
import { searchCatalog } from '@/lib/bookProviders';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() || '';
  const modeParam = searchParams.get('mode') || 'all';
  const mode =
    modeParam === 'authors' || modeParam === 'books' ? modeParam : 'all';

  if (query.length < 2) {
    return NextResponse.json({
      authors: [],
      books: [],
      providerUsed: 'google-fallback',
    });
  }

  const headerToken = request.headers.get('x-hardcover-token')?.trim();
  const hardcoverToken = headerToken || process.env.HARDCOVER_API_KEY?.trim();
  const googleApiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim();

  try {
    const result = await searchCatalog({
      query,
      mode,
      hardcoverToken,
      googleApiKey,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Search failed',
        authors: [],
        books: [],
      },
      { status: 500 }
    );
  }
}
