import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    hasServerHardcoverKey: Boolean(process.env.HARDCOVER_API_KEY?.trim()),
    hasServerGoogleKey: Boolean(process.env.GOOGLE_BOOKS_API_KEY?.trim()),
    hasServerSupabase: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
    ),
    hasBridgeTokenEnv: Boolean(process.env.FOLIO_BRIDGE_TOKEN?.trim()),
    isHostedCloud: Boolean(
      process.env.VERCEL ||
        process.env.NETLIFY ||
        process.env.RAILWAY_ENVIRONMENT ||
        process.env.FLY_APP_NAME
    ),
  });
}
