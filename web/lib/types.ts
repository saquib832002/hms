/**
 * Shapes returned by the API.
 *
 * Hand-written for Phase 1. These should be generated from the backend's
 * OpenAPI spec into a shared package before the mobile app arrives — two
 * clients maintaining their own idea of what a Patient is defeats the point
 * of the single-backend decision.
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

/**
 * Fields after `address` are optional because the API omits them for
 * non-clinical roles — the receptionist's response does not contain
 * `allergies` at all. Typing them as optional keeps that honest: the UI has
 * to handle their absence rather than assuming they are always there.
 */
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

export interface PatientListItem {
  id: number;
  fullName: string;
  dob: string;
  age: number;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  phone: string | null;
  hasAllergies?: boolean;
}

export interface Doctor {
  id: number;
  fullName: string;
  specialization: string;
  registrationNo?: string | null;
  department?: { id: number; name: string } | null;
  /**
   * What this doctor charges for a consultation, as a string in the hospital's
   * currency. `null` means no fee has been set — which is not the same as free,
   * and checkout refuses rather than billing zero.
   */
  consultationFee?: string | null;
}

export interface Appointment {
  id: number;
  scheduledAt: string;
  status: AppointmentStatus;
  reason: string | null;
  patientId: number;
  doctorId: number;
  patient?: { id: number; fullName: string; dob: string; gender: string; phone: string | null };
  doctor?: { id: number; fullName: string; specialization: string; consultationFee?: string | null };
  /**
   * Set once this consultation has been billed. Only the id: whether a charge
   * exists is administrative, what is on it is billing's business.
   */
  invoice?: { id: number } | null;
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

export interface Slot {
  time: string;
  /** Bookable: not taken and not already gone. */
  available: boolean;
  /** Decided by the server clock, so the picker agrees with what booking allows. */
  past: boolean;
}

export interface Availability {
  doctorId: number;
  date: string;
  timezone: string;
  slotMinutes: number;
  clinicStartHour: number;
  clinicEndHour: number;
  slots: Slot[];
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number };
}

export type DoseStatus = 'DUE' | 'GIVEN' | 'MISSED' | 'REFUSED' | 'WITHHELD';

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

export type DrugClass =
  | 'PENICILLIN' | 'CEPHALOSPORIN' | 'SULFONAMIDE' | 'MACROLIDE' | 'TETRACYCLINE'
  | 'QUINOLONE' | 'NSAID' | 'OPIOID' | 'STATIN' | 'ACE_INHIBITOR' | 'BETA_BLOCKER'
  | 'CALCIUM_CHANNEL_BLOCKER' | 'DIURETIC' | 'ANTICOAGULANT' | 'ANTIDIABETIC'
  | 'CORTICOSTEROID' | 'ANTIHISTAMINE' | 'BRONCHODILATOR' | 'OTHER';

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

