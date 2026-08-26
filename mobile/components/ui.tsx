import { ActivityIndicator, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { theme } from '@/lib/theme';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}) {
  const palette = {
    primary: { bg: theme.color.primary, fg: '#fff', border: theme.color.primary },
    secondary: { bg: theme.color.surface, fg: theme.color.primary, border: theme.color.primary },
    danger: { bg: theme.color.surface, fg: theme.color.danger, border: theme.color.borderStrong },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: palette.bg, borderColor: palette.border, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <Text style={[s.buttonLabel, { color: palette.fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function StatusPill({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <Text style={[s.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={s.error} accessibilityRole="alert">
      <Text style={s.errorText}>{message}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  button: {
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space(4),
  },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  pill: { borderRadius: 999, paddingHorizontal: theme.space(2), paddingVertical: 2 },
  pillText: { fontSize: 11, fontWeight: '700' },
  error: {
    backgroundColor: theme.color.dangerSoft,
    borderColor: '#f2c4be',
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    margin: theme.space(3),
  },
  errorText: { color: '#8a2a1f', fontSize: 14 },
});
