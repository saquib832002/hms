import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { accentFor, fillFor, headerBgFor, theme } from '@/lib/theme';
import { useAuth } from '@/lib/auth-context';
import { switchableRoles } from '@/lib/api';
import { landingFor, ROLE_LABEL } from '@/lib/nav';
import type { UserRole } from '@/lib/types';

/**
 * The shared visual language.
 *
 * Everything here exists so screens describe *what* they show rather than how
 * it is painted — a screen that reaches for a raw colour or a magic pixel value
 * is how six screens end up looking like six apps.
 */

/* ── layout ──────────────────────────────────────────────────────────────── */

/** Page scaffold. Sets the background and keeps content clear of the notch. */
export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

/**
 * The coloured header, tinted by the signed-in role.
 *
 * Two jobs. It gives the app a face — a white sheet with a small black heading
 * reads as unfinished no matter how correct it is. And it answers "which role
 * am I acting as" without anyone having to look for it, which matters because a
 * user can hold several and wear one at a time.
 */
export function AppHeader({
  title,
  subtitle,
  right,
  accent,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  /** Override the role tint — used by the login screen, which has no role. */
  accent?: string;
}) {
  const { user } = useAuth();
  const bg = headerBgFor(user?.role);
  const rule = accent ?? fillFor(user?.role);

  return (
    <View style={[s.header, { backgroundColor: bg, borderBottomColor: rule }]}>
      <SafeAreaView edges={['top']}>
        <View style={s.headerInner}>
          <View style={s.headerText}>
            <Text style={s.headerTitle} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={s.headerSubtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <RoleSwitcher />
          {right}
        </View>
      </SafeAreaView>
    </View>
  );
}

/**
 * The hat you are currently wearing, and how to change it.
 *
 * WHY IT IS IN THE HEADER RATHER THAN A SETTINGS SCREEN
 * -----------------------------------------------------
 * It was on the Account tab, behind a menu item labelled "Me", and it may as
 * well not have existed: an owner-doctor signed in, saw the queue, and had no
 * way of knowing the app could be anything else. The web app has never had this
 * problem because its switcher sits in the sidebar, visible on every screen all
 * day. A capability nobody can find is indistinguishable from one that was
 * never built.
 *
 * So it renders on every screen with a header — but only when there is a real
 * choice. Most staff hold one role, and a pill saying "Nurse" that does nothing
 * when tapped is noise on a small screen.
 *
 * SWITCHING NAVIGATES, AND THAT IS NOT COSMETIC
 * ---------------------------------------------
 * A doctor on the queue who becomes a pharmacist is standing on a screen that
 * calls `GET /me/queue`, which their new role cannot have. Leaving them there
 * produces a 403 and a denied clinical access in the hospital's audit log —
 * the same self-inflicted denial the web `?next=` bug caused. So the switch
 * lands on the new role's own screen.
 */
export function RoleSwitcher() {
  const { user, switchRole } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<UserRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const roles = switchableRoles(user);
  if (!user || roles.length < 2) return null;

  const tint = roleThemeTint(user.role);

  const choose = (role: UserRole) => {
    if (role === user.role) return setOpen(false);
    setBusy(role);
    setError(null);
    void switchRole(role)
      .then(() => {
        setOpen(false);
        router.replace(landingFor(role));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not switch role'))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          s.rolePill,
          { backgroundColor: tint.fill },
          pressed ? { opacity: 0.7 } : null,
        ]}
        accessibilityLabel={`Acting as ${ROLE_LABEL[user.role]}. Tap to switch role.`}
      >
        <Text style={[s.rolePillText, { color: tint.ink }]} numberOfLines={1}>
          {ROLE_LABEL[user.role]} ⌄
        </Text>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={s.sheetRoot}>
          <Pressable style={s.sheetBackdrop} onPress={() => setOpen(false)} />
          <View style={s.sheetCard}>
            <Text style={s.sheetTitle}>Acting as</Text>
            <Text style={s.sheetHint}>
              You hold {roles.length} roles and act as one at a time. Switching never combines
              them, and everything you do afterwards is recorded against the role you are wearing.
            </Text>

            <ScrollView style={s.sheetList}>
              {roles.map((role) => {
                const current = role === user.role;
                return (
                  <Pressable
                    key={role}
                    disabled={busy !== null}
                    onPress={() => choose(role)}
                    style={({ pressed }) => [
                      s.sheetOption,
                      current ? s.sheetOptionCurrent : null,
                      pressed ? { opacity: 0.6 } : null,
                    ]}
                  >
                    <View
                      style={[s.sheetSwatch, { backgroundColor: roleThemeTint(role).fill }]}
                    />
                    <Text style={s.sheetOptionLabel}>{ROLE_LABEL[role]}</Text>
                    {busy === role ? (
                      <ActivityIndicator size="small" />
                    ) : current ? (
                      <Text style={s.sheetOptionNote}>current</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>

            {error ? <Text style={s.sheetError}>{error}</Text> : null}

            <Button label="Close" variant="secondary" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

/** The role's fill and ink, without exporting the whole theme table. */
function roleThemeTint(role: UserRole): { fill: string; ink: string } {
  return { fill: fillFor(role), ink: theme.color.onAccent };
}

/** Small circle of initials. Cheap identity, no avatar hosting to maintain. */
export function Avatar({ name, onPress }: { name: string; onPress?: () => void }) {
  const { user } = useAuth();
  const accent = accentFor(user?.role);
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  const inner = (
    <View style={[s.avatar, { borderColor: accent }]}>
      <Text style={[s.avatarText, { color: accent }]} numberOfLines={1}>
        {initials || '?'}
      </Text>
    </View>
  );

  // Labelled with the person's name and what tapping it does. "DR" in a circle
  // is not self-explanatory, and a screen reader would otherwise announce two
  // letters with no context.
  return onPress ? (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name} — account and settings`}
    >
      {inner}
    </Pressable>
  ) : (
    inner
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionTitle}>{children}</Text>;
}

/* ── surfaces ────────────────────────────────────────────────────────────── */

export function Card({
  children,
  style,
  accent,
  onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  /** A left rule in a status colour — used to make one row shout. */
  accent?: string;
  onPress?: () => void;
}) {
  const body = (
    <View
      style={[s.card, accent ? { borderLeftWidth: 4, borderLeftColor: accent } : null, style]}
    >
      {children}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {({ pressed }) => <View style={{ opacity: pressed ? 0.75 : 1 }}>{body}</View>}
    </Pressable>
  );
}

/** A number worth glancing at. Three across the top of a queue. */
export function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

/**
 * A status chip.
 *
 * `flexShrink: 0` and `numberOfLines` are the load-bearing part, not the
 * colour. Without them a long label — "IN PROGRESS", "14D OVERDUE" — grew past
 * its share of the row and ran over the time or the patient name beside it.
 * React Native does not wrap or clip a `Text` in a row by default; it happily
 * overflows, so the constraint has to be stated.
 */
export function StatusPill({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <Text style={[s.pillText, { color: fg }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * A row with a title that yields and a chip that does not.
 *
 * Every card header in the app wants this and three of them got it slightly
 * wrong on their own, which is how the overlap appeared on one screen and not
 * the others.
 */
export function CardHeader({ children }: { children: React.ReactNode }) {
  return <View style={s.cardHeader}>{children}</View>;
}

/**
 * What a list says when it has nothing in it.
 *
 * An empty screen with no words is indistinguishable from a broken one, and
 * that ambiguity cost a receptionist a support call on the first device run.
 */
export function EmptyState({
  glyph = '◌',
  title,
  body,
}: {
  glyph?: string;
  title: string;
  body?: string;
}) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyGlyph}>{glyph}</Text>
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={s.error} accessibilityRole="alert">
      <Text style={s.errorGlyph}>⚠</Text>
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

/**
 * An error that cannot be scrolled away from.
 *
 * WHY THIS EXISTS
 * ---------------
 * On a long form the submit button is at the bottom and the error banner was at
 * the top, inside the same ScrollView. Tapping "Move appointment" and getting a
 * conflict did something invisible: the message rendered several screens above,
 * the view did not move, and the only feedback was the button un-dimming. The
 * user reasonably concluded the app had done nothing.
 *
 * Scrolling the view to the top on error was the other option, and it is worse
 * — it throws away the place someone was working and hides the control they
 * just pressed. Pinning the message near the action keeps both.
 *
 * `pointerEvents="box-none"` on the wrapper matters: without it this would sit
 * across the bottom of the screen swallowing taps meant for the form beneath.
 */
export function FloatingError({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) return null;

  return (
    <View style={s.floatingWrap} pointerEvents="box-none">
      <View style={[s.error, s.floatingError]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <Text style={s.errorGlyph}>⚠</Text>
        <Text style={s.errorText}>{message}</Text>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
          hitSlop={12}
        >
          <Text style={s.errorClose}>✕</Text>
        </Pressable>
      </View>
    </View>
  );
}

/* ── controls ────────────────────────────────────────────────────────────── */

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const { user } = useAuth();
  /*
   * Primary is the deep accent with white on it — around 4.7:1 for every role,
   * so it clears AA. A solid dark button also reads as the committed action in
   * a way a bright fill does not; the neon is better spent on the header rule
   * and the active tab, where it marks position rather than asking to be read
   * through.
   *
   * Secondary is the same accent as text on white, which is why the role table
   * keeps a darkened value separate from the neon one.
   */
  const accent = accentFor(user?.role);

  const palette = {
    primary: { bg: accent, fg: theme.color.onSolid, border: accent },
    secondary: { bg: theme.color.surface, fg: accent, border: theme.color.borderStrong },
    danger: { bg: theme.color.dangerSoft, fg: theme.color.dangerText, border: 'rgba(255,90,82,0.45)' },
    ghost: { bg: 'transparent', fg: theme.color.textMuted, border: 'transparent' },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      style={({ pressed }) => [
        s.button,
        size === 'sm' && s.buttonSm,
        variant !== 'ghost' && theme.elevation.card,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <Text style={[s.buttonLabel, size === 'sm' && s.buttonLabelSm, { color: palette.fg }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline,
  style,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: React.ComponentProps<typeof TextInput>['keyboardType'];
  autoCapitalize?: React.ComponentProps<typeof TextInput>['autoCapitalize'];
  multiline?: boolean;
  style?: TextStyle;
}) {
  return (
    <View style={s.field}>
      {label ? <Text style={s.fieldLabel}>{label}</Text> : null}
      <TextInput
        style={[s.input, multiline && s.inputMultiline, style]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textSubtle}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
      />
    </View>
  );
}

/* ── styles ──────────────────────────────────────────────────────────────── */

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },

  header: {
    borderBottomLeftRadius: theme.radius.lg,
    borderBottomRightRadius: theme.radius.lg,
    // A neon rule instead of a neon fill — the accent reads as a light source
    // rather than a wall of colour at arm's length.
    borderBottomWidth: 3,
    ...theme.elevation.raised,

    /*
     * Must out-stack the list beneath it, and this is not cosmetic.
     *
     * On Android `elevation` decides paint order, and siblings with the *same*
     * elevation fall back to tree order — so a FlatList declared after the
     * header painted over it. The visible symptom was the avatar half-hidden
     * behind the first card: a green circle with unreadable text in it.
     *
     * `zIndex` covers iOS, which ignores `elevation` entirely.
     */
    zIndex: 10,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(3),
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(1),
    paddingBottom: theme.space(4),
  },
  headerText: { flex: 1 },
  headerTitle: { ...theme.font.display, color: theme.color.text },
  headerSubtitle: { ...theme.font.small, color: theme.color.textMuted, marginTop: 1 },

  // Role switcher. `flexShrink: 0` and a max width so a long role name cannot
  // push the avatar off the header — the same collision the status pills hit.
  rolePill: {
    flexShrink: 0,
    maxWidth: 132,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
  },
  rolePillText: { ...theme.font.caption },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  sheetCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
    maxHeight: '80%',
  },
  sheetTitle: { ...theme.font.title, color: theme.color.text },
  sheetHint: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    lineHeight: 16,
    marginTop: theme.space(1),
  },
  sheetList: { marginTop: theme.space(3), marginBottom: theme.space(3) },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    marginBottom: theme.space(2),
  },
  sheetOptionCurrent: { backgroundColor: theme.color.surfaceSunken },
  sheetSwatch: { width: 12, height: 12, borderRadius: 6 },
  sheetOptionLabel: { ...theme.font.body, color: theme.color.text, flex: 1 },
  sheetOptionNote: { ...theme.font.caption, color: theme.color.textSubtle },
  sheetError: { ...theme.font.small, color: theme.color.danger, marginBottom: theme.space(2) },

  avatar: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    backgroundColor: theme.color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  avatarText: { ...theme.font.caption },

  sectionTitle: {
    ...theme.font.overline,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
    marginTop: theme.space(4),
    marginBottom: theme.space(2),
  },

  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3),
    ...theme.elevation.card,
  },

  stat: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space(3),
    alignItems: 'center',
    ...theme.elevation.card,
  },
  statValue: { ...theme.font.display, color: theme.color.text },
  statLabel: {
    ...theme.font.overline,
    color: theme.color.textSubtle,
    textTransform: 'uppercase',
    marginTop: 2,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space(2),
  },
  pill: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.space(2),
    paddingVertical: 3,
    // Never squeezed by a long neighbour, never allowed to squeeze one.
    flexShrink: 0,
    maxWidth: '55%',
  },
  pillText: { ...theme.font.overline },

  empty: {
    alignItems: 'center',
    paddingVertical: theme.space(10),
    paddingHorizontal: theme.space(6),
  },
  emptyGlyph: { fontSize: 26, color: theme.color.borderStrong, marginBottom: theme.space(2) },
  emptyTitle: { ...theme.font.heading, color: theme.color.textMuted, textAlign: 'center' },
  emptyBody: {
    ...theme.font.small,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(1),
  },

  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    backgroundColor: theme.color.dangerSoft,
    borderLeftWidth: 4,
    borderLeftColor: theme.color.danger,
    borderRadius: theme.radius.md,
    padding: theme.space(4),
    marginHorizontal: theme.space(4),
    marginTop: theme.space(3),
  },
  errorGlyph: { ...theme.font.title, color: theme.color.danger },
  errorText: { ...theme.font.small, color: theme.color.dangerText, flex: 1 },
  errorClose: { ...theme.font.title, color: theme.color.dangerText },

  floatingWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Above the form and above the tab bar's shadow, so it is never the thing
    // hidden behind something else.
    zIndex: 50,
  },
  floatingError: {
    marginBottom: theme.space(5),
    borderWidth: 1,
    borderColor: 'rgba(196,41,29,0.35)',
    ...theme.elevation.raised,
  },

  button: {
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space(4),
  },
  buttonSm: { minHeight: 38, paddingHorizontal: theme.space(3), borderRadius: theme.radius.sm },
  buttonLabel: { ...theme.font.bodyStrong },
  buttonLabelSm: { ...theme.font.caption },

  field: { gap: theme.space(1) },
  fieldLabel: { ...theme.font.caption, color: theme.color.textMuted },
  input: {
    minHeight: theme.touchTarget,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space(4),
    ...theme.font.input,
    color: theme.color.text,
  },
  inputMultiline: { minHeight: theme.touchTarget * 2, paddingTop: theme.space(3) },
});
