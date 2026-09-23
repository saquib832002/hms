import { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useLiveData } from '@/lib/use-live-data';
import { theme } from '@/lib/theme';
import { Button, Card, ErrorBanner, Field, Screen } from '@/components/ui';
import type { StaffUser, UserRole } from '@/lib/types';
import { assignableRoles, ROLE_LABEL } from '@/lib/nav';

/**
 * Who may act as what.
 *
 * THE CASE THIS EXISTS FOR
 * ------------------------
 * In a small hospital the owner is often also the treating doctor. Two accounts
 * for one human is the alternative, and it breaks the audit trail — "what did
 * Dr Smith do today" cannot be answered when two logins are the same person.
 *
 * So a user holds several roles and acts as exactly ONE, switching explicitly
 * from the Account tab. This screen decides what they may switch *to*; it does
 * not decide what they can do at once. That distinction has to be on the
 * screen, because "give them admin and doctor" sounds like it should merge the
 * two menus — and merging them is precisely what would hand a management
 * account clinical access and retire minimum-necessary.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ----------------------------
 * Assigning roles and choosing the sign-in role. Creating an account with a
 * temporary password, resetting one, and deactivating a person stay on the web:
 * those need a password read out or typed somewhere, which is not a one-handed
 * task, and getting them wrong locks a member of staff out mid-shift.
 *
 * `PATCH /users/:id/roles` is `@Roles(ADMIN)` and audited as `USER_SET_ROLES`
 * regardless of what this screen shows. This is the affordance, not the
 * boundary.
 */

/*
 * Derived and then narrowed to the hospital's modules — see the note on
 * `ROLE_LABEL` in `lib/nav.ts`. Never retyped: the hand-written version of this
 * array omitted LAB_TECHNICIAN, so the role could not be granted from the phone
 * either. Offering one whose module the tenant lacks is the same failure from
 * the other end — an account that signs in and reaches nothing.
 */



