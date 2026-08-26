/**
 * API response shapes.
 *
 * Copied verbatim from `web/lib/types.ts` for the types both clients consume.
 * `lib/types.drift.test.ts` fails the build if they diverge.
 *
 * WHY A COPY RATHER THAN A SHARED PACKAGE
 * ---------------------------------------
 * docs/technical-design.md §7 calls for a shared types package, and that is
 * still the right destination. Getting there needs npm workspaces plus Metro
 * `watchFolders` configuration to resolve a symlinked package — bundler config
 * that cannot be verified without running the app on real hardware. Shipping
 * an unverified Metro config into an app nobody has booted is a worse trade
 * than a duplicated file with an automated drift check.
 *
 * Extract this the first time the app runs on a device.
 */

export type UserRole =
  | 'ADMIN'
  | 'DOCTOR'
  | 'NURSE'
  | 'RECEPTIONIST'
  | 'PHARMACIST'
  | 'BILLING_STAFF';

export type AppointmentStatus =
  | 'SCHEDULED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';

export type DoseStatus = 'DUE' | 'GIVEN' | 'MISSED' | 'REFUSED' | 'WITHHELD';

export type DrugClass =
  | 'PENICILLIN' | 'CEPHALOSPORIN' | 'SULFONAMIDE' | 'MACROLIDE' | 'TETRACYCLINE'
  | 'QUINOLONE' | 'NSAID' | 'OPIOID' | 'STATIN' | 'ACE_INHIBITOR' | 'BETA_BLOCKER'
  | 'CALCIUM_CHANNEL_BLOCKER' | 'DIURETIC' | 'ANTICOAGULANT' | 'ANTIDIABETIC'
  | 'CORTICOSTEROID' | 'ANTIHISTAMINE' | 'BRONCHODILATOR' | 'OTHER';

export interface AuthUser {
  userId: number;
  email: string;
  /**
   * The signed-in hospital's name and display settings. Sent on every
   * authenticated request, so an admin changing the currency or timezone
   * takes effect on the next request rather than at the next login.
   */
  hospital: {
    name: string;
    slug: string;
    timezone: string;
    /** ISO 4217. Display only — nothing is converted. */
    currency: string;
  };
  fullName: string;
  /**
   * The role currently being acted as — exactly one, never a union.
   *
   * A user may hold several (an owner who is also the treating doctor), but
   * the session wears one at a time so that minimum-necessary access and the
   * audit trail both stay meaningful.
   */
  role: UserRole;
  /**
   * Every role this user holds, including the active one.
   *
   * Drives the role switcher. Sent by the server rather than inferred, because
   * the client must not be the thing that decides what someone may act as —
   * `POST /auth/switch-role` re-checks the assignment regardless.
   */
  availableRoles: UserRole[];
  doctorId?: number;
  /**
   * True after an admin created the account or reset the password. Re-read from
   * the server on every request, so a page reload cannot skip the change screen.
   */
  mustChangePassword: boolean;
}

export interface Allergy {
  id: number;
  substance: string;
  severity: AllergySeverity;
  notes: string | null;
}

export interface Patient {
  id: number;
  fullName: string;
  dob: string;
  age: number;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  phone: string | null;
  email: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  createdAt: string;
  bloodGroup?: string | null;
  allergies?: Allergy[];
}

export interface QueueItem {
  id: number;
  scheduledAt: string;
  status: AppointmentStatus;
  reason: string | null;
  patient: {
    id: number;
    fullName: string;
    age: number;
    gender: string;
    hasAllergies: boolean;
  };
}

export interface DoctorQueue {
  doctor: { id: number; fullName: string; specialization: string; department: string | null } | null;
  date: string;
  timezone: string;
  stats: {
    total: number;
    scheduled: number;
    waiting: number;
    inProgress: number;
    completed: number;
    noShow: number;
  };
  appointments: QueueItem[];
}

export interface MedicalRecord {
  id: number;
  visitDate: string;
  diagnosis: string;
  notes: string | null;
  doctor?: { id: number; fullName: string; specialization: string } | null;
}

