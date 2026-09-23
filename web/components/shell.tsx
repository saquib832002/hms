'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import type { AuthUser } from '@/lib/types';
import { ALL_MODULES, MODULE_LABEL, navFor, ROLE_LABEL } from '@/lib/nav';
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
  const items = navFor(user.role, user.hospital.modules);

  /*
   * What the hospital was not sold.
   *
   * `undefined` means the session did not carry a module list, which is a
   * stale build rather than a narrow plan — everything downstream deliberately
   * fails open there, so nothing is claimed to be missing either.
   */
  const modules = user.hospital.modules;
  const missing = modules ? ALL_MODULES.filter((m) => !modules.includes(m)) : [];

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[186px] shrink-0 flex-col border-r border-border bg-surface py-3">
        {/*
          The hospital, in the most prominent position on every screen.

          This said "MeridianHMS" — the demo seed's name, hard-coded into the
          chrome of a multi-tenant product, so every hospital on the platform
          looked at somebody else's brand all day. Exactly the mistake the
          prescription renderer made when it printed `<h1>Meridian Hospital</h1>`
          on every tenant's documents, one layer less severe only because
          nobody carries a sidebar to a pharmacy.

          It is a safety control as much as branding. One email address can
          exist at more than one hospital — that is why login takes a hospital
          — so being signed into the wrong tenant is reachable, and the cost is
          a record written into another hospital's books rather than mere
          confusion.

          The name is not truncated to two lines: a long hospital name matters
          more than a tidy sidebar, and it is the thing being asserted.
        */}
        <div className="px-3.5 pb-3">
          <div className="text-md font-bold leading-tight tracking-tight">
            {user.hospital?.name ?? 'Hospital'}
          </div>
          {/* The code support asks for, and what another hospital needs to send
              here. Shown quietly rather than hidden in settings. */}
          {user.hospital?.slug && (
            <div className="font-mono text-xxs text-text-subtle">{user.hospital.slug}</div>
          )}
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

          {/*
            Why a screen is not here.
            -------------------------
            A menu item gated on a module simply *vanishes*, and an absence
            explains nothing: a module removed this morning and one never
            bought look identical from inside, because the 403 that names it
            only arrives if somebody finds a way to attempt a write. Reported
            as "a lot of options have gone — partner labs, partner pharmacies"
            by an administrator who had no way to tell whether the product had
            broken or the plan had changed.

            So the missing part of the plan is named where the gap is seen,
            rather than only on a settings page nobody thinks to open. Shown to
            every role, not just ADMIN — a receptionist who cannot find the
            appointment book is the person most confused by its absence and the
            least likely to guess why.

            Nothing has been deleted, and it says so: the records under a
            module that is off come back with it, which is what makes refusing
            the read defensible rather than destructive.
          */}
          {missing.length > 0 && (
            <div className="mx-3.5 mt-3 border-t border-border pt-2.5 text-xxs leading-4 text-text-subtle">
              Not in your plan:{' '}
              <span className="text-text-muted">
                {missing.map((m) => MODULE_LABEL[m]).join(', ')}
              </span>
              . Those screens are hidden, not deleted — ask your provider to enable them and
              everything recorded under them comes back.
            </div>
          )}
        </nav>

        <div className="mt-auto">
          <RoleSwitcher />
        </div>

        <div className="border-t border-border px-3.5 pt-2.5">
          <div className="truncate text-sm font-medium">{user.fullName}</div>
          {/* Just the role now — the hospital moved to the top, where it is
              read rather than skimmed past above a Sign out button. */}
          <div className="text-xs text-text-subtle">{ROLE_LABEL[user.role]}</div>
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
        <SubscriptionBanner user={user} />
        <header className="flex h-[46px] shrink-0 items-center gap-3 border-b border-border bg-surface px-3.5">
          <PageTitle pathname={pathname} hospital={user.hospital?.name ?? 'Hospital'} />
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

function PageTitle({ pathname, hospital }: { pathname: string; hospital: string }) {
  /*
   * The hospital is the fallback, not a product name.
   *
   * `TITLES` covers the mapped routes and every other screen fell through to
   * the demo seed's name — so the top bar of anything not in that list showed a
   * customer somebody else's brand. The same leak as the sidebar, one line
   * lower and easier to miss because it only appeared on the unmapped screens.
   */
  return <h1 className="text-md font-semibold">{TITLES[pathname] ?? hospital}</h1>;
}

/**
 * Tells the hospital before anything stops working, and explains it after.
 *
 * WHY THIS IS NOT A MODAL
 * -----------------------
 * A blocking dialog on every screen would make a commercial matter interrupt
 * clinical work, which is the thing this whole design refuses. A strip at the
 * top is impossible to miss and impossible to be trapped by.
 *
 * WHY EVERY ROLE SEES IT, NOT JUST ADMIN
 * --------------------------------------
 * The person who meets the refusal is a receptionist trying to check somebody
 * in, and a 403 with no context reads as the app being broken. Naming the
 * reason turns a mysterious failure into one sentence they can repeat to
 * whoever handles it. The amount owed is deliberately absent — that is between
 * the provider and whoever signed, not something to put on a clerk's screen.
 */
function SubscriptionBanner({ user }: { user: AuthUser }) {
  const status = user.hospital?.subscriptionStatus;
  const endsAt = user.hospital?.subscriptionEndsAt ?? null;
  if (!status) return null;

  const restricted = status === 'SUSPENDED' || status === 'CANCELLED';
  const expired = !restricted && endsAt !== null && new Date(endsAt).getTime() <= Date.now();

  if (restricted || expired) {
    return (
      <div className="shrink-0 border-b border-danger bg-danger-soft px-3.5 py-1.5 text-xs text-danger">
        <strong>Read-only.</strong> This hospital&rsquo;s subscription has lapsed, so new entries
        cannot be saved. Everything already recorded stays fully visible. An administrator should
        contact the provider.
      </div>
    );
  }

  // A fortnight's notice. Being surprised by a restriction is most of the harm
  // here, and warning early removes it.
  const daysLeft =
    endsAt === null ? null : Math.floor((new Date(endsAt).getTime() - Date.now()) / 86_400_000);

  if (status === 'PAST_DUE' || (daysLeft !== null && daysLeft <= 14)) {
    return (
      <div className="shrink-0 border-b border-warning bg-warning-soft px-3.5 py-1.5 text-xs text-[#6b5314]">
        {status === 'PAST_DUE'
          ? 'A payment for this hospital is overdue. Nothing has stopped working yet.'
          : `This hospital’s subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. After that, records stay readable but nothing new can be saved.`}
      </div>
    );
  }

  return null;
}
