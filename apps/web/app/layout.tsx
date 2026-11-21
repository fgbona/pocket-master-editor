import type { Metadata, Viewport } from 'next';
import { Yellowtail } from 'next/font/google';
import './globals.css';
import { I18nProvider } from '@/components/I18n';
import { THEME_BOOT_SCRIPT } from '@/components/ThemeToggle';

/** The script lettering on the amp's faceplate; self-hosted by Next, so it works offline. */
const script = Yellowtail({ weight: '400', subsets: ['latin'], variable: '--font-script', display: 'swap' });

const DESCRIPTION = 'Free editor for the Sonicake Pocket Master, over USB or Bluetooth: edit live, save with a backup, install TONE3000 captures, or describe a tone and let a free AI build it.';

export const metadata: Metadata = {
  // Link previews need absolute URLs: the Pages workflow sets SITE_URL (the origin; Next adds the basePath).
  metadataBase: process.env.SITE_URL ? new URL(process.env.SITE_URL) : undefined,
  title: 'Pocket Master Editor',
  description: DESCRIPTION,
  openGraph: { title: 'Pocket Master Editor', description: DESCRIPTION, type: 'website' },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0b0d10' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d10' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={script.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {/* Shared paint servers: the chrome of every knob cap (referenced from CSS). */}
        <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
          <defs>
            <radialGradient id="knob-chrome" cx="38%" cy="32%" r="75%">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.35" stopColor="#c9ccd1" />
              <stop offset="0.75" stopColor="#7d8188" />
              <stop offset="1" stopColor="#3d4045" />
            </radialGradient>
          </defs>
        </svg>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
