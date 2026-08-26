import { StyleSheet, Text, View } from 'react-native';
import { theme } from '@/lib/theme';
import { titleCase } from '@/lib/format';
import type { Allergy } from '@/lib/types';

/**
 * Same rule as web: `undefined` means the API sent no clinical data for this
 * role, `[]` means the role can see allergies and there are none. Those must
 * not collapse — "no known allergies" is an assertion the server never made
 * in the first case.
 *
 * On mobile this matters more, not less: the screen is small enough that a
 * clinician may only read the top of it.
 */
export function AllergyBanner({ allergies }: { allergies?: Allergy[] }) {
  if (allergies === undefined) return null;

  if (allergies.length === 0) {
    return (
      <View style={s.none}>
        <Text style={s.noneText}>No known allergies recorded</Text>
      </View>
    );
  }

  return (
    <View style={s.alert} accessibilityRole="alert">
      <Text style={s.alertTitle}>⚠ ALLERGY</Text>
      <Text style={s.alertBody}>
        {allergies.map((a) => `${a.substance} (${titleCase(a.severity)})`).join(' · ')}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  alert: {
    backgroundColor: theme.color.dangerSoft,
    borderWidth: 1,
    borderColor: '#f2c4be',
    borderLeftWidth: 4,
    borderLeftColor: theme.color.danger,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  alertTitle: { color: '#8a2a1f', fontWeight: '800', fontSize: 12, letterSpacing: 0.5 },
  alertBody: { color: '#8a2a1f', fontWeight: '700', fontSize: 15, marginTop: 2 },
  none: {
    backgroundColor: theme.color.bg,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(2),
    marginBottom: theme.space(2),
  },
  noneText: { color: theme.color.textMuted, fontSize: 13 },
});
