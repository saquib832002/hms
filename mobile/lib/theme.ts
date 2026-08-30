import type { UserRole } from './types';

/**
 * Design tokens — light surface, neon accents.
 *
 * HOW NEON IS MADE TO WORK ON A LIGHT BACKGROUND
 * ----------------------------------------------
 * Neon green is a *light* colour: `#39FF14` on white is about 1.4:1, far below
 * the 4.5:1 text needs. So it is never used as text on white, and never as a
 * fill under white text.
 *
 * It is used the two ways that do work:
 *   - as a **fill with near-black text on it** — `#4AF03C` under `#08260C` is
 *     roughly 13:1, and it looks properly electric;
 *   - as a **pale tint** for the header and tab bar, where a wash of neon green
 *     gives the app its colour without asking anything of legibility.
 *
 * Where the accent has to be text on white — a link, an active label — a
 * darkened member of the same hue is used instead. Hence four values per role
 * rather than one: `fill`, `ink` (what sits on it), `text`, and the pale
 * `header` wash.
 *
 * TYPE IS SMALL ON PURPOSE
 * ------------------------
 * This is a data-dense operational tool. A queue of twenty patients should fit
 * on a screen, not four of them at poster size. The scale below is close to the
 * web app's, stepped up slightly for arm's length.
 */

const neutral = {
  bg: '#F3F6F4',
  surface: '#FFFFFF',
  sunken: '#EDF1EE',
  border: '#E1E7E3',
  borderStrong: '#CBD4CE',
  text: '#111A14',
  textMuted: '#586158',
  textSubtle: '#87918A',
} as const;

interface RoleTheme {
  /** Saturated fill for primary buttons and active chips. */
  fill: string;
  /** Text drawn *on* `fill`. Near-black, because the fills are all light. */
  ink: string;
  /** The accent as text on a white surface — darkened to stay readable. */
  text: string;
  /** Pale wash for the header and tab bar. */
  header: string;
}

/**
 * One hue per role, in four values.
 *
 * A user can hold several roles and act as one at a time, so "which hat am I
 * wearing" has to be answerable at a glance — the header colour answers it
 * before anyone reads a word.
 */
export const ROLE_THEME: Record<UserRole, RoleTheme> = {
  DOCTOR: { fill: '#4AF03C', ink: '#08260C', text: '#0B8A2B', header: '#DEFFE3' },
  RECEPTIONIST: { fill: '#3DEFC0', ink: '#062A22', text: '#03876C', header: '#D8FBF2' },
  NURSE: { fill: '#4BDCFF', ink: '#052733', text: '#0277A0', header: '#DAF4FF' },
  PHARMACIST: { fill: '#B98BFF', ink: '#1C0B38', text: '#6B35C9', header: '#EDE4FF' },
  BILLING_STAFF: { fill: '#FFC540', ink: '#2B1D00', text: '#8F6200', header: '#FFF2D6' },
  ADMIN: { fill: '#FF7FB0', ink: '#33061A', text: '#C21D5E', header: '#FFE2EC' },
};

const DEFAULT_ROLE: RoleTheme = ROLE_THEME.DOCTOR;

export const theme = {
  color: {
    bg: neutral.bg,
    surface: neutral.surface,
    surfaceSunken: neutral.sunken,
    border: neutral.border,
    borderStrong: neutral.borderStrong,

    text: neutral.text,
    textMuted: neutral.textMuted,
    textSubtle: neutral.textSubtle,

    /** Text on a pale accent tint. */
    onAccent: DEFAULT_ROLE.ink,
    onAccentMuted: 'rgba(17,26,20,0.62)',

    /** Text on a saturated dark accent — buttons. */
    onSolid: '#FFFFFF',

    /**
     * The medical cross.
     *
     * Deep red rather than the app's green: the cross is a universal hospital
     * mark and reads as one instantly. It is deliberately *not* the same red as
     * `danger` — a brand mark and an error state should never be confusable,
     * and this one is darker and less orange so the two never sit at the same
     * visual pitch.
     */
    cross: '#A4161A',

    primary: DEFAULT_ROLE.text,
    primaryDark: '#076B20',
    primarySoft: DEFAULT_ROLE.header,

    success: '#0B8A2B',
    successSoft: '#DEFFE3',
    warning: '#9A6A00',
    warningSoft: '#FFF2D6',
    danger: '#C4291D',
    dangerSoft: '#FDE7E4',
    dangerText: '#94211A',

    info: '#0277A0',
    infoSoft: '#DAF4FF',

    slateBar: '#2B332D',
  },

  /**
   * `input` sits one step above `body` — typing wants a little more weight than
   * reading — but no further.
   *
   * It was pinned at 16 on the grounds that iOS zooms the viewport when a field
   * under 16px takes focus. That is true of **mobile Safari**, not of React
   * Native: there is no viewport here to zoom. A web rule was applied to a
   * native app, and the only thing it bought was a placeholder noticeably
   * larger than every other word on the screen.
   */
  font: {
    hero: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.5 },
    display: { fontSize: 19, fontWeight: '800' as const, letterSpacing: -0.3 },
    title: { fontSize: 16, fontWeight: '700' as const, letterSpacing: -0.2 },
    heading: { fontSize: 14, fontWeight: '700' as const },
    body: { fontSize: 13, fontWeight: '500' as const },
    bodyStrong: { fontSize: 13, fontWeight: '700' as const },
    input: { fontSize: 14, fontWeight: '500' as const },
    small: { fontSize: 12, fontWeight: '500' as const },
    caption: { fontSize: 11, fontWeight: '600' as const },
    overline: { fontSize: 9, fontWeight: '800' as const, letterSpacing: 0.5 },
  },

  radius: { sm: 8, md: 12, lg: 16, xl: 22, full: 999 },

  space: (n: number) => n * 4,

  elevation: {
    card: {
      shadowColor: '#0A140C',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 2,
    },
    raised: {
      shadowColor: '#0A140C',
      shadowOpacity: 0.1,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
  },

  touchTarget: 44,
} as const;

export function roleTheme(role: UserRole | undefined): RoleTheme {
  return role ? ROLE_THEME[role] : DEFAULT_ROLE;
}

/** The accent as *text* — safe on a white surface. */
export function accentFor(role: UserRole | undefined): string {
  return roleTheme(role).text;
}

/** The saturated fill, for buttons and active states. Pair with `inkFor`. */
export function fillFor(role: UserRole | undefined): string {
  return roleTheme(role).fill;
}

export function inkFor(role: UserRole | undefined): string {
  return roleTheme(role).ink;
}

/** The pale wash behind the header and tab bar. */
export function headerBgFor(role: UserRole | undefined): string {
  return roleTheme(role).header;
}

export const statusLabel: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CHECKED_IN: 'Waiting',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Done',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

/**
 * Status → colour. Never decorative: each state owns a hue and nothing else
 * borrows it. In-progress stays the loudest row on a queue — it is the one
 * saying "you are with this patient right now".
 */
export function statusColors(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'CHECKED_IN':
      return { bg: theme.color.warningSoft, fg: theme.color.warning };
    case 'IN_PROGRESS':
      return { bg: theme.color.dangerSoft, fg: theme.color.danger };
    case 'COMPLETED':
      return { bg: theme.color.successSoft, fg: theme.color.success };
    case 'SCHEDULED':
      return { bg: theme.color.infoSoft, fg: theme.color.info };
    default:
      return { bg: theme.color.surfaceSunken, fg: theme.color.textMuted };
  }
}