export interface AllergyConflict {
  medicineName: string;
  substance: string;
  severity: AllergySeverity;
  matchedOn: 'class' | 'name';
  level: 'BLOCKING' | 'WARNING';
  message: string;
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

export interface DispenseItem {
  id: number;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  quantityDispensed: number;
  medicine: {
    id: number;
    name: string;
    form: string;
    strength: string;
    drugClass: DrugClass;
    isControlled: boolean;
  } | null;
  suggestedQuantity: number | null;
  outstandingQuantity: number | null;
  inDateStock: number;
  batches: StockBatchView[];
}

export interface DispensePreparation {
  id: number;
  issuedAt: string;
  status: Prescription['status'];
  notes: string | null;
  patient: { id: number; fullName: string; dob: string; allergies: Allergy[] };
  doctor: { id: number; fullName: string; registrationNo: string | null } | null;
  items: DispenseItem[];
  allergyConflicts: AllergyConflict[];
  uncataloguedItems: string[];
  requiresOverride: boolean;
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

export type PaymentMethod = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'INSURANCE' | 'OTHER';

export type AgingBucket = 'current' | 'd1to30' | 'd31to60' | 'd61to90' | 'over90';

/**
 * Every currency field is a string, deliberately.
 *
 * `"1250.00"`, never `1250.0`. A JSON number has been through float
 * representation by the time it lands here, and `parseFloat` on the way in
 * loses pennies that turn into reconciliation disputes. Format for display;
 * never do arithmetic on these in the client — the server sends `outstanding`
 * already computed for exactly that reason.
 */
export interface InvoiceLine {
  id: number;
  description: string;
  amount: string;
}

export interface PaymentRecord {
  id: number;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: string;
  receivedBy: string | null;
}

export interface Invoice {
  id: number;
  patient: { id: number; fullName: string } | null;
  issuedAt: string;
  dueDate: string | null;
  status: 'PENDING' | 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'CANCELLED';
  notes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  totalAmount: string;
  amountPaid: string;
  outstanding: string;
  settled: boolean;
  daysOverdue: number;
  agingBucket: AgingBucket;
  items: InvoiceLine[];
  payments: PaymentRecord[];
}

export interface PaymentListItem {
  id: number;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  receivedAt: string;
  receivedBy: string | null;
  invoiceId: number;
  patient: { id: number; fullName: string } | null;
}

export interface AgingReport {
  buckets: Record<AgingBucket, { label: string; count: number; amount: string }>;
  totalOutstanding: string;
  totalOverdue: string;
}

export interface StaffUser {
  id: number;
  email: string;
  fullName: string;
  /** Where they land at sign-in. Always one of `roles`. */
  role: UserRole;
  /** Every role they may act as — one at a time. */
  roles: UserRole[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  doctor: { id: number; specialization: string; department: string | null } | null;
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
  staff: {
    active: number;
    lockedOut: number;
    awaitingPasswordChange: number;
    doctors: number;
    /** Doctors with no consultation fee — reception's checkout refuses for these. */
    doctorsWithoutFee: number;
  };
  security: { deniedRequestsLastDay: number };
  catalogue: { medicines: number };
}

/**
 * Takings and debts.
 *
 * Every `collected` figure comes from payment rows, not invoices — "what did we
 * take today" is a question about when money arrived, not when it was charged.
 * `aging` is the only part derived from invoices, because what is *owed*
 * genuinely is invoice-shaped.
 */
export interface FinanceReport {
  generatedAt: string;
  timezone: string;
  collected: {
    today: string;
    thisMonth: string;
    paymentsToday: number;
    paymentsThisMonth: number;
  };
  monthly: { month: string; label: string; collected: string; payments: number }[];
  methods: {
    method: string;
    today: { amount: string; count: number };
    month: { amount: string; count: number };
  }[];
  aging: AgingReport;
}

export interface DoctorReportRow {
  id: number;
  fullName: string;
  specialization: string;
  department: string | null;
  /** Null means unpriced, which is not the same as free. */
  consultationFee: string | null;
  today: { booked: number; completed: number; noShow: number };
  lastSevenDays: { booked: number; completed: number; noShow: number };
  revenueThisMonth: { billed: string; collected: string };
}

export interface DoctorReport {
  generatedAt: string;
  timezone: string;
  total: number;
  withoutFee: number;
  doctors: DoctorReportRow[];
}

/**
 * One consultation, as an owner sees it.
 *
 * Attendance and money — who came, when, whether they turned up, what they
 * were charged, whether they paid. Deliberately not the appointment reason, not
 * what was prescribed, not a diagnosis. `prescriptionIssued` is a boolean
 * because *that* a prescription exists is operational, while what is in it
 * names a condition.
 */
export interface LedgerRow {
  id: number;
  scheduledAt: string;
  status: AppointmentStatus;
  patient: { id: number; fullName: string };
  doctor: { id: number; fullName: string };
  invoice: {
    id: number;
    total: string;
    paid: string;
    outstanding: string;
    settled: boolean;
  } | null;
  prescriptionIssued: boolean;
}

export interface ConsultationLedger {
  date: string;
  timezone: string;
  total: number;
  appointments: LedgerRow[];
}

/**
 * One row of the audit trail.
 *
 * `targetId` is a raw record id and stays that way. Resolving it to a patient
 * name is the one thing no admin endpoint does — the trail proves *that* a
 * record was touched without becoming a way to browse records.
 */
export interface AuditRow {
  id: number;
  createdAt: string;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  method: string | null;
  targetType: string | null;
  targetId: number | null;
  outcome: 'SUCCESS' | 'FAILURE';
  statusCode: number | null;
  ipAddress: string | null;
  user: { id: number; fullName: string; email: string; role: string } | null;
}

/**
 * One day's work, per member of staff.
 *
 * Counts and money only. There is deliberately no patient here — an
 * administrator who needs named patients switches to a clinical role they hold
 * and looks as that role, so the audit log records which hat was worn.
 */
export interface StaffActivityReport {
  date: string;
  timezone: string;
  generatedAt: string;
  doctors: {
    userId: number;
    /** The doctor-profile id, not the user id. The ledger filters on this. */
    doctorId: number;
    fullName: string;
    specialization: string;
    consultations: { booked: number; completed: number; noShow: number };
    revenue: { billed: string; collected: string };
  }[];
  reception: {
    userId: number;
    fullName: string;
    registrations: number;
    bookings: number;
    /**
     * Check-ins, cancellations and reschedules together.
     *
     * The audit log records that an appointment's status changed, not what it
     * changed *to*, so these cannot be split without recording the new status
     * on the audit row.
     */
    updates: number;
    invoicesRaised: number;
  }[];
  billing: {
    userId: number;
    fullName: string;
    total: string;
    count: number;
    methods: { method: string; amount: string }[];
  }[];
  pharmacy: {
    userId: number;
    fullName: string;
    dispensed: number;
    prepared: number;
    stockReceived: number;
  }[];
  nursing: {
    userId: number;
    fullName: string;
    vitals: number;
    doses: number;
    admissions: number;
  }[];
}

export interface ActivityReport {
  windowDays: number;
  since: string;
  totalActions: number;
  byRole: { role: string; total: number; denied: number }[];
  topActions: { action: string; count: number }[];
}

export interface StaffReport {
  roles: { role: UserRole; total: number; active: number; dormant: number }[];
  totalActive: number;
}

export interface DepartmentRow {
  id: number;
  name: string;
  doctorCount: number;
  doctors: { id: number; fullName: string; specialization: string }[];
}
