import type { Metadata, Viewport } from 'next';
import { Cormorant_Garamond, EB_Garamond, Instrument_Sans } from 'next/font/google';
import './globals.css';

const displayFace = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

const textFace = EB_Garamond({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-text',
  display: 'swap',
});

const uiFace = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Folio · A Ledger of Books Forthcoming & Read',
  description:
    'Track upcoming book releases by week from authors you follow, browse released titles, manage your reading list, and keep a yearly reading challenge.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Folio',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F2E9' },
    { media: '(prefers-color-scheme: dark)', color: '#171411' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${displayFace.variable} ${textFace.variable} ${uiFace.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
