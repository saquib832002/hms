/**
 * Mobile tokens. Same semantic palette as web (docs/ui-design.md §2), but the
 * type scale is bigger and touch targets are large.
 *
 * The web app is dense on purpose — staff scan it at a desk all day. Mobile is
 * the opposite context: read at arm's length, one-handed, often in a corridor,
 * sometimes with gloves on. Reusing the 13px body would be a copy-paste of the
 * tokens rather than of the reasoning behind them.
 */
export const theme = {
  color: {
    bg: '#f7f8fa',
    surface: '#ffffff',
    border: '#e3e6ea',
    borderStrong: '#cfd4da',
    text: '#14181d',
    textMuted: '#5b6672',
    textSubtle: '#8a939e',
    primary: '#1e6fd9',
    primarySoft: '#e8f1fd',
    success: '#1a7f47',
    successSoft: '#e6f4ec',
    warning: '#b06f00',
    warningSoft: '#fdf3e2',
    danger: '#c0392b',
    dangerSoft: '#fdecea',
  },
  radius: { sm: 6, md: 10 },
  space: (n: number) => n * 4,
  /** 44pt minimum — gloves, hurry, motion. */
  touchTarget: 44,
} as const;

export const statusLabel: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CHECKED_IN: 'Waiting',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Done',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

export function statusColors(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'CHECKED_IN':
      return { bg: theme.color.warningSoft, fg: theme.color.warning };
    case 'IN_PROGRESS':
      return { bg: theme.color.dangerSoft, fg: theme.color.danger };
    case 'COMPLETED':
      return { bg: theme.color.successSoft, fg: theme.color.success };
    case 'SCHEDULED':
      return { bg: theme.color.primarySoft, fg: theme.color.primary };
    default:
      return { bg: '#eef0f2', fg: theme.color.textMuted };
  }
}