export interface PrescriptionItem {
  id: number;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
}

export interface Prescription {
  id: number;
  issuedAt: string;
  status: 'ISSUED' | 'PARTIALLY_DISPENSED' | 'DISPENSED' | 'CANCELLED';
  dispensedAt: string | null;
  notes: string | null;
  items: PrescriptionItem[];
  doctor?: { id: number; fullName: string } | null;
  allergyWarnings?: { substance: string; severity: string; matchedMedicine: string }[];
}

export interface VitalFlag {
  field: string;
  value: number;
  level: 'normal' | 'high' | 'low' | 'critical';
  note: string;
}

export interface Vital {
  id: number;
  recordedAt: string;
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  temperatureC: string | null;
  respiratoryRate: number | null;
  spo2: number | null;
  painScore: number | null;
  notes: string | null;
  flags: VitalFlag[];
  recordedBy?: { id: number; fullName: string; role: string } | null;
}

export interface BedRow {
  bed: { id: number; label: string; isActive: boolean };
  admission: {
    id: number;
    admittedAt: string;
    reason: string | null;
    patient: { id: number; fullName: string; age: number; gender: string; hasAllergies: boolean };
    lastVital: { recordedAt: string; systolic: number | null; diastolic: number | null; pulse: number | null } | null;
    observationOverdue: boolean;
    nextDose: { id: number; dueAt: string; medicineName: string; dosage: string } | null;
  } | null;
}

export interface WardBoard {
  ward: { id: number; name: string; floor: string | null };
  stats: { beds: number; occupied: number; available: number; outOfService: number; observationsOverdue: number };
  beds: BedRow[];
}

export interface Dose {
  id: number;
  dueAt: string;
  status: DoseStatus;
  givenAt: string | null;
  givenBy: string | null;
  notes: string | null;
  medicineName: string;
  dosage: string;
  bed: string;
  admissionId: number;
  patient: { id: number; fullName: string; hasAllergies: boolean };
}

export interface MedicationRound {
  wardId: number;
  timezone: string;
  overdue: Dose[];
  dueNow: Dose[];
  upcoming: Dose[];
  completed: Dose[];
}

export interface Ward {
  id: number;
  name: string;
  floor: string | null;
}

export interface Medicine {
  id: number;
  name: string;
  form: string;
  strength: string;
  drugClass: DrugClass;
  isControlled: boolean;
  reorderLevel: number;
  isActive?: boolean;
}

export interface StockBatchView {
  id: number;
  batchNumber: string;
  expiresAt: string;
  quantity: number;
  expired: boolean;
}

export interface DispenseQueueItem {
  id: number;
  issuedAt: string;
  status: Prescription['status'];
  notes: string | null;
  patient: { id: number; fullName: string; hasAllergies: boolean };
  doctor: string | null;
  itemCount: number;
  hasUncataloguedItem: boolean;
}

export interface InventoryRow {
  id: number;
  name: string;
  form: string;
  strength: string;
  drugClass: DrugClass;
  isControlled: boolean;
  reorderLevel: number;
  inDateQuantity: number;
  expiredQuantity: number;
  belowReorderLevel: boolean;
  expiringSoon: StockBatchView[];
  batches: StockBatchView[];
}

export interface Inventory {
  data: InventoryRow[];
  stats: {
    medicines: number;
    belowReorderLevel: number;
    outOfStock: number;
    expiringSoon: number;
    hasExpiredStock: number;
  };
}

export interface AdminDashboard {
  generatedAt: string;
  timezone: string;
  appointments: {
    today: number;
    completedToday: number;
    lastSevenDays: number;
    noShowsLastSevenDays: number;
    noShowRate: number;
  };
  occupancy: { beds: number; occupied: number; available: number; percent: number };
  finance: { outstanding: string; collectedLastSevenDays: string; openInvoices: number };
  staff: { active: number; lockedOut: number; awaitingPasswordChange: number };
  security: { deniedRequestsLastDay: number };
  catalogue: { medicines: number };
}
