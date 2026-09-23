import { router, Tabs } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { accentFor, fillFor, headerBgFor, theme } from '@/lib/theme';

/**
 * Tabs are derived from the signed-in role, exactly like the web sidebar.
 *
 * Expo Router registers every screen in the folder, so screens that do not
 * belong to the current role are hidden with `href: null` rather than omitted —
 * that removes them from the bar *and* from deep linking, so a notification
 * cannot drop a doctor onto the medication round.
 *
 * As on web, this is a usability boundary. The API is the security one.
 */
export default function TabsLayout() {
  const { user } = useAuth();
  /*
   * Role AND module, folded together.
   *
   * A tab is worth showing only if this person's role reaches it *and* this
   * hospital was sold it. Folding the module in here rather than at each tab
   * means a new tab inherits the rule from whichever flag it already uses —
   * fourteen tabs, one place to be right.
   *
   * Defaults to permitted while the session is loading, so nothing appears and
   * then vanishes as the user resolves.
   */
  const has = (m: string) => user?.hospital.modules?.includes(m as never) ?? true;

  const isNurse = user?.role === 'NURSE' && has('WARDS');
  const isDoctor = user?.role === 'DOCTOR' && has('CLINIC');
  const isPharmacist = user?.role === 'PHARMACIST' && has('PHARMACY');
  const isAdmin = user?.role === 'ADMIN';
  // Reception is the appointment book and the check-in queue, so it needs the
  // clinic like every other clinic role. It was unconditional here while the
  // role itself was always assignable.
  const isReception = user?.role === 'RECEPTIONIST' && has('CLINIC');
  const isBilling = user?.role === 'BILLING_STAFF' && has('BILLING');
  const isLabTech = user?.role === 'LAB_TECHNICIAN' && has('LABORATORY');
  /*
   * The pharmacist's ward-supply queue needs a ward to ask, which is a
   * different module from the one the role itself implies. The web nav item
   * carries the same WARDS tag for the same reason.
   */
  const isWardPharmacist = isPharmacist && has('WARDS');

  /*
   * Who gets patient lookup, mirroring `NAV` in `web/lib/nav.ts` exactly.
   *
   * LAB_TECHNICIAN is absent on both clients and that is deliberate: the lab
   * works from its own worklist, scoped to the tests somebody ordered from
   * them. Browsing the hospital's patient list is not part of running an assay,
   * and `PatientLabOrdersController` withholds the role for the same reason.
   *
   * ADMIN is absent for the opposite reason — it has the list on the web, and
   * mobile admin is read-only aggregates by design.
   */
  const canSeePatients =
    isDoctor || isNurse || isPharmacist || isReception || isBilling || isAdmin;

  /*
   * The test catalogue serves two roles for two reasons: a technician prices a
   * test, an administrator adds one. Both are on this screen because the phone
   * cannot afford two, and the screen shows each what they may do.
   */
  const canSeeCatalogue = (isLabTech || isAdmin) && has('LABORATORY');

  /*
   * The appointment book. Reception acts on it; a clinician reads it, which is
   * exactly the split the web nav already makes by giving DOCTOR, NURSE and
   * RECEPTIONIST the same Appointments item.
   */
  const canSeeSchedule = isDoctor || isNurse || isReception;

  /*
   * The one tab whose module differs from its role's. A doctor answers ward
   * requests, which are inpatient work — a clinic with no wards has none, and
   * showing the queue would be a screen that is permanently empty by
   * construction.
   */
  const isWardPrescriber = isDoctor && has('WARDS');

  // The bar wears the same accent as the header, so the app reads as one piece
  // and the active role stays legible from the bottom of the screen too.
  const accent = accentFor(user?.role);

  const icon =
    (glyph: string) =>
    ({ color, focused }: { color: string; focused: boolean }) => (
      <Text style={{ color, fontSize: focused ? 19 : 17 }}>{glyph}</Text>
    );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: theme.color.textSubtle,
        tabBarStyle: {
          // Same pale wash as the header, so the app is bracketed by its colour
          // top and bottom. The active tab uses the darkened accent — the neon
          // fill itself would be unreadable as a 9px label.
          backgroundColor: headerBgFor(user?.role),
          borderTopColor: fillFor(user?.role),
          borderTopWidth: 2,
          // Taller than the default: these are gloved thumbs in a hurry, and
          // the stock 49pt bar puts the labels uncomfortably close to the edge.
          height: Platform.OS === 'ios' ? 82 : 60,
          paddingTop: theme.space(1),
          paddingBottom: Platform.OS === 'ios' ? theme.space(7) : theme.space(2),
          ...theme.elevation.raised,
        },
        tabBarLabelStyle: { ...theme.font.overline, textTransform: 'none' },
        tabBarItemStyle: { paddingVertical: 2 },
      }}
    >
      {/* Doctor */}
      <Tabs.Screen
        name="index"
        options={{ title: 'Queue', tabBarIcon: icon('▤'), href: isDoctor ? undefined : null }}
      />

      {/* Nurse */}
      <Tabs.Screen
        name="ward"
        options={{ title: 'Ward', tabBarIcon: icon('▥'), href: isNurse ? undefined : null }}
      />
      <Tabs.Screen
        name="vitals"
        options={{ title: 'Vitals', tabBarIcon: icon('♥'), href: isNurse ? undefined : null }}
      />
      <Tabs.Screen
        name="meds"
        options={{ title: 'Meds', tabBarIcon: icon('℞'), href: isNurse ? undefined : null }}
      />

      {/*
        Pharmacy is two jobs, so it is two tabs.
        ---------------------------------------
        The queue and the stock list shared one screen, and reading it meant
        working out which half you were looking at. They answer different
        questions asked at different moments: "who is waiting" while somebody
        stands at the counter, and "what is running out" when the shelf is being
        checked. Splitting them matches the web's Queue / Inventory split.
      */}
      <Tabs.Screen
        name="pharmacy"
        options={{ title: 'Dispense', tabBarIcon: icon('℞'), href: isPharmacist ? undefined : null }}
      />
      <Tabs.Screen
        name="sell"
        options={{ title: 'Sell', tabBarIcon: icon('＄'), href: isPharmacist ? undefined : null }}
      />
      {/*
        Prescriptions written at another hospital and sent here. Its own tab
        rather than a section of the dispensing queue: they are a different kind
        of thing — no local patient, no allergy check possible — and mixing them
        into the same list is how the important difference gets skimmed past.
      */}
      <Tabs.Screen
        name="incoming"
        options={{ title: 'Incoming', tabBarIcon: icon('↧'), href: isPharmacist ? undefined : null }}
      />
      {/*
        The pharmacy's own till, and not the billing tab with a filter.
        In SEPARATE mode these are two businesses — the server returns disjoint
        sets to the two roles, so one screen with a switch would suggest they
        are one ledger seen two ways.
      */}
      <Tabs.Screen
        name="till"
        // Matches the web's "Pharmacy Invoices" for the same reason.
        options={{
          title: 'Pharmacy invoices',
          tabBarIcon: icon('¤'),
          href: isPharmacist ? undefined : null,
        }}
      />
      {/*
        Wards asking for stock of something already prescribed. A logistics
        queue, and its own tab rather than a section of dispensing: what a ward
        needs sent up and what a patient is waiting at the counter for are
        different jobs, and the ward one is answered by walking to a shelf.
      */}
      <Tabs.Screen
        name="supply"
        options={{
          title: 'Ward supply',
          tabBarIcon: icon('⇧'),
          href: isWardPharmacist ? undefined : null,
        }}
      />
      {/*
        The other request, and it goes to a doctor rather than here. Separate
        tabs because merging them would route a clinical question to a stock
        room — the failure being a drug supplied that nobody prescribed.
      */}
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Requests',
          tabBarIcon: icon('✎'),
          href: isWardPrescriber ? undefined : null,
        }}
      />
      {/* Not a tab: reached from a bed on the ward board. */}
      <Tabs.Screen name="chart/[admissionId]" options={{ href: null }} />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'Stock',
          tabBarIcon: icon('▨'),
          // The API lets an admin read inventory and receive stock, and the
          // phone deliberately does not offer it. `href: null` closes deep
          // linking as well as the tab, so a link from Overview would not work
          // anyway — and receiving stock is a pharmacy job standing at a shelf.
          href: isPharmacist ? undefined : null,
        }}
      />

      {/* Reception — check-in is the reason this role has an app at all. */}
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Appointments',
          tabBarIcon: icon('▦'),
          href: canSeeSchedule ? undefined : null,
        }}
      />
      {/*
        Patient lookup, for every role the web gives it to.
        ---------------------------------------------------
        It was reception-only, and the screen itself was never the problem — it
        is an ordinary search over `GET /patients`, which DOCTOR, NURSE,
        PHARMACIST and BILLING_STAFF may all call and all have a menu entry for
        on the web. Only the tab was missing.

        Reported from use as a doctor on the phone having no way to reach a
        patient at all: no list, no search, and the record screen only reachable
        from today's queue. A doctor whose patient is not on today's list — a
        ward round, a telephone call, a repeat — was stuck.

        `canSeePatients` rather than the role flags, because the answer is the
        same for five of the seven and duplicating it is how the clients drift.
      */}
      <Tabs.Screen
        name="patients"
        options={{
          title: 'Patients',
          tabBarIcon: icon('◍'),
          href: canSeePatients ? undefined : null,
        }}
      />

      {/* Billing — look up and take payment. Aging and reconciliation are web. */}
      <Tabs.Screen
        name="invoices"
        options={{ title: 'Invoices', tabBarIcon: icon('¤'), href: isBilling ? undefined : null }}
      />
      {/* Transactions rather than balances. Refunding starts here, because a
          refund raised from a payment carries that payment's id — the reversal
          is recorded against the thing it reverses. */}
      <Tabs.Screen
        name="payments"
        options={{ title: 'Payments', tabBarIcon: icon('⇄'), href: isBilling ? undefined : null }}
      />

      {/*
        The laboratory.

        Its own tabs rather than a section of the pharmacy's, because they are
        different people in any hospital bigger than one room — and a pharmacist
        who could read every blood result is the minimum-necessary failure that
        made LAB_TECHNICIAN a role of its own.
      */}
      <Tabs.Screen
        name="lab"
        options={{ title: 'Worklist', tabBarIcon: icon('▤'), href: isLabTech ? undefined : null }}
      />
      {/*
        Work sent here by another hospital. Segmented rather than
        waiting-only: "which hospitals send us work, and what happened to it"
        is asked precisely once a waiting-only list would have dropped the row.
      */}
      <Tabs.Screen
        name="lab-incoming"
        options={{ title: 'Incoming', tabBarIcon: icon('↧'), href: isLabTech ? undefined : null }}
      />
      {/* The lab's own till — a third set of books, disjoint from the other two. */}
      <Tabs.Screen
        name="lab-till"
        // "Till" is what the room is called; "Lab invoices" is what the web
        // menu says, and a user looking for the web's item could not find it.
        // A screen the user cannot name is one they report as missing.
        options={{ title: 'Lab invoices', tabBarIcon: icon('¤'), href: isLabTech ? undefined : null }}
      />
      <Tabs.Screen
        name="lab-catalogue"
        options={{
          title: 'Catalogue',
          tabBarIcon: icon('⌸'),
          href: canSeeCatalogue ? undefined : null,
        }}
      />

      {/*
        What we owe partner laboratories.

        Reached from the More hub rather than given a tab of its own — a tab
        bar holds five before the labels stop being readable, and this is a
        thing somebody opens when a laboratory rings, not one they live in.
        `href: null` keeps it routable without taking a slot.
      */}
      <Tabs.Screen name="lab-charges" options={{ title: 'Partner lab bills', href: null }} />

      {/* Admin — aggregates only, no patient reachable from here. */}
      <Tabs.Screen
        name="overview"
        options={{ title: 'Overview', tabBarIcon: icon('▨'), href: isAdmin ? undefined : null }}
      />
      {/*
        Everything else an administrator can reach.

        The web gives ADMIN sixteen menu items and a phone tab bar holds five,
        so the alternative to a hub was admin keeping one screen out of sixteen
        — which is exactly what was reported.

        Billing staff get it too, for one destination: what we owe partner
        laboratories. The hub itself narrows by role as well as by module, so
        they are not handed a list of screens their role cannot open — the
        empty-menu failure the module work exists to prevent, arriving from the
        other direction.
      */}
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: icon('☰'),
          href: isAdmin || isBilling ? undefined : null,
        }}
      />

      {/* All roles */}
      <Tabs.Screen name="alerts" options={{ title: 'Alerts', tabBarIcon: icon('🔔') }} />
      <Tabs.Screen name="me" options={{ title: 'Me', tabBarIcon: icon('☰') }} />

      {/*
        Pushed screens, inside the tab navigator rather than beside it.
        ---------------------------------------------------------------
        These lived in the root stack, which meant opening a patient — or
        writing a prescription — replaced the whole tab bar with a bare screen.
        A doctor mid-consultation could not reach their queue, and the only way
        back was a gesture. Whatever the app is doing, the way out of it should
        stay on screen.

        `href: null` keeps them out of the bar and out of deep linking while
        leaving them part of the navigator, which is what keeps the bar visible.
        It is the same mechanism the role gating above uses.

        They carry their own header because a tab screen has none by default,
        and `headerLeft` is explicit for the same reason: `Tabs` does not add a
        back button, so without it these become screens you can only leave by
        swiping.
      */}
      {[
        { name: 'patient/new', title: 'Register patient' },
        { name: 'patient/[id]', title: 'Patient' },
        { name: 'appointment/new', title: 'Book appointment' },
        { name: 'appointment/[id]', title: 'Reschedule' },
        { name: 'settings/clinic', title: 'Clinic settings' },
        { name: 'settings/staff', title: 'Staff roles' },
        { name: 'reports/activity', title: 'Daily activity' },
        { name: 'reports/audit', title: 'Audit log' },
        { name: 'settings/departments', title: 'Departments' },
        { name: 'settings/lab-partners', title: 'Partner labs' },
        { name: 'dispense/[id]', title: 'Dispense' },
        // Reached from the worklist and from a patient, not from the bar.
        { name: 'lab-result/[itemId]', title: 'Enter result' },
        { name: 'lab-order/[patientId]', title: 'Request tests' },
      ].map((screen) => (
        <Tabs.Screen
          key={screen.name}
          name={screen.name}
          options={{
            href: null,
            headerShown: true,
            title: screen.title,
            headerStyle: { backgroundColor: headerBgFor(user?.role) },
            headerTitleStyle: { ...theme.font.heading, color: theme.color.text },
            headerShadowVisible: false,
            headerLeft: () => (
              <Pressable onPress={() => router.back()} hitSlop={12} style={s.back}>
                <Text style={[s.backGlyph, { color: accent }]}>‹</Text>
              </Pressable>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const s = StyleSheet.create({
  back: { paddingHorizontal: theme.space(3), paddingVertical: theme.space(1) },
  // Oversized on purpose: a chevron at body size is a hard target for a thumb,
  // and this is the only way off these screens without a gesture.
  backGlyph: { fontSize: 30, lineHeight: 32, fontWeight: '600' },
});