export default function StaffScreen() {
  const { user: me } = useAuth();
  const [staff, setStaff] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffUser | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ data: StaffUser[] }>('/users');
      setStaff(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load staff');
      setStaff([]);
    }
  }, []);

  useLiveData(load);

  return (
    <Screen>
      {error && <ErrorBanner message={error} />}

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
      >
        <Text style={s.intro}>
          A person can hold several roles and acts as one at a time. Holding two never combines
          their access.
        </Text>

        {(staff ?? []).map((u) => (
          <Pressable
            key={u.id}
            onPress={() => setEditing(u)}
            style={({ pressed }) => [pressed ? s.pressed : null]}
          >
            <Card style={s.card}>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name} numberOfLines={1}>
                    {u.fullName}
                    {u.id === me?.userId ? ' (you)' : ''}
                  </Text>
                  <Text style={s.email} numberOfLines={1}>
                    {u.email}
                  </Text>
                </View>
                {!u.isActive && (
                  <View style={s.inactive}>
                    <Text style={s.inactiveText}>Inactive</Text>
                  </View>
                )}
              </View>

              <View style={s.badges}>
                {u.roles.map((r) => (
                  <View key={r} style={[s.badge, r === u.role ? s.badgeDefault : null]}>
                    <Text style={[s.badgeText, r === u.role ? s.badgeDefaultText : null]}>
                      {ROLE_LABEL[r] ?? r}
                      {r === u.role ? ' · signs in' : ''}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          </Pressable>
        ))}

        {staff?.length === 0 && !error && <Text style={s.intro}>No staff accounts yet.</Text>}

        <Text style={s.footnote}>
          Creating accounts, resetting passwords and deactivating staff are on the web app.
        </Text>
      </ScrollView>

      {editing && (
        <RolesSheet
          offerable={assignableRoles(me?.hospital.modules)}
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </Screen>
  );
}

/* ─────────────────────────────── sheet ─────────────────────────────── */

function RolesSheet({
  offerable,
  user,
  onClose,
  onSaved,
}: {
  /** The roles this hospital may grant at all — narrowed to its modules. */
  offerable: UserRole[];

  user: StaffUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roles, setRoles] = useState<UserRole[]>(user.roles);
  const [signInAs, setSignInAs] = useState<UserRole>(user.role);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The clinical half, asked for only when it is needed.
   *
   * DOCTOR cannot be granted to somebody with no `Doctor` profile —
   * appointments key on `Doctor.id`, so a doctor without one cannot be booked.
   * Until this existed, the only way to create that profile was to create a
   * whole new account, which forced the owner of a clinic who also treats
   * patients to hold two logins for one human. That is exactly the split
   * multi-role exists to prevent, and it breaks "what did Dr Smith do today".
   */
  const [specialization, setSpecialization] = useState('');
  const [registrationNo, setRegistrationNo] = useState('');

  function toggle(role: UserRole) {
    setError(null);
    const next = roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role];
    setRoles(next);
    /*
     * The sign-in role must stay inside the set. The server repoints it anyway
     * if the default is removed, but silently — and an admin who unticked
     * "Doctor" would not expect the person's landing screen to move without
     * being told. Choosing here means they see it happen.
     */
    if (!next.includes(signInAs) && next.length > 0) setSignInAs(next[0]);
  }

  const rolesChanged =
    roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));
  const defaultChanged = signInAs !== user.role;
  const changed = rolesChanged || defaultChanged;

  /** Doctor ticked for somebody who is not yet bookable. */
  const needsProfile = roles.includes('DOCTOR') && user.doctor === null;
  const profileReady = !needsProfile || specialization.trim().length >= 2;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      /*
       * Profile, then roles, then the default. The order is forced: the server
       * refuses DOCTOR without a profile, and refuses a sign-in role the person
       * does not hold.
       */
      if (needsProfile) {
        await api(`/users/${user.id}/doctor-profile`, {
          method: 'POST',
          body: {
            specialization: specialization.trim(),
            registrationNo: registrationNo.trim() || undefined,
          },
        });
      }

      // Roles next. Making a newly-granted role the sign-in role would be
      // refused if the default were set before the grant landed.
      if (rolesChanged) {
        await api(`/users/${user.id}/roles`, { method: 'PATCH', body: { roles } });
      }
      if (defaultChanged) {
        await api(`/users/${user.id}`, { method: 'PATCH', body: { role: signInAs } });
      }
      onSaved();
    } catch (e) {
      /*
       * The server explains why, and its reasons are the interesting ones: the
       * last administrator, a doctor with no clinical profile, an empty set.
       * Note the last-admin check counts who *holds* ADMIN, not whose default
       * is ADMIN — an owner who signs in as a doctor still administers the
       * hospital.
       */
      setError(e instanceof Error ? e.message : 'Could not save roles');
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.modalRoot}>
        <Pressable style={s.modalBackdrop} onPress={onClose} />
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>{user.fullName}</Text>
          <Text style={s.modalHint}>
            Choose every role this person may act as. They switch between them from their own
            Account tab — holding two roles never combines their access.
          </Text>

          <ScrollView style={s.optionList} keyboardShouldPersistTaps="handled">
            {offerable.map((role) => {
              const on = roles.includes(role);
              return (
                <Pressable
                  key={role}
                  disabled={busy}
                  onPress={() => toggle(role)}
                  style={({ pressed }) => [
                    s.option,
                    on ? s.optionOn : null,
                    pressed ? s.pressed : null,
                  ]}
                >
                  <Text style={[s.checkbox, on ? s.checkboxOn : null]}>{on ? '✓' : ''}</Text>
                  <Text style={s.optionLabel}>{ROLE_LABEL[role]}</Text>
                  {role === 'ADMIN' && <Text style={s.optionNote}>no patient access</Text>}
                </Pressable>
              );
            })}
          </ScrollView>

          {roles.length > 1 && (
            <>
              <Text style={s.modalSection}>Signs in as</Text>
              <Text style={s.modalHint}>
                Where they land after logging in. They can switch once inside.
              </Text>
              <View style={s.chips}>
                {roles.map((role) => (
                  <Pressable
                    key={role}
                    disabled={busy}
                    onPress={() => setSignInAs(role)}
                    style={[s.chip, role === signInAs ? s.chipActive : null]}
                  >
                    <Text style={[s.chipText, role === signInAs ? s.chipTextActive : null]}>
                      {ROLE_LABEL[role]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {needsProfile && (
            <View style={s.profileBox}>
              <Text style={s.profileTitle}>{user.fullName} is not set up as a doctor yet</Text>
              <Text style={s.modalHint}>
                A doctor needs a clinical profile before they can be booked. This attaches one to
                the same account — no second login, and their work stays under one name.
              </Text>
              <Field
                label="Specialization"
                value={specialization}
                onChange={setSpecialization}
                placeholder="General Medicine"
              />
              <Field
                label="Registration number (optional)"
                value={registrationNo}
                onChange={setRegistrationNo}
                placeholder="Medical council number"
              />
              {/* The next thing that will block somebody, and the person it
                  blocks is a receptionist in front of a patient. */}
              <Text style={s.modalHint}>
                Set their consultation fee afterwards — checkout refuses for a doctor with no fee.
              </Text>
            </View>
          )}

          {roles.length === 0 && (
            <Text style={s.error}>
              A user must keep at least one role. Deactivate the account on the web app instead.
            </Text>
          )}

          {error && <Text style={s.error}>{error}</Text>}

          <View style={s.actions}>
            <Button
              label={needsProfile ? 'Create profile and save' : 'Save roles'}
              onPress={() => void save()}
              disabled={!changed || roles.length === 0 || !profileReady}
              busy={busy}
            />
            <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  body: { padding: theme.space(3), paddingBottom: theme.space(8) },
  profileBox: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space(3),
    marginTop: theme.space(2),
    gap: theme.space(1),
  },
  profileTitle: { ...theme.font.heading, color: theme.color.text },
  intro: {
    ...theme.font.small,
    color: theme.color.textMuted,
    lineHeight: 18,
    marginBottom: theme.space(3),
  },
  card: { marginBottom: theme.space(2) },
  pressed: { opacity: 0.6 },
  row: { flexDirection: 'row', alignItems: 'center' },
  name: { ...theme.font.body, color: theme.color.text, fontWeight: '600' },
  email: { ...theme.font.caption, color: theme.color.textSubtle, marginTop: 2 },
  inactive: {
    backgroundColor: theme.color.surfaceSunken,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.space(2),
    paddingVertical: 2,
  },
  inactiveText: { ...theme.font.caption, color: theme.color.textMuted },

  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(1), marginTop: theme.space(2) },
  badge: {
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(2),
    paddingVertical: 2,
  },
  badgeDefault: { backgroundColor: theme.color.text, borderColor: theme.color.text },
  badgeText: { ...theme.font.caption, color: theme.color.textMuted },
  badgeDefaultText: { color: theme.color.onSolid },

  footnote: {
    ...theme.font.caption,
    color: theme.color.textSubtle,
    textAlign: 'center',
    marginTop: theme.space(4),
    lineHeight: 16,
  },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,26,20,0.45)' },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(4),
    paddingBottom: theme.space(6),
    maxHeight: '88%',
  },
  modalTitle: { ...theme.font.title, color: theme.color.text },
  modalSection: {
    ...theme.font.caption,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.textSubtle,
    marginTop: theme.space(3),
  },
  modalHint: {
    ...theme.font.caption,
    color: theme.color.textMuted,
    lineHeight: 16,
    marginTop: theme.space(1),
  },

  optionList: { marginTop: theme.space(3), marginBottom: theme.space(1) },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space(2),
    paddingVertical: theme.space(2),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    marginBottom: theme.space(1),
  },
  optionOn: { borderColor: theme.color.text, backgroundColor: theme.color.surfaceSunken },
  optionLabel: { ...theme.font.body, color: theme.color.text, flex: 1 },
  optionNote: { ...theme.font.caption, color: theme.color.textSubtle },
  checkbox: {
    width: 20,
    height: 20,
    lineHeight: 20,
    textAlign: 'center',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    color: 'transparent',
    ...theme.font.caption,
  },
  checkboxOn: {
    backgroundColor: theme.color.text,
    borderColor: theme.color.text,
    color: theme.color.onSolid,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), marginTop: theme.space(2) },
  chip: {
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  chipActive: { backgroundColor: theme.color.text, borderColor: theme.color.text },
  chipText: { ...theme.font.small, color: theme.color.textMuted },
  chipTextActive: { color: theme.color.onSolid },

  error: { ...theme.font.small, color: theme.color.danger, marginTop: theme.space(2) },
  actions: { marginTop: theme.space(3), gap: theme.space(2) },
});
