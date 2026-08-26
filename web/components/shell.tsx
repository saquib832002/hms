'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { navFor, ROLE_LABEL } from '@/lib/nav';
import { initials } from '@/lib/format';
import { cx } from './ui/primitives';
import { CommandPalette, useCommandPalette } from './command-palette';
import { RoleSwitcher } from '@/components/ui/role-switcher';

/**
 * Persistent sidebar, not a hamburger menu. Staff live in this app for
 * eight-hour shifts and need every section one click away.
 *
 * The nav is built from the role the *server* reported via GET /auth/me —
 * never from a role constant compiled into the client.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth();
  const pathname = usePathname();
  const palette = useCommandPalette();

  if (!user) return null;
  const items = navFor(user.role);

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[186px] shrink-0 flex-col border-r border-border bg-surface py-3">
        <div className="px-3.5 pb-3 text-md font-bold tracking-tight">
          Meridian<span className="text-primary">HMS</span>
        </div>

        <nav className="flex flex-col">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  'flex items-center gap-2 border-l-2 px-3.5 py-1.5 text-sm',
                  active
                    ? 'border-l-primary bg-primary-soft font-semibold text-primary'
                    : 'border-l-transparent text-text-muted hover:bg-bg',
                )}
              >
                <span className="w-3.5 text-center opacity-75">{item.icon}</span>
                <span className="truncate">{item.label}</span>
                {item.phase && (
                  <span className="ml-auto rounded-sm border border-border px-1 text-xxs text-text-subtle">
                    P{item.phase}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto">
          <RoleSwitcher />
        </div>

        <div className="border-t border-border px-3.5 pt-2.5">
          <div className="truncate text-sm font-medium">{user.fullName}</div>
          <div className="text-xs text-text-subtle">
            {ROLE_LABEL[user.role]}
            {user.hospital?.name ? ` · ${user.hospital.name}` : ''}
          </div>
          <button
            onClick={() => void signOut()}
            className="mt-1.5 text-xs text-text-muted underline-offset-2 hover:text-danger hover:underline"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <EnvBanner />
        <header className="flex h-[46px] shrink-0 items-center gap-3 border-b border-border bg-surface px-3.5">
          <PageTitle pathname={pathname} />
          <button
            onClick={palette.open}
            className="ml-auto flex min-w-[190px] items-center justify-between rounded-sm border border-border bg-bg px-2.5 py-1 text-xs text-text-subtle hover:border-border-strong"
          >
            <span>Search patients…</span>
            <kbd className="rounded-sm border border-border bg-surface px-1 font-mono text-xxs">
              ⌘K
            </kbd>
          </button>
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xxs font-bold text-white">
            {initials(user.fullName)}
          </div>
        </header>

        <main className="scroll-thin flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>

      <CommandPalette {...palette} />
    </div>
  );
}

/**
 * Dummy data must never be mistaken for real patient data. This stays until
 * the build is pointed at a BAA-covered environment.
 */
function EnvBanner() {
  if (process.env.NODE_ENV === 'production') return null;
  return (
    <div className="shrink-0 bg-[#4a2f6b] py-0.5 text-center text-xxs tracking-wide text-[#e9dcf7]">
      DEVELOPMENT — DUMMY DATA ONLY · NOT REAL PATIENT INFORMATION
    </div>
  );
}

const TITLES: Record<string, string> = {
  '/queue': "Today's Queue",
  '/check-in': 'Check-in Queue',
  '/appointments': 'Appointments',
  '/patients': 'Patients',
  '/patients/new': 'Register Patient',
  '/doctors': 'Doctors',
  '/audit': 'Audit Log',
  '/ward': 'Ward Board',
  '/vitals': 'Observations',
  '/medications': 'Medication Round',
  '/pharmacy/queue': 'Dispensing Queue',
  '/pharmacy/inventory': 'Inventory',
  '/billing/invoices': 'Invoices',
  '/billing/payments': 'Payments',
  '/admin': 'Administration',
  '/admin/users': 'Staff & Users',
  '/admin/departments': 'Departments',
};

function PageTitle({ pathname }: { pathname: string }) {
  return <h1 className="text-md font-semibold">{TITLES[pathname] ?? 'Meridian HMS'}</h1>;
}
