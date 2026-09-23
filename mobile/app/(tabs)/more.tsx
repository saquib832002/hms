import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/lib/auth-context';
import { theme } from '@/lib/theme';
import { AppHeader, Card, Screen } from '@/components/ui';
import { ALL_MODULES, MODULE_LABEL } from '@/lib/nav';
import type { TenantModule, UserRole } from '@/lib/types';

/**
 * Everything an administrator can reach that will not fit in a tab bar.
 *
 * WHY A HUB AND NOT MORE TABS
 * ---------------------------
 * The web gives ADMIN sixteen menu items. A phone tab bar holds five before the
 * labels stop being readable, so the choice was never "tabs or a hub" — it was
 * "a hub, or admin keeps one screen out of sixteen". It kept one screen, which
 * is what was reported: an owner signed in on the phone, saw Overview, and had
 * no way to reach staff, settings, departments, the audit log or anything else.
 *
 * SORTED BY WHAT THE HOSPITAL ACTUALLY HAS
 * ----------------------------------------
 * Every entry declares the module it needs, exactly as `web/lib/nav.ts` does,
 * so a laboratory-only tenant is not offered Partner Pharmacies and a clinic
 * with no lab is not offered Lab Tests. A menu of things that cannot work is
 * the failure the module system exists to prevent, and a hub is the easiest
 * place in the app to reintroduce it.
 *
 * WHAT IS NOT LISTED
 * ------------------
 * Screens that do not exist on the phone yet are absent rather than shown
 * disabled. A row that acknowledges a feature and refuses to open it tells the
 * user nothing they can act on — the same reason this project stopped writing
 * "this is on the web app" into screens. `screen-parity.spec.ts` holds the list
 * of what is still missing, so it stays visible to us instead.
 */
interface Destination {
  label: string;
  hint: string;
  href: string;
  /** What the hospital must have been sold for this to be worth showing. */
  module?: TenantModule;
  /**
   * Who may open it. Defaults to ADMIN alone, because that is what this hub
   * was built for and widening it by accident would put staff accounts and
   * the audit log in front of a billing clerk.
   */
  roles?: UserRole[];
}

const DESTINATIONS: Destination[] = [
  {
    label: 'Daily activity',
    hint: 'Who worked, how much they did, and what was taken',
    href: '/reports/activity',
  },
  { label: 'Staff roles', hint: 'Who may act as what', href: '/settings/staff' },
  {
    label: 'Clinic settings',
    hint: 'Timezone, currency, opening hours and your code',
    href: '/settings/clinic',
  },
  {
    label: 'Departments',
    hint: 'The departments doctors belong to',
    href: '/settings/departments',
    module: 'CLINIC',
  },
  {
    label: 'Partner labs',
    hint: 'Laboratories you may send work to',
    href: '/settings/lab-partners',
    module: 'LABORATORY',
  },
  {
    label: 'Partner lab bills',
    hint: 'What we owe labs we sent work to',
    href: '/lab-charges',
    module: 'LABORATORY',
    // The one destination here a billing clerk has any business opening.
    roles: ['ADMIN', 'BILLING_STAFF'],
  },
  {
    label: 'Audit log',
    hint: 'Who did what, and who was refused',
    href: '/reports/audit',
  },
];

export default function MoreScreen() {
  const { user } = useAuth();

  /*
   * Defaults to permitted while the session resolves, so nothing appears and
   * then vanishes as the user loads — the same rule the tab layout uses.
   */
  const has = (m?: TenantModule) => !m || (user?.hospital?.modules?.includes(m) ?? true);
  const available = DESTINATIONS.filter(
    (d) => has(d.module) && (d.roles ?? ['ADMIN']).includes(user?.role as UserRole),
  );

  /*
   * What the hospital was not sold, named where the gap is seen.
   *
   * A gated row simply vanishes, and an absence explains nothing — a module
   * removed this morning and one never bought look identical from inside.
   * Reported by an administrator who found Partner labs gone and had no way to
   * tell whether the product had broken or the plan had changed.
   *
   * `undefined` means the session carried no module list at all, which is a
   * stale build rather than a narrow plan; everything else fails open there,
   * so nothing is claimed to be missing either.
   */
  const modules = user?.hospital?.modules;
  const missing = modules ? ALL_MODULES.filter((m) => !modules.includes(m)) : [];

  return (
    <Screen>
      <AppHeader title="More" subtitle="Administration" />

      <ScrollView contentContainerStyle={s.body}>
        {available.map((d) => (
          <Pressable key={d.href} onPress={() => router.push(d.href as never)}>
            <Card>
              <View style={s.row}>
                <View style={s.grow}>
                  <Text style={s.label}>{d.label}</Text>
                  <Text style={s.hint}>{d.hint}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </View>
            </Card>
          </Pressable>
        ))}

        {/*
          Said once, here, rather than as a disabled row against each missing
          screen. An administrator who has just failed to find the audit log
          needs to know where it is, not to be told sixteen times that the
          phone is not the desk.
        */}
        {missing.length > 0 && (
          <Text style={s.footnote}>
            Not in your plan: {missing.map((m) => MODULE_LABEL[m]).join(', ')}. Those screens are
            hidden, not deleted — ask your provider to enable them and everything recorded under
            them comes back.
          </Text>
        )}

        <Text style={s.footnote}>
          Reports, wards and beds, the letterhead, tax rates and partner pharmacies are on the web
          app. They are configuration a hospital sets once, with figures or a licence to hand.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(4), gap: theme.space(3) },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space(2) },
  grow: { flex: 1 },
  label: { ...theme.font.body, fontWeight: '700', color: theme.color.text },
  hint: { ...theme.font.caption, color: theme.color.textMuted },
  chevron: { ...theme.font.display, color: theme.color.textSubtle },
  footnote: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: theme.space(2) },
});
