/**
 * Local development seed — DUMMY DATA ONLY.
 *
 * Names are deliberately, obviously fake ("Testpatient", "Demo"). Realistic
 * fake patient data gets mistaken for real patient data, and that mistake is
 * expensive. If these names ever look plausible, that is a bug.
 *
 * Run: npm run seed
 */
import {
  AdmissionStatus,
  AllergySeverity,
  AppointmentStatus,
  DoseStatus,
  DrugClass,
  Gender,
  InvoiceStatus,
  LabCategory,
  LabSpecimenType,
  PaymentMethod,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { withTenantWrites } from '../src/common/tenancy/tenant-context';
import { hospitalDate, zonedTimeToUtc } from '../src/common/utils/hospital-time';
import type { ClinicSettings } from '../src/common/tenancy/clinic-settings';

/**
 * The unscoped client. Used for the truncation pass and to create the
 * tenants themselves; everything else goes through a tenant-wrapped copy.
 *
 * The seed connects as the database owner or a superuser, which bypasses
 * RLS — that is what lets one process write two hospitals' data. The API
 * connects as `hms_app`, which cannot. If the seed ever starts failing with
 * empty results, check which role DATABASE_URL is using.
 */
/**
 * `ts-node prisma/seed.ts` is a plain Node process — it does not read `.env`.
 *
 * The Prisma CLI loads it, and so does PrismaClient when resolving `env()` from
 * schema.prisma, which is why a bare `new PrismaClient()` used to work here and
 * why reading `process.env.DATABASE_URL_ADMIN` did not. Loading it explicitly
 * is the fix; the client's own loading covers only its own datasource.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

const seedUrl = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL;
if (!seedUrl) {
  throw new Error(
    'Neither DATABASE_URL_ADMIN nor DATABASE_URL is set.\n' +
      'The seed needs the admin connection — see backend/.env.',
  );
}

const base = new PrismaClient({
  // Explicitly the admin connection, not DATABASE_URL.
  //
  // DATABASE_URL is `hms_app`, which RLS confines to one hospital at a time.
  // Seeding two hospitals from one process is exactly what that role exists to
  // prevent: with no `app.tenant_id` set, every insert fails the policy's
  // WITH CHECK and the seed would stop on the first patient.
  datasources: { db: { url: seedUrl } },
});

const DEV_PASSWORD = 'ChangeMe123!';

/**
 * The deliberately-fake surnames the seed gives patients.
 *
 * Exported as a constant because two things depend on it: generating the names,
 * and recognising them again in assertSafeToWipe. Written out twice, they drift
 * — and the failure mode of that drift is a guard that refuses every honest
 * reseed, or worse, one that deletes real data because it did not recognise a
 * prefix it had itself invented.
 */
const SEEDED_NAME_PREFIXES = [
  'Testpatient', 'Demopatient', 'Samplepatient', 'Fakepatient',
  'Mockpatient', 'Dummypatient', 'Examplepatient', 'Placeholder',
];

/**
 * Refuses to delete data that was not seeded.
 *
 * The seed truncates every table before inserting — which is right for a
 * throwaway demo database and catastrophic on one somebody has been using.
 * Seeded patients carry one of SEEDED_NAME_PREFIXES; anything else was typed
 * by a person, and destroying it silently because a setup step said
 * "npm run seed" is not a trade this script gets to make on its own.
 *
 * Pass --force to seed anyway.
 */
async function assertSafeToWipe() {
  if (process.argv.includes('--force')) return;

  const patients = await base.patient.findMany({
    where: {
      AND: SEEDED_NAME_PREFIXES.map((prefix) => ({
        NOT: { fullName: { startsWith: prefix } },
      })),
    },
    select: { fullName: true },
    take: 5,
  });

  if (patients.length === 0) return;

  const names = patients.map((p) => `  - ${p.fullName}`).join('\n');
  throw new Error(
    `Refusing to seed: this database has ${patients.length}+ patient(s) that were not seeded.\n\n` +
      `${names}\n\n` +
      `Seeding DELETES every row first. If you want that anyway:\n` +
      `  npm run seed -- --force\n`,
  );
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed a production database.');
  }

  console.log('Seeding — dummy data only\n');

  await assertSafeToWipe();

  // Order matters: children before parents.
  await base.dispenseLine.deleteMany();
  await base.dispenseEvent.deleteMany();
  await base.stockBatch.deleteMany();
  await base.medicationAdministration.deleteMany();
  await base.vital.deleteMany();
  await base.admission.deleteMany();
  await base.bed.deleteMany();
  await base.ward.deleteMany();
  await base.auditLog.deleteMany();
  await base.refreshToken.deleteMany();
  // Cascades from user deletion too, but listed for the same reason as the
  // rest: the truncation order is the documentation of what depends on what.
  await base.userRoleAssignment.deleteMany();
  await base.prescriptionItem.deleteMany();
  await base.prescription.deleteMany();
  await base.payment.deleteMany();
  await base.invoiceItem.deleteMany();
  await base.invoice.deleteMany();
  await base.medicalRecord.deleteMany();
  await base.appointment.deleteMany();
  await base.allergy.deleteMany();
  await base.patient.deleteMany();
  await base.doctor.deleteMany();
  await base.user.deleteMany();
  await base.department.deleteMany();
  await base.medicine.deleteMany();

  // ── the hospitals ──
  //
  // Two, not one, because a single-tenant seed cannot detect the bugs that
  // matter here. With one hospital every cross-tenant query looks correct.
  await base.tenant.deleteMany();
  const tenants = await Promise.all([
    // Deliberately different clinic days. A seed where both hospitals are
    // configured identically cannot show that the settings are per-tenant —
    // and would have hidden every bug in the work that made them so.
    base.tenant.create({
      data: {
        slug: 'st-marys',
        name: "St Mary's Demo Hospital",
        timezone: 'America/Chicago',
        currency: 'USD',
        slotMinutes: 10,
        clinicStartHour: 8,
        clinicEndHour: 18,
      },
    }),
    base.tenant.create({
      data: {
        slug: 'riverside',
        name: 'Riverside Demo Hospital',
        timezone: 'Asia/Calcutta',
        currency: 'INR',
        slotMinutes: 5,
        clinicStartHour: 7,
        clinicEndHour: 13,
      },
    }),
  ]);
  console.log(`  ${tenants.length} hospitals`);

  for (const tenant of tenants) {
    console.log(`\n── ${tenant.name} (${tenant.slug}) ──`);
    // Wrapped exactly as a request is, so every create below inherits the
    // tenant without naming it.
    await seedHospital(
      withTenantWrites(base, tenant.id) as unknown as PrismaClient,
      tenant.slug,
      tenant.id,
      {
        // The seed leaves tax off: a demo hospital should look like a fresh
        // one, and switching it on is a deliberate act.
        taxEnabled: false,
        pricesIncludeTax: false,
        consultationTaxRateId: null,
        timezone: tenant.timezone,
        slotMinutes: tenant.slotMinutes,
        clinicStartHour: tenant.clinicStartHour,
        clinicEndHour: tenant.clinicEndHour,
        currency: tenant.currency,
        pharmacyBilling: tenant.pharmacyBilling,
        hasPharmacy: tenant.hasPharmacy,
        acceptsExternalPrescriptions: tenant.acceptsExternalPrescriptions,
        labBilling: tenant.labBilling,
        hasLab: tenant.hasLab,
        acceptsExternalLabOrders: tenant.acceptsExternalLabOrders,
        acceptedReferralBilling: tenant.acceptedReferralBilling,
      },
    );
    console.log(
      `  clinic: ${String(tenant.clinicStartHour).padStart(2, '0')}:00-` +
        `${String(tenant.clinicEndHour).padStart(2, '0')}:00 ${tenant.timezone}, ` +
        `${tenant.slotMinutes}-minute slots, ${tenant.currency}`,
    );
  }

  await seedPlatform();
}

