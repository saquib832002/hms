import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Meridian HMS',
  description: 'Hospital Management System',
  // Internal operational tool — should never be indexed if it ever ends up
  // reachable from the public internet.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/*
       * suppressHydrationWarning covers attribute mismatches on <body> itself.
       *
       * Browser extensions — Grammarly, password managers, dark-mode tools —
       * inject attributes into <body> before React hydrates, which React then
       * reports as a hydration error pointing here. It is noise from the
       * developer's browser, not from the app, and it would otherwise appear on
       * every page load for anyone running one.
       *
       * WHAT THIS DOES NOT HIDE, which is why it is safe to set:
       * it applies only to this element's own attributes and direct text — it
       * does not propagate to children. Nothing in this codebase sets an
       * attribute on <body>, so there is no mismatch we could produce here for
       * it to swallow. A genuine hydration bug in any component still reports
       * normally.
       */}
      <body suppressHydrationWarning>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
