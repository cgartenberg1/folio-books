import { NextRequest, NextResponse } from 'next/server';
import {
  BatchBookEnrichInput,
  enrichBooksBatch,
  resolveAuthorsBatch,
} from '@/lib/bookProviders';

export async function POST(request: NextRequest) {
  const headerToken = request.headers.get('x-hardcover-token')?.trim();
  const hardcoverToken = headerToken || process.env.HARDCOVER_API_KEY?.trim();
  const googleApiKey = process.env.GOOGLE_BOOKS_API_KEY?.trim();

  try {
    const body = await request.json();
    const action = body?.action as 'books' | 'authors';

    if (action === 'authors') {
      const names: string[] = Array.isArray(body?.names)
        ? body.names.slice(0, 30)
        : [];
      const result = await resolveAuthorsBatch({
        names,
        hardcoverToken,
      });
      return NextResponse.json(result);
    }

    const items: BatchBookEnrichInput[] = Array.isArray(body?.items)
      ? body.items.slice(0, 60)
      : [];
    const result = await enrichBooksBatch({
      items,
      hardcoverToken,
      googleApiKey,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Batch enrichment failed',
        matches: {},
        authors: [],
      },
      { status: 500 }
    );
  }
}