/**
 * The vendor's own staff. Belongs to no hospital.
 *
 * Exactly one account, and it can do almost nothing on its own: listing
 * hospitals and opening a time-boxed grant. Reading anything about a hospital
 * needs a grant with a written reason, and that grant is recorded in *that
 * hospital's* audit log.
 */
async function seedPlatform() {
  console.log('\n── Platform (vendor-side, no hospital) ──');

  await base.breakGlassGrant.deleteMany();
  await base.platformUser.deleteMany();

  const passwordHash = await hash(DEV_PASSWORD);
  const support = await base.platformUser.create({
    data: {
      email: 'support@vendor.example',
      passwordHash,
      fullName: 'Vendor Support',
    },
  });

  console.log(`  ${support.email} — POST /api/v1/platform/auth/login`);
  console.log('  no break-glass grants: support sees hospital names and row counts only');
}

/**
 * One hospital's worth of data.
 *
 * `prisma` here is tenant-wrapped, so the writes read exactly as they did when
 * this was a single-tenant seed.
 */
async function seedHospital(
  prisma: PrismaClient,
  slug: string,
  tenantId: number,
  clinic: ClinicSettings,
) {

  // ── departments ──
  const departments = await Promise.all(
    ['Cardiology', 'General Medicine', 'Orthopaedics'].map((name) =>
      prisma.department.create({ data: { tenantId, name } }),
    ),
  );
  console.log(`  ${departments.length} departments`);

  // St Mary's keeps the original @demo.test addresses; Riverside gets its
  // own domain, so an unqualified login is unambiguous for both.
  const domain = slug === 'st-marys' ? 'demo.test' : 'riverside.test';

  const passwordHash = await hash(DEV_PASSWORD);

  // ── one user per role ──
  const staff: { email: string; fullName: string; role: UserRole }[] = [
    { email: `admin@${domain}`, fullName: 'Demo Administrator', role: UserRole.ADMIN },
    { email: `reception@${domain}`, fullName: 'Demo Receptionist', role: UserRole.RECEPTIONIST },
    { email: `nurse@${domain}`, fullName: 'Demo Nurse', role: UserRole.NURSE },
    { email: `pharmacy@${domain}`, fullName: 'Demo Pharmacist', role: UserRole.PHARMACIST },
    { email: `billing@${domain}`, fullName: 'Demo Billing Clerk', role: UserRole.BILLING_STAFF },
  ];
  for (const s of staff) {
    await prisma.user.create({ data: { ...s, tenantId, passwordHash } });
  }

  // ── doctors (user + profile) ──
  /*
   * Fees differ per doctor on purpose, and one is deliberately left unset.
   *
   * A seed where every doctor charges the same cannot show that the fee is
   * per-doctor, and a seed where every doctor has one hides the case reception
   * actually hits: checkout refusing because nobody set a price. Doctor Three
   * has no fee, so that path is reachable the moment you open the app.
   */
  const doctorSpecs = [
    { email: `doctor@${domain}`, fullName: 'Demo Doctor One', specialization: 'Cardiology', dept: 0, fee: '120.00' },
    { email: `doctor2@${domain}`, fullName: 'Demo Doctor Two', specialization: 'General Medicine', dept: 1, fee: '60.00' },
    { email: `doctor3@${domain}`, fullName: 'Demo Doctor Three', specialization: 'Orthopaedics', dept: 2, fee: null },
  ];
  const doctors = [];
  for (const [i, d] of doctorSpecs.entries()) {
    const user = await prisma.user.create({
      data: { tenantId, email: d.email, fullName: d.fullName, role: UserRole.DOCTOR, passwordHash },
    });
    doctors.push(
      await prisma.doctor.create({
        data: {
          tenantId,
          userId: user.id,
          fullName: d.fullName,
          specialization: d.specialization,
          departmentId: departments[d.dept].id,
          registrationNo: `DEMO-REG-${1000 + i}`,
          consultationFee: d.fee,
        },
      }),
    );
  }
  // ── the owner-doctor ──
  //
  // The case this feature exists for: in a small hospital the person who owns
  // it also treats patients. One login, two roles, one worn at a time.
  const owner = await prisma.user.create({
    data: {
      tenantId,
      email: `owner@${domain}`,
      fullName: 'Demo Owner Doctor',
      role: UserRole.DOCTOR, // lands in the clinical role, where the work is
      passwordHash,
    },
  });
  await prisma.doctor.create({
    data: {
      tenantId,
      userId: owner.id,
      fullName: 'Demo Owner Doctor',
      specialization: 'General Medicine',
      consultationFee: '150.00',
      departmentId: departments[1].id,
      registrationNo: 'DEMO-REG-OWNER',
    },
  });
  for (const role of [UserRole.DOCTOR, UserRole.ADMIN]) {
    await prisma.userRoleAssignment.create({ data: { tenantId, userId: owner.id, role } });
  }

  /*
   * Everyone else gets an assignment matching their single role, so the
   * assignment table is the whole truth rather than half of it.
   *
   * `where: { tenantId }` is doing real work here. withTenantWrites stamps
   * WRITES with the tenant; it does not filter READS. And the seed connects as
   * a superuser, so RLS does not filter them either — which means an unscoped
   * findMany while seeding the second hospital returns the first hospital's
   * users too, and the insert then fails on the (userId, role) unique index.
   *
   * skipDuplicates on top, so re-running the seed over a partially seeded
   * database is not a dead end.
   */
  const others = await prisma.user.findMany({
    where: { tenantId, id: { not: owner.id } },
    select: { id: true, role: true },
  });
  await prisma.userRoleAssignment.createMany({
    data: others.map((u) => ({ tenantId, userId: u.id, role: u.role })),
    skipDuplicates: true,
  });

  console.log(`  ${staff.length + doctors.length + 1} users (${doctors.length + 1} doctors)`);
  console.log(`  owner@${domain} holds DOCTOR + ADMIN — one login, two hats`);
  console.log(`  password for every account: ${DEV_PASSWORD}`);

  // ── drug catalogue ──
  // Deliberately small. The point is that `drugClass` is populated, since that
  // is what makes the allergy check catch Amoxicillin against a penicillin
  // allergy. A real deployment imports dm+d or RxNorm.
  const medicineSpecs = [
    { name: 'Amlodipine', form: 'Tablet', strength: '5 mg', drugClass: DrugClass.CALCIUM_CHANNEL_BLOCKER },
    { name: 'Metformin', form: 'Tablet', strength: '500 mg', drugClass: DrugClass.ANTIDIABETIC },
    { name: 'Ibuprofen', form: 'Tablet', strength: '400 mg', drugClass: DrugClass.NSAID },
    { name: 'Salbutamol', form: 'Inhaler', strength: '100 mcg', drugClass: DrugClass.BRONCHODILATOR },
    { name: 'Amoxicillin', form: 'Capsule', strength: '500 mg', drugClass: DrugClass.PENICILLIN },
    { name: 'Flucloxacillin', form: 'Capsule', strength: '500 mg', drugClass: DrugClass.PENICILLIN },
    { name: 'Cefalexin', form: 'Capsule', strength: '250 mg', drugClass: DrugClass.CEPHALOSPORIN },
    { name: 'Paracetamol', form: 'Tablet', strength: '500 mg', drugClass: DrugClass.OTHER },
    { name: 'Enalapril', form: 'Tablet', strength: '10 mg', drugClass: DrugClass.ACE_INHIBITOR },
    { name: 'Warfarin', form: 'Tablet', strength: '3 mg', drugClass: DrugClass.ANTICOAGULANT, isControlled: false },
    { name: 'Morphine sulfate', form: 'Injection', strength: '10 mg/ml', drugClass: DrugClass.OPIOID, isControlled: true },
    { name: 'Co-trimoxazole', form: 'Tablet', strength: '480 mg', drugClass: DrugClass.SULFONAMIDE },
  ];
  const medicines = [];
  for (const m of medicineSpecs) {
    medicines.push(await prisma.medicine.create({ data: { ...m, tenantId, reorderLevel: 30 } }));
  }
  console.log(`  ${medicines.length} medicines`);

  /*
   * A small test catalogue, with real reference ranges.
   *
   * Here so the demo has something to order, and NOT the only way to create
   * one — `POST /lab-tests` exists and `self-provisionable.spec.ts` asserts
   * both halves of that. The medicine catalogue, doctor profiles and wards
   * were each seed-only for six phases, and every one of them was found on a
   * real deployment by a user rather than by a test, because an empty table and
   * an unbuilt feature render identically.
   *
   * The ranges are adult, unbanded and approximate. They are demo data: a real
   * laboratory sets its own, because an interval belongs to the analyser that
   * produced the number rather than to the analyte.
   */
  const labTestSpecs: {
    code: string;
    name: string;
    category: LabCategory;
    specimenType: LabSpecimenType;
    sellingPrice: string | null;
    turnaroundHours: number;
    preparation?: string;
    analytes: {
      name: string;
      unit?: string;
      refLow?: string;
      refHigh?: string;
      refText?: string;
      criticalLow?: string;
      criticalHigh?: string;
    }[];
  }[] = [
    {
      code: 'FBC',
      name: 'Full blood count',
      category: LabCategory.HAEMATOLOGY,
      specimenType: LabSpecimenType.BLOOD,
      sellingPrice: '12.0000',
      turnaroundHours: 4,
      preparation: 'Purple-top EDTA tube.',
      analytes: [
        { name: 'Haemoglobin', unit: 'g/L', refLow: '130', refHigh: '170', criticalLow: '70', criticalHigh: '200' },
        { name: 'White cell count', unit: '10^9/L', refLow: '4', refHigh: '11', criticalLow: '1', criticalHigh: '30' },
        { name: 'Platelets', unit: '10^9/L', refLow: '150', refHigh: '400', criticalLow: '20' },
      ],
    },
    {
      code: 'UE',
      name: 'Urea and electrolytes',
      category: LabCategory.BIOCHEMISTRY,
      specimenType: LabSpecimenType.BLOOD,
      sellingPrice: '14.0000',
      turnaroundHours: 4,
      analytes: [
        // The classic critical value, and the reason the telephone-call record
        // exists at all.
        { name: 'Potassium', unit: 'mmol/L', refLow: '3.5', refHigh: '5.3', criticalLow: '2.5', criticalHigh: '6.5' },
        { name: 'Sodium', unit: 'mmol/L', refLow: '133', refHigh: '146', criticalLow: '120', criticalHigh: '160' },
        { name: 'Creatinine', unit: 'umol/L', refLow: '60', refHigh: '110' },
      ],
    },
    {
      code: 'GLU',
      name: 'Fasting glucose',
      category: LabCategory.BIOCHEMISTRY,
      specimenType: LabSpecimenType.BLOOD,
      sellingPrice: '8.0000',
      turnaroundHours: 4,
      preparation: 'Fasting, 8 hours. Water only.',
      analytes: [
        { name: 'Glucose', unit: 'mmol/L', refLow: '3.9', refHigh: '5.5', criticalLow: '2.2', criticalHigh: '25' },
      ],
    },
    {
      code: 'MSU',
      name: 'Urine culture',
      category: LabCategory.MICROBIOLOGY,
      specimenType: LabSpecimenType.URINE,
      sellingPrice: '18.0000',
      turnaroundHours: 48,
      preparation: 'Midstream specimen, sterile pot.',
      // A worded range rather than a numeric one — which is why `refText`
      // exists and why `flagFor` compares text as well as numbers.
      analytes: [{ name: 'Culture', refText: 'No growth' }],
    },
    {
      code: 'CXR',
      name: 'Chest X-ray',
      category: LabCategory.IMAGING,
      // No specimen: the workflow skips collection rather than waiting for a
      // sample that does not exist.
      specimenType: LabSpecimenType.NONE,
      // Deliberately unpriced, so the demo shows what an unpriced test looks
      // like — performed, not charged for, and named back rather than
      // silently free.
      sellingPrice: null,
      turnaroundHours: 24,
      // No analytes: reports as findings and an impression, which is how
      // imaging and histopathology work.
      analytes: [],
    },
  ];

  for (const spec of labTestSpecs) {
    const { analytes, ...test } = spec;
    await prisma.labTest.create({
      data: {
        ...test,
        tenantId,
        analytes: {
          create: analytes.map((a, position) => ({ ...a, tenantId, position })),
        },
      },
    });
  }
  console.log(`  ${labTestSpecs.length} lab tests`);

  // ── stock: a mix of healthy, low, expiring and expired ──
  let batchCount = 0;
  for (const [i, medicine] of medicines.entries()) {
    // Every fifth medicine is deliberately below its reorder level, and every
    // seventh carries an already-expired batch, so the inventory screen has
    // all of its states to render.
    const healthy = i % 5 !== 0;
    const daysToExpiry = i % 3 === 0 ? 30 : 400;

    await prisma.stockBatch.create({
      data: {
        tenantId,
        medicineId: medicine.id,
        batchNumber: `B${2026}${String(i + 1).padStart(3, '0')}`,
        expiresAt: new Date(Date.now() + daysToExpiry * 24 * 3600_000),
        quantity: healthy ? 120 + i * 10 : 8,
      },
    });
    batchCount++;

    if (i % 7 === 0) {
      await prisma.stockBatch.create({
        data: {
          tenantId,
          medicineId: medicine.id,
          batchNumber: `EXP${String(i + 1).padStart(3, '0')}`,
          expiresAt: new Date(Date.now() - 20 * 24 * 3600_000),
          quantity: 40,
        },
      });
      batchCount++;
    }
  }
  console.log(`  ${batchCount} stock batches`);

  // ── patients ──
  const firstNames = SEEDED_NAME_PREFIXES;
  const suffixes = [
    'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
    'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
    'Quebec', 'Romeo', 'Sierra', 'Tango',
  ];
  const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
  const genders = [Gender.MALE, Gender.FEMALE, Gender.OTHER];

  const patients = [];
  for (let i = 0; i < 40; i++) {
    const name = `${firstNames[i % firstNames.length]} ${suffixes[i % suffixes.length]}`;
    patients.push(
      await prisma.patient.create({
        data: {
          tenantId,
          fullName: name,
          dob: new Date(Date.UTC(1950 + (i * 17) % 55, i % 12, ((i * 7) % 28) + 1)),
          gender: genders[i % 3],
          phone: `+44 7700 9${String(10000 + i).slice(-5)}`,
          email: `patient${i}@demo.test`,
          address: `${i + 1} Example Street, Demo City, DM${i % 9} ${i % 9}AA`,
          bloodGroup: bloodGroups[i % bloodGroups.length],
          emergencyContactName: `Democontact ${suffixes[(i + 3) % suffixes.length]}`,
          emergencyContactPhone: `+44 7700 8${String(10000 + i).slice(-5)}`,
        },
      }),
    );
  }
  console.log(`  ${patients.length} patients`);

  // ── allergies on roughly a third ──
  const allergens: [string, AllergySeverity][] = [
    ['Penicillin', AllergySeverity.SEVERE],
    ['Sulfa drugs', AllergySeverity.MODERATE],
    ['Latex', AllergySeverity.MILD],
    ['Peanuts', AllergySeverity.LIFE_THREATENING],
    ['Aspirin', AllergySeverity.MODERATE],
  ];
  let allergyCount = 0;
  for (let i = 0; i < patients.length; i += 3) {
    const [substance, severity] = allergens[(i / 3) % allergens.length];
    await prisma.allergy.create({
      data: { tenantId, patientId: patients[i].id, substance, severity },
    });
    allergyCount++;
  }
  console.log(`  ${allergyCount} allergies`);

  // ── appointments across a working week ──
  // Slots are unique per doctor per time — the schema enforces that, so the
  // seed has to respect it too.
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const statusesForPast = [
    AppointmentStatus.COMPLETED,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.CANCELLED,
  ];

  let appointmentCount = 0;
  let patientCursor = 0;

  for (let dayOffset = -2; dayOffset <= 2; dayOffset++) {
    for (const [d, doctor] of doctors.entries()) {
      for (let slot = 0; slot < 5; slot++) {
        // On the hospital's own grid, in the hospital's own zone. Fixed UTC
        // hours would put a Chicago clinic's appointments at 04:00 local —
        // outside its opening hours, so they would never appear in the
        // availability view that reception actually books from.
        const dayAnchor = new Date(startOfToday);
        dayAnchor.setUTCDate(dayAnchor.getUTCDate() + dayOffset);
        const day = hospitalDate(dayAnchor, clinic.timezone);
        const scheduledAt = zonedTimeToUtc(
          {
            ...day,
            // One hour apart per doctor, so two doctors never share a slot.
            hour: clinic.clinicStartHour + d,
            minute: slot * clinic.slotMinutes,
          },
          clinic.timezone,
        );

        const patient = patients[patientCursor % patients.length];
        patientCursor++;

        let status: AppointmentStatus;
        if (dayOffset < 0) {
          status = statusesForPast[appointmentCount % statusesForPast.length];
        } else if (dayOffset === 0) {
          status =
            slot === 0
              ? AppointmentStatus.COMPLETED
              : slot === 1
                ? AppointmentStatus.IN_PROGRESS
                : slot < 4
                  ? AppointmentStatus.CHECKED_IN
                  : AppointmentStatus.SCHEDULED;
        } else {
          status = AppointmentStatus.SCHEDULED;
        }

        const appointment = await prisma.appointment.create({
          data: {
            tenantId,
            patientId: patient.id,
            doctorId: doctor.id,
            scheduledAt,
            status,
            reason: ['Follow-up', 'Routine check', 'Consultation', 'Post-op review', 'Referral'][slot],
          },
        });
        appointmentCount++;

        // Completed visits leave a record and, sometimes, a prescription.
        if (status === AppointmentStatus.COMPLETED) {
          await prisma.medicalRecord.create({
            data: {
              tenantId,
              patientId: patient.id,
              doctorId: doctor.id,
              visitDate: scheduledAt,
              diagnosis: ['Hypertension', 'Type 2 diabetes', 'Osteoarthritis', 'Asthma'][
                appointmentCount % 4
              ],
              notes: 'Demo record — not a real clinical note.',
            },
          });

          if (appointmentCount % 2 === 0) {
            await prisma.prescription.create({
              data: {
                tenantId,
                patientId: patient.id,
                doctorId: doctor.id,
                appointmentId: appointment.id,
                issuedAt: scheduledAt,
                items: {
                  create: [
                    (() => {
                      const name = ['Amlodipine', 'Metformin', 'Ibuprofen', 'Salbutamol'][
                        appointmentCount % 4
                      ];
                      const match = medicines.find((m) => m.name === name);
                      return {
                        tenantId,
                        medicineName: name,
                        // Seeded data is already linked; the backfill exists
                        // for prescriptions written before the catalogue.
                        medicineId: match?.id ?? null,
                        dosage: '5 mg',
                        frequency: 'Once daily',
                        duration: '30 days',
                      };
                    })(),
                  ],
                },
              },
            });
          }
        }
      }
    }
  }
  console.log(`  ${appointmentCount} appointments (with records and prescriptions)`);

  // ── wards and beds ──
  const wardSpecs = [
    { name: 'Ward A — General', floor: '1', beds: 12 },
    { name: 'Ward B — Cardiology', floor: '2', beds: 12 },
  ];
  const allBeds = [];
  for (const w of wardSpecs) {
    const ward = await prisma.ward.create({ data: { tenantId, name: w.name, floor: w.floor } });
    const prefix = w.name.includes('A') ? 'A' : 'B';
    for (let i = 1; i <= w.beds; i++) {
      allBeds.push(
        await prisma.bed.create({
          data: {
            tenantId,
            wardId: ward.id,
            label: `${prefix}-${String(i).padStart(2, '0')}`,
            // One bed per ward out of service, so the board has that state too.
            isActive: i !== w.beds,
          },
        }),
      );
    }
  }
  console.log(`  ${wardSpecs.length} wards, ${allBeds.length} beds`);

  // ── admissions: fill roughly two thirds of the usable beds ──
  const nurse = await prisma.user.findFirstOrThrow({ where: { role: UserRole.NURSE } });
  const usable = allBeds.filter((b) => b.isActive);
  const admittedCount = Math.floor(usable.length * 0.66);
  const admissions = [];

  for (let i = 0; i < admittedCount; i++) {
    // Offset into the patient list so admitted patients are not the same ones
    // filling today's clinic queue.
    const patient = patients[(i + 12) % patients.length];
    admissions.push(
      await prisma.admission.create({
        data: {
          tenantId,
          patientId: patient.id,
          bedId: usable[i].id,
          admittedAt: new Date(Date.now() - (i % 5) * 24 * 3600_000),
          reason: ['Observation', 'Post-operative', 'Chest pain', 'IV antibiotics'][i % 4],
          status: AdmissionStatus.ADMITTED,
          currentBedId: usable[i].id,
          currentPatientId: patient.id,
        },
      }),
    );
  }
  console.log(`  ${admissions.length} admissions`);

  // ── observations: recent for most, deliberately stale for a few ──
  let vitalCount = 0;
  for (const [i, admission] of admissions.entries()) {
    // Every fourth patient is overdue, so the ward board shows that state.
    const hoursAgo = i % 4 === 0 ? 7 : (i % 3) + 1;
    await prisma.vital.create({
      data: {
        tenantId,
        patientId: admission.patientId,
        admissionId: admission.id,
        recordedById: nurse.id,
        recordedAt: new Date(Date.now() - hoursAgo * 3600_000),
        systolic: 110 + ((i * 7) % 60),
        diastolic: 65 + ((i * 5) % 30),
        pulse: 58 + ((i * 11) % 50),
        temperatureC: 36.2 + ((i % 12) * 0.2),
        respiratoryRate: 12 + (i % 10),
        spo2: 92 + (i % 8),
        painScore: i % 6,
      },
    });
    vitalCount++;
  }
  console.log(`  ${vitalCount} observation sets`);

  // ── drug chart: schedule today's doses for admitted patients ──
  let doseCount = 0;
  const todayAt = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  for (const [i, admission] of admissions.entries()) {
    const rx = await prisma.prescription.findFirst({
      where: { patientId: admission.patientId },
      include: { items: true },
    });
    const item = rx?.items?.[0];
    if (!item) continue;

    for (const [j, hour] of [8, 14, 20].entries()) {
      const dueAt = todayAt(hour);
      const past = dueAt.getTime() < Date.now();
      await prisma.medicationAdministration.create({
        data: {
          tenantId,
          prescriptionItemId: item.id,
          admissionId: admission.id,
          patientId: admission.patientId,
          dueAt,
          // Past doses are mostly given; leave some overdue so the round has
          // something in its overdue group.
          status: past && (i + j) % 4 !== 0 ? DoseStatus.GIVEN : DoseStatus.DUE,
          givenAt: past && (i + j) % 4 !== 0 ? dueAt : null,
          givenById: past && (i + j) % 4 !== 0 ? nurse.id : null,
        },
      });
      doseCount++;
    }
  }
  console.log(`  ${doseCount} scheduled doses`);

  // ── invoices, spread across the aging buckets ──
  // Line descriptions are service text, never drug names — see
  // billing.service.ts on why invoices are not generated from clinical data.
  const billing = await prisma.user.findFirstOrThrow({ where: { role: UserRole.BILLING_STAFF } });
  const services: [string, string][] = [
    ['Outpatient consultation', '120.00'],
    ['Ward stay, per night', '450.00'],
    ['Diagnostic imaging', '280.00'],
    ['Minor procedure', '640.00'],
    ['Dressing and supplies', '35.50'],
  ];
  // Days past due — deliberately one per bucket boundary.
  const ageOffsets = [-7, 5, 20, 45, 75, 200];

  let invoiceCount = 0;
  let paymentCount = 0;

  for (let i = 0; i < 18; i++) {
    const patient = patients[(i * 3) % patients.length];
    const lines = [services[i % services.length], services[(i + 2) % services.length]];
    const totalMinor = lines.reduce((sum, [, amt]) => sum + Math.round(Number(amt) * 100), 0);
    const daysPastDue = ageOffsets[i % ageOffsets.length];

    // A third are settled, a third part-paid, a third untouched.
    const mode = i % 3;
    const paidMinor = mode === 0 ? totalMinor : mode === 1 ? Math.round(totalMinor / 3) : 0;
    const status =
      paidMinor === totalMinor
        ? InvoiceStatus.PAID
        : paidMinor > 0
          ? InvoiceStatus.PARTIALLY_PAID
          : InvoiceStatus.PENDING;

    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        patientId: patient.id,
        totalAmount: (totalMinor / 100).toFixed(2),
        amountPaid: (paidMinor / 100).toFixed(2),
        status,
        issuedAt: new Date(Date.now() - (daysPastDue + 14) * 24 * 3600_000),
        dueDate: new Date(Date.now() - daysPastDue * 24 * 3600_000),
        items: { create: lines.map(([description, amount]) => ({ tenantId, description, amount })) },
      },
    });
    invoiceCount++;

    if (paidMinor > 0) {
      await prisma.payment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: (paidMinor / 100).toFixed(2),
          method: [PaymentMethod.CARD, PaymentMethod.CASH, PaymentMethod.INSURANCE][i % 3],
          reference: `REF-${1000 + i}`,
          receivedById: billing.id,
          receivedAt: new Date(Date.now() - Math.max(0, daysPastDue - 2) * 24 * 3600_000),
        },
      });
      paymentCount++;
    }
  }
  console.log(`  ${invoiceCount} invoices, ${paymentCount} payments`);

  // Insurance on roughly half, so the billing patient view has both states.
  for (let i = 0; i < patients.length; i += 2) {
    await prisma.patient.update({
      where: { id: patients[i].id },
      data: {
        tenantId,
        insurerName: ['Demo Health Cover', 'Example Assurance', 'Placeholder Mutual'][i % 3],
        insurancePolicyNumber: `POL-${100000 + i}`,
      },
    });
  }

  console.log('\nDone. Sign in with any of:');
  for (const s of [...staff, ...doctorSpecs.map((d) => ({ email: d.email, role: 'DOCTOR' }))]) {
    console.log(`  ${String(s.role).padEnd(15)} ${s.email}`);
  }
  console.log(`\n  password: ${DEV_PASSWORD}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => base.$disconnect());
