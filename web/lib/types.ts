/**
 * Shapes returned by the API.
 *
 * Hand-written for Phase 1. These should be generated from the backend's
 * OpenAPI spec into a shared package before the mobile app arrives — two
 * clients maintaining their own idea of what a Patient is defeats the point
 * of the single-backend decision.
 */


/**
 * A part of the product a hospital has been sold.
 *
 * Not a role: roles say what a *person* may do inside a hospital that has the
 * feature; this says whether the hospital has it. An administrator grants
 * roles, only the provider grants modules.
 *
 * The menus are built from these. Enforcement is server-side — `ModuleGuard`
 * refuses writes and never a read, so a hospital whose lab module is removed
 * can still open results it already has.
 */
export type TenantModule = 'CLINIC' | 'WARDS' | 'PHARMACY' | 'LABORATORY' | 'BILLING';

export type UserRole =
  | 'ADMIN'
  | 'DOCTOR'
  | 'NURSE'
  | 'RECEPTIONIST'
  | 'PHARMACIST'
  | 'BILLING_STAFF'
  /** Runs the diagnostic lab: receives specimens, results and authorises. */
  | 'LAB_TECHNICIAN';

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
    /** What this hospital has been sold. Drives the menu; see `TenantModule`. */
    modules: TenantModule[];
    /** ISO 4217. Display only — nothing is converted. */
    currency: string;
    /**
     * Where the hospital stands with the provider.
     *
     * A lapsed subscription blocks writes and never blocks a read or a login,
     * so a client's job here is to warn before that happens and to explain it
     * clearly when it has. See `common/subscription/subscription.ts`.
     */
    subscriptionStatus: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
    subscriptionEndsAt: string | null;
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
  /**
   * How many units the prescriber ordered, or null if they left it open.
   *
   * Null is meaningful — an as-needed or ongoing course has no fixed total and
   * the pharmacist settles it. What it must never mean is "the system could not
   * read the duration", which is what decided completion before this field
   * existed and left fully dispensed prescriptions stuck at
   * PARTIALLY_DISPENSED.
   */
  quantityPrescribed?: number | null;
  /** Running total handed over, in the same units. */
  quantityDispensed?: number;
}

/**
 * One line this doctor writes often, ready to reuse.
 *
 * Their own past prescriptions ranked by frequency — never a suggestion of
 * something they have not used. Recall, not advice.
 */
export interface PrescribingShortcut {
  medicineName: string;
  medicineId: number | null;
  dosage: string;
  frequency: string;
  duration: string;
  timesPrescribed: number;
  lastUsedAt: string;
}

export interface PrescribingHistory {
  shortcuts: PrescribingShortcut[];
  /** This doctor's own shorthand, most used first. */
  frequencies: string[];
  durations: string[];
}

/**
 * Where a prescription or a test order went, and what came back.
 *
 * `destination` and `routedToTenantId` were on the row from the day routing
 * shipped and reached no clinical screen, so a history could not tell a
 * prescription sent to a partner from one filled downstairs.
 *
 * `fulfilmentUnknown` is the honest half. A lab referral has a return leg and
 * so `reportedAt` is a fact; a prescription referral is one-way by design, so
 * this hospital cannot learn whether the patient collected. A blank timestamp
 * would read as "nothing happened", which is the wrong reading.
 */
export interface RoutingTrail {
  destination: string;
  partnerName: string | null;
  sentAt: string;
  reportedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  fulfilmentUnknown: boolean;
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
  /** Present on a patient's history. Absent on the create response. */
  routing?: RoutingTrail;
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
    observationFrequency: ObservationFrequency;
    nextObservationDue: string | null;
    openEscalations: number;
    nextDose: { id: number; dueAt: string; medicineName: string; dosage: string } | null;
  } | null;
}

export interface WardBoard {
  ward: { id: number; name: string; floor: string | null };
  stats: { beds: number; occupied: number; available: number; outOfService: number; observationsOverdue: number };
  beds: BedRow[];
}

/**
 * One medicine on a patient's drug chart, with every dose of it this stay.
 *
 * `notScheduledReason` and `asNeeded` are the two fields that matter most and
 * are easy to conflate. A medicine with no doses is either one the frequency
 * parser could not read — which wants a nurse to set times — or an as-needed
 * one, which must never be given times and instead wants a dose recorded when
 * it is actually given. Same empty chart row, opposite correct actions.
 */
export interface ChartMedicine {
  prescriptionItemId: number;
  prescriptionId: number;
  issuedAt: string;
  prescriber: string | null;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  scheduleLabel: string | null;
  notScheduledReason: string | null;
  asNeeded: boolean;
  doses: {
    id: number;
    dueAt: string;
    status: DoseStatus;
    givenAt: string | null;
    givenBy: string | null;
    notes: string | null;
  }[];
}

/** The MAR for one stay. */
export interface MedicationChart {
  admission: {
    id: number;
    admittedAt: string;
    status: string;
    bed: string | null;
    ward: string | null;
  };
  patient: {
    id: number;
    fullName: string;
    age: number;
    /*
     * The substances, not a flag. The ward board shows a dot because it lists
     * many patients; this is the screen where a nurse is about to give a drug,
     * and "has allergies" without saying to what is the least useful form of
     * that warning at the moment it matters.
     */
    allergies: string[];
  };
  timezone: string;
  medicines: ChartMedicine[];
}

/** A ward asking the pharmacy to send stock of something already prescribed. */
export interface SupplyRequest {
  id: number;
  status: 'REQUESTED' | 'SUPPLIED' | 'DECLINED';
  quantity: number | null;
  note: string | null;
  requestedAt: string;
  requestedBy: { fullName: string } | null;
  respondedAt: string | null;
  respondedBy: { fullName: string } | null;
  responseNote: string | null;
  prescriptionItem: {
    id: number;
    medicineName: string;
    dosage: string;
    frequency: string;
    medicineId: number | null;
  };
  admission: {
    id: number;
    bed: { label: string; ward: { name: string } } | null;
    patient: { id: number; fullName: string };
  };
}

/**
 * A nurse asking a doctor to prescribe something not on the chart.
 *
 * `medicineText` is free text rather than a catalogue id, because the nurse is
 * describing a need and not selecting a product. A picker here would quietly
 * turn the request into a draft prescription with the nurse's name on it.
 */
export interface MedicationRequest {
  id: number;
  status: 'REQUESTED' | 'PRESCRIBED' | 'DECLINED';
  medicineText: string;
  reason: string;
  requestedAt: string;
  requestedBy: { fullName: string } | null;
  respondedAt: string | null;
  respondedBy: { fullName: string } | null;
  responseNote: string | null;
  prescriptionId: number | null;
  admission: {
    id: number;
    bed: { label: string; ward: { name: string } } | null;
    patient: { id: number; fullName: string; allergies: { substance: string }[] };
  };
}

export type ObservationFrequency =
  | 'QUARTER_HOURLY' | 'HALF_HOURLY' | 'HOURLY' | 'TWO_HOURLY'
  | 'FOUR_HOURLY' | 'SIX_HOURLY' | 'TWELVE_HOURLY' | 'DAILY';

/**
 * How often this patient's observations are due, and who decided.
 *
 * `isExplicit` false means nobody has set one and this is the system default —
 * a distinction worth keeping, because "the doctor wants 4-hourly" and "nobody
 * has thought about it" look identical on a screen and mean different things.
 */
export interface ObservationOrder {
  frequency: ObservationFrequency;
  label: string;
  intervalMinutes: number;
  isExplicit: boolean;
  reason: string | null;
  isEscalation: boolean;
  setBy: string | null;
  setAt: string | null;
}

/** A nurse raising a concern, and what came back. Null response = still open. */
export interface ObservationEscalation {
  id: number;
  escalatedTo: string;
  concern: string;
  raisedAt: string;
  raisedBy: { fullName: string } | null;
  response: string | null;
  respondedAt: string | null;
  vital: { id: number; recordedAt: string } | null;
}

/** Everything the observation screen needs for one admission, in one read. */
export interface ObservationSummary {
  admission: { id: number; admittedAt: string; bed: string | null; ward: string | null };
  patient: { id: number; fullName: string };
  order: ObservationOrder;
  lastObservedAt: string | null;
  nextDueAt: string | null;
  overdue: boolean;
  /** No observations at all — counted as overdue, and the case that matters. */
  neverObserved: boolean;
  escalations: ObservationEscalation[];
  openEscalations: number;
}

/**
 * What a hospital prints at the top of anything a patient carries away.
 *
 * `name` is read-only from the client's point of view — it is set when the
 * vendor provisions the hospital, and the letterhead screen shows it rather
 * than offering it for edit.
 */
export interface Letterhead {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  website: string | null;
  registrationNo: string | null;
  footerText: string | null;
  /** `data:image/png;base64,...`, or null when none has been uploaded. */
  logoDataUrl: string | null;
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

/**
 * A ward as the setup screen sees it: its beds, and whether each is in use.
 *
 * `occupied` is a boolean and never a patient. This is an administrator's
 * screen, and admin is operational rather than clinical — bed occupancy is a
 * number, "B-04 holds Mrs Shah" is not. The ward board that does name patients
 * excludes ADMIN outright.
 */
export interface WardSetupRow {
  id: number;
  name: string;
  floor: string | null;
  beds: { id: number; label: string; isActive: boolean; occupied: boolean }[];
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
  /**
   * Per unit, up to four decimal places, as a string.
   *
   * `null` means nobody has priced it — which is not the same as free. An
   * unpriced medicine is still dispensed and still leaves stock; it is simply
   * not charged for, and that is reported rather than hidden.
   */
  sellingPrice: string | null;
  /**
   * Which tax rate this medicine carries, or null for the hospital's default.
   *
   * Null is deliberately NOT "untaxed": a catalogue nobody has been through
   * must not silently become zero-rated the day tax is switched on. To make
   * something genuinely untaxed, point it at a 0% rate — which is why rates
   * are named, since "Exempt" and "Zero-rated" differ on a statutory invoice
   * and are identical to the arithmetic.
   */
  taxRateId?: number | null;
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
  /**
   * What the prescriber ordered. Distinct from `suggestedQuantity`, which is
   * what the system *reads* out of the free-text course — "the doctor ordered
   * 21" and "we think a 7-day course is 21" are different claims and the sheet
   * says which it is showing.
   */
  quantityPrescribed: number | null;
  suggestedQuantity: number | null;
  outstandingQuantity: number | null;
  /**
   * `complete` — enough has gone out. `outstanding` — some is still owed.
   * `unknown` — no fixed total, so only the pharmacist can say it is finished.
   *
   * `unknown` used to be treated silently as "not finished", which is how a
   * fully dispensed prescription stayed partially dispensed forever.
   */
  completion: 'complete' | 'outstanding' | 'unknown';
  inDateStock: number;
  batches: StockBatchView[];
  /** Per unit, or null when unpriced. See `Medicine.sellingPrice`. */
  unitPrice: string | null;
  /**
   * The rate that will be applied when this is dispensed, already resolved
   * against the hospital's default. Zero when tax is off, which is most
   * hospitals — the screens then show no tax row at all.
   */
  taxRateBasisPoints?: number;
  taxRateName?: string | null;
  /**
   * The parts of that rate — CGST 6% + SGST 6%. Empty for a flat rate.
   *
   * Sent so a screen can preview the same rows the invoice will print. They
   * SUM to `taxRateBasisPoints`; they are never compounded.
   */
  taxComponents?: { name: string; rateBasisPoints: number }[];
}

export interface DispensePreparation {
  /**
   * Whether the prices on these lines already contain tax.
   *
   * Sent with the sheet rather than fetched from clinic settings, which a
   * pharmacist cannot read. It decides whether the preview adds tax on top or
   * carves it out — the two give different totals for the same price.
   */
  pricesIncludeTax: boolean;
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
  /** Per unit, or null when unpriced. See `Medicine.sellingPrice`. */
  sellingPrice: string | null;
  /**
   * The rate that will apply at the till, already resolved against the
   * hospital's default. Zero when the hospital charges no tax.
   */
  taxRateBasisPoints?: number;
  taxRateName?: string | null;
  /**
   * The parts of that rate — CGST 6% + SGST 6%. Empty for a flat rate.
   *
   * Sent so a screen can preview the same rows the invoice will print. They
   * SUM to `taxRateBasisPoints`; they are never compounded.
   */
  taxComponents?: { name: string; rateBasisPoints: number }[];
  /**
   * Soonest date any *sellable* unit goes out of date, or null if none is.
   *
   * In-date batches with stock only — an expired batch cannot be sold, so
   * counting it would head a "shift this first" list with stock that has to be
   * destroyed.
   */
  earliestExpiry: string | null;
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
  /**
   * Null on a rolled-up medicine summary.
   *
   * Billing staff see medicine lines collapsed into one total, and that summary
   * is not a row anybody can fetch or act on — giving it the id of a line it
   * replaced would let a client ask for that line directly and walk past the
   * collapse.
   */
  id: number | null;
  description: string;
  /** NET of tax. `taxAmount` completes it. */
  amount: string;
  taxAmount: string;
  taxRateBasisPoints: number;
  /** e.g. "GST 12%", captured at billing so a renamed rate cannot rewrite it. */
  taxRateName: string | null;
  /** The split as applied, summing exactly to `taxAmount`. Null if flat. */
  taxBreakdown: { name: string; rateBasisPoints: number; amount: string }[] | null;
  kind: 'SERVICE' | 'MEDICINE';
  /** Set on itemised medicine lines only. */
  quantity: number | null;
  unitPrice: string | null;
  medicineId: number | null;
}

export interface PaymentRecord {
  id: number;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: string;
  receivedBy: string | null;
}

/**
 * Money going back out.
 *
 * Listed beside payments, never subtracted from them. An invoice that took
 * 120.00 and gave 120.00 back is not the same as one never paid, and a screen
 * showing only the net cannot tell you which you are looking at.
 */
export interface RefundRecord {
  id: number;
  amount: string;
  method: PaymentMethod;
  reason: string;
  /** The payment reversed, where one was identifiable. */
  paymentId: number | null;
  refundedAt: string;
  refundedBy: string | null;
}

export interface Invoice {
  id: number;
  patient: { id: number; fullName: string } | null;
  /**
   * Who owes it, when that is not a patient.
   *
   * Referred lab work is billed to the hospital that sent it — "Referred by
   * St Mary's". Without this a till shows "No patient" against every such row,
   * which reads as missing data rather than a debt belonging to a company.
   */
  payer?: string | null;
  /**
   * The laboratory order numbers this invoice charges for.
   *
   * On the invoice rather than only inside its lines, so a till showing forty
   * rows can say which order each is for without opening every one. An
   * accession is an opaque key — no analyte, no discipline, no patient — which
   * is why it may sit here for every role that can see the invoice at all.
   */
  labAccessions?: string[];
  issuedAt: string;
  dueDate: string | null;
  status: 'PENDING' | 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'CANCELLED';
  notes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  totalAmount: string;
  /** Cancelled by credit note. Zero on almost every invoice. */
  creditedAmount: string;
  /** What is actually chargeable now — total less any credit. */
  chargeable: string;
  amountPaid: string;
  outstanding: string;
  settled: boolean;
  daysOverdue: number;
  agingBucket: AgingBucket;
  /** Whose bill this is. Sent so a client labels it rather than inferring it. */
  kind: 'HOSPITAL' | 'PHARMACY';
  items: InvoiceLine[];
  payments: PaymentRecord[];
  refunds: RefundRecord[];
  /**
   * Tax across the whole invoice, summed from its lines.
   *
   * "0.00" for every hospital that charges no tax, which is most — the screens
   * omit the row entirely rather than printing a zero on every bill.
   */
  taxTotal: string;

  /**
   * The tax rows to print on the bill, one per named component.
   *
   * CGST 6% and SGST 6% appear separately, because an Indian statutory invoice
   * is invalid showing only a combined "GST 12.00" — and a US receipt needs
   * state, county and city for the same reason. A flat rate produces a single
   * row under its own name rather than a bare "Tax".
   *
   * These sum exactly to `taxTotal`: they are aggregated from the amounts each
   * line already captured, not recomputed from the totals.
   */
  taxSummary: { name: string; rateBasisPoints: number; label: string; amount: string }[];
}

/** What a sale cost, reported back after dispensing or a counter sale. */
export interface SaleCharge {
  invoiceId: number | null;
  /**
   * When the tube left for the partner laboratory.
   *
   * Only ever set on a PARTNER order. Null on one means it is still here — to
   * be drawn, or drawn and waiting for the courier — which is exactly what the
   * send-out list is for.
   */
  dispatchedAt: string | null;
  total: string;
  /**
   * Medicines handed over with no price set, so charged nothing.
   *
   * Named rather than counted, because the pharmacist can still act on it while
   * the customer is standing there.
   */
  unpriced: string[];
}

export interface CounterSaleLine {
  medicineId: number;
  quantity: number;
}

/**
 * One movement of money, in or out.
 *
 * Payments and refunds share this shape because they share a ledger — a list
 * that showed only money coming in could not answer "what happened to that
 * payment", which is the main reason anybody opens it.
 *
 * `amount` is always the magnitude, as stored. `signedAmount` is negative for a
 * refund and is computed by the server, so no client has to remember which
 * direction a row points and two screens cannot disagree about a day's total.
 */
export interface PaymentListItem {
  id: number;
  kind: 'PAYMENT' | 'REFUND';
  /** Magnitude, always positive. */
  amount: string;
  /** Negative for a refund. Sum these for a net figure. */
  signedAmount: string;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  /** When the money moved. For a refund, when it was issued. */
  receivedAt: string;
  receivedBy: string | null;
  invoiceId: number;
  patient: { id: number; fullName: string } | null;
  /**
   * Who owes it, when that is not a patient.
   *
   * Referred lab work is billed to the hospital that sent it — "Referred by
   * St Mary's". Without this a till shows "No patient" against every such row,
   * which reads as missing data rather than a debt belonging to a company.
   */
  payer?: string | null;
  /**
   * The laboratory order numbers this invoice charges for.
   *
   * On the invoice rather than only inside its lines, so a till showing forty
   * rows can say which order each is for without opening every one. An
   * accession is an opaque key — no analyte, no discipline, no patient — which
   * is why it may sit here for every role that can see the invoice at all.
   */
  labAccessions?: string[];
  /** For a refund: the payment it reverses, where one was identified. */
  reversesPaymentId: number | null;
  /** For a refund: why the money went back. */
  reason: string | null;
  /**
   * For a payment: how much of it has already been handed back.
   *
   * Only refunds that named this payment count — an invoice-level refund has
   * nothing to attribute it to. Sent so no client has to work it out, and so
   * none offers to reverse something already fully reversed.
   */
  refundedAmount: string;
  /** For a payment: nothing of it is left to give back. */
  fullyRefunded: boolean;
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
  finance: {
    outstanding: string;
    collectedLastSevenDays: string;
    refundedLastSevenDays: string;
    /** Lead with this one. See `FinanceReport.net`. */
    netLastSevenDays: string;
    openInvoices: number;
  };
  staff: {
    active: number;
    lockedOut: number;
    awaitingPasswordChange: number;
    doctors: number;
    /** Doctors with no consultation fee — reception's checkout refuses for these. */
    doctorsWithoutFee: number;
  };
  security: { deniedRequestsLastDay: number };
  /** `withoutPrice` is blank rather than zero — nobody has priced them. */
  catalogue: { medicines: number; withoutPrice: number };
  /**
   * The hospital's own trade, for the parts of the product it bought.
   *
   * Always present in the response and rendered only where the module is. A
   * pharmacy-only tenant read appointments, beds and doctors — all zero — and
   * nothing about the shop it actually runs.
   */
  pharmacy: { dispensesToday: number; reversalsToday: number; unpricedSalesToday: number };
  laboratory: {
    ordersToday: number;
    awaitingCollection: number;
    onTheBench: number;
    awaitingAuthorisation: number;
  };
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
  /**
   * Gross in, gross out, net derived — all three, never one that hides the
   * others.
   *
   * A screen should lead with `net`, because that is the figure the payments
   * ledger shows and two screens disagreeing about one day makes both
   * unusable. The gross pair stays because reconciling against a bank
   * statement needs it: a day that took 5,000 and refunded 500 is not the same
   * day as one that took 4,500.
   */
  collected: {
    today: string;
    thisMonth: string;
    paymentsToday: number;
    paymentsThisMonth: number;
  };
  refunded: {
    today: string;
    thisMonth: string;
    refundsToday: number;
    refundsThisMonth: number;
  };
  net: { today: string; thisMonth: string };
  monthly: { month: string; label: string; collected: string; payments: number }[];
  monthlyRefunds: { month: string; label: string; collected: string; payments: number }[];
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
    /** Gross taken. */
    total: string;
    /** Gross given back, attributed to whoever issued it. */
    refunded: string;
    /** What the hospital kept. The figure that agrees with billing's ledger. */
    net: string;
    count: number;
    refunds: number;
    /** Gross by method — a refund does not remove a card payment from a batch. */
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

/** Where a prescription is meant to be filled. A routing note, not a gate. */
export type PrescriptionDestination = 'IN_HOUSE' | 'EXTERNAL' | 'PARTNER';

/**
 * A pharmacy at another hospital this one may send to.
 *
 * Added by an administrator using a code the pharmacy gives them offline —
 * there is deliberately no browsable list of tenants, because that list is the
 * provider's customer base.
 */
export interface PharmacyPartner {
  id: number;
  label: string;
  partnerTenantId: number;
  createdAt: string;
}

/**
 * A prescription written at another hospital and transmitted here.
 *
 * A copy, not a view of their row: the whole design transmits a snapshot into
 * the receiving tenant so no cross-tenant policy exception is needed.
 */
export interface PrescriptionReferral {
  id: number;
  /** What the patient quotes at the counter. */
  reference: string;
  from: string;
  patientName: string;
  patientDob: string | null;
  prescriberName: string;
  prescriberRegistrationNo: string | null;
  issuedAt: string;
  createdAt: string;
  /**
   * The line as the doctor wrote it, plus what it works out to.
   *
   * The computed fields come from the server (`dispense-quantity.ts`) rather
   * than being derived here: two implementations of "twice a day for a week
   * is fourteen" is two chances to disagree, on a number somebody counts
   * tablets against.
   *
   * `totalUnits` is null when the dosage is a strength rather than a count —
   * "500mg" says nothing about how many capsules make a dose. `totalDoses` is
   * still exact in that case. Both null means it could not be worked out, and
   * `whyNot` says so, because a blank and a considered refusal look the same.
   */
  items: {
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    frequencyLabel: string;
    durationLabel: string | null;
    totalDoses: number | null;
    totalUnits: { amount: number; unit: string } | null;
    whyNot: string | null;
    interpretation: string | null;
  }[];
  /**
   * Always false, and said rather than implied.
   *
   * The sending hospital does not transmit allergies, so this pharmacy has
   * nothing to check against. An empty warning list would read as "nothing
   * found"; this says "nothing was looked at".
   */
  allergyChecked: false;

  /**
   * What happened to it. Both null means still waiting.
   *
   * Sent explicitly rather than inferred from which list it came back in: a
   * history entry that does not say what happened is just an older copy of
   * the queue, and "declined, out of stock" has to read differently from
   * "dispensed" and from "still waiting".
   */
  dispensedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
}

/**
 * A tax rate this hospital charges.
 *
 * `rateBasisPoints` is the number of hundredths of a percent — 1250 is 12.5%.
 * An integer for the same reason money is held in minor units. `label` is
 * pre-formatted by the server so the two clients cannot disagree about how
 * "8.25%" is written.
 */
export interface TaxRate {
  id: number;
  name: string;
  rateBasisPoints: number;
  label: string;
  isDefault: boolean;
  /**
   * The parts this rate is made of — CGST 6% + SGST 6%, or state + county +
   * city. They SUM to `rateBasisPoints`; they are never compounded, because
   * both are charged on the same taxable value.
   *
   * Empty for a flat rate, which is the ordinary case.
   */
  components: { name: string; rateBasisPoints: number; label: string }[];
}


/**
 * What the pharmacy sold, took and gave back, over three windows.
 *
 * Every figure is gross with its reversal beside it, and `net` is derived —
 * "sales minus refunds" as a single number is the one nobody can reconcile
 * against a till.
 */
export interface PharmacyDashboard {
  periods: {
    period: 'today' | 'week' | 'month';
    sales: number;
    /** Handovers with no invoice: nothing on them had a price. */
    unpricedSales: number;
    /** Counted apart from sales — a reversal means the medicine never left. */
    reversals: number;
    billed: string;
    tax: string;
    collected: string;
    refunded: string;
    /** `collected − refunded`. The headline. */
    net: string;
  }[];
  /** Unpaid at this counter, all time — not windowed. */
  outstanding: string;
}

// ───────────────────────────── diagnostics ─────────────────────────────

export type LabCategory =
  | 'HAEMATOLOGY'
  | 'BIOCHEMISTRY'
  | 'MICROBIOLOGY'
  | 'SEROLOGY'
  | 'HISTOPATHOLOGY'
  | 'IMAGING'
  | 'OTHER';

/** NONE is what makes imaging fit: an X-ray needs no specimen to collect. */
export type LabSpecimenType =
  | 'BLOOD'
  | 'URINE'
  | 'STOOL'
  | 'SWAB'
  | 'SPUTUM'
  | 'TISSUE'
  | 'FLUID'
  | 'NONE';

export type LabPriority = 'ROUTINE' | 'URGENT' | 'STAT';

export type LabOrderDestination = 'IN_HOUSE' | 'EXTERNAL' | 'PARTNER';

/**
 * REJECTED is not CANCELLED. A rejected specimen means somebody has to take
 * blood from the patient again; collapsing the two turns "we need another
 * sample" into "never mind".
 */
export type LabOrderStatus =
  | 'ORDERED'
  | 'COLLECTED'
  | 'IN_PROGRESS'
  | 'RESULTED'
  | 'VERIFIED'
  | 'CANCELLED'
  | 'REJECTED';

/**
 * UNKNOWN is never NORMAL. "Compared and found unremarkable" and "there was
 * nothing to compare against" render identically if you collapse them and mean
 * opposite things.
 */
export type LabResultFlag =
  | 'NORMAL'
  | 'LOW'
  | 'HIGH'
  | 'ABNORMAL'
  | 'CRITICAL_LOW'
  | 'CRITICAL_HIGH'
  | 'UNKNOWN';

/** One measured component of a test, and the range it is judged against. */
export interface LabAnalyte {
  id: number;
  name: string;
  unit: string | null;
  refLow: string | null;
  refHigh: string | null;
  refText: string | null;
  criticalLow: string | null;
  criticalHigh: string | null;
  position: number;
  /** Pre-formatted server-side so every client prints the range identically. */
  display: string | null;
}

/**
 * A test in the hospital's catalogue.
 *
 * `sellingPrice` is null when nobody has priced it — which is not zero. The
 * test is still performed and simply not charged for, and the screens say so.
 */
export interface LabTest {
  id: number;
  code: string;
  name: string;
  category: LabCategory;
  specimenType: LabSpecimenType;
  sellingPrice: string | null;
  taxRateId: number | null;
  turnaroundHours: number | null;
  preparation: string | null;
  isActive: boolean;
  analytes: LabAnalyte[];
}

export interface LabResultValue {
  id: number;
  analyteName: string;
  unit: string | null;
  /** Text, always: "<0.01" and "No growth" are real laboratory results. */
  value: string;
  referenceRange: string | null;
  flag: LabResultFlag;
  abnormal: boolean;
  critical: boolean;
}

export interface LabOrderItem {
  id: number;
  testCode: string;
  testName: string;
  category: LabCategory;
  specimenType: LabSpecimenType;
  /**
   * This hospital raised no charge for it, because whoever runs the test is
   * billing the patient directly.
   *
   * **Not the same as unpriced**, and a screen must never render the two the
   * same way. An unpriced test is money nobody collected; this one is money
   * somebody else is collecting, and merging them makes every "went out
   * uncharged" figure permanently wrong.
   */
  payableExternally: boolean;
  resultedAt: string | null;
  performedByName: string | null;
  criticalNotifiedAt: string | null;
  criticalNotifiedTo: string | null;
  findings: string | null;
  impression: string | null;
  methodology: string | null;
  values: LabResultValue[];
}

/**
 * An order as a clinician sees it.
 *
 * `resultsAuthorised` is sent explicitly rather than left to be inferred from
 * an empty `values` array. An unverified result and a test that found nothing
 * render identically otherwise, and that is the most dangerous available
 * misreading.
 */
export interface LabOrder {
  id: number;
  status: LabOrderStatus;
  priority: LabPriority;
  destination: LabOrderDestination;
  orderedAt: string;
  collectedAt: string | null;
  verifiedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  clinicalDetails: string | null;
  requestedBy: string;
  /**
   * The number on the tube — what a scanner reads and what a technician says
   * out loud. Null only for orders raised before accessions existed.
   */
  accession: string | null;
  resultsAuthorised: boolean;
  items: LabOrderItem[];
  patient?: { id: number; fullName: string; dob: string; gender: string };
  verifiedByName?: string | null;
  /** Present on a patient's history. Absent on the worklist. */
  routing?: RoutingTrail;
}

/** One row on the lab's own worklist. */
export interface LabWorklistRow {
  id: number;
  /**
   * The charge for this order, and whether anything is still owed.
   *
   * On the worklist because the person drawing the blood is standing in front
   * of the patient, which is the only moment the money is easy to collect.
   * `invoiceId` alone said an invoice existed and not whether it was settled —
   * which is the half that decides whether to ask.
   *
   * **A link, never a gate.** Nothing in collection, dispatch or resulting
   * reads it; the tube is drawn either way.
   */
  invoice: {
    id: number;
    status: 'PENDING' | 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'CANCELLED';
    /** Charge minus credits minus payments. Never `total - paid`. */
    outstanding: string;
    settled: boolean;
  } | null;
  /** Where it is being performed — the send-out list is the PARTNER rows. */
  destination: LabOrderDestination;
  /**
   * When the tube left for the partner laboratory.
   *
   * Only ever set on a PARTNER order. Null on one means it is still here — to
   * be drawn, or drawn and waiting for the courier — which is exactly what the
   * send-out list is for.
   */
  dispatchedAt: string | null;
  /**
   * The charge raised for it, or null when none was.
   *
   * Null is the state nobody could get out of: every line unpriced means no
   * invoice, and the price is captured at ordering, so pricing the catalogue
   * afterwards fixed the next order and not this one. The worklist offers
   * *Raise charge* on exactly these rows.
   */
  invoiceId: number | null;
  /**
   * The number on the tube. What the scan box on the worklist matches, and
   * what a technician reads off a rack without opening anything.
   */
  accession: string | null;
  status: LabOrderStatus;
  priority: LabPriority;
  orderedAt: string;
  collectedAt: string | null;
  rejectReason: string | null;
  clinicalDetails: string | null;
  /** Age and sex are not decoration: reference ranges are banded by both. */
  patient: { id: number; fullName: string; dob: string; gender: string };
  requestedBy: string;
  /**
   * The hospital that sent us this work, or null for our own order.
   *
   * Null and `false` mean different things here and the pair has to be read
   * together: null on `reportedBack` means the question does not apply, false
   * means it applies and the answer is no.
   */
  referredFrom: string | null;
  /**
   * Whether the referring hospital actually has the report.
   *
   * Authorising transmits automatically, and that transmission can fail — a
   * network problem, or a test that could not be matched back to the referral.
   * It used to fail silently: the technician saw "authorised", the order left
   * the worklist, and the doctor at the other end waited for a result nobody
   * was sending. False is the state the completed tab offers *Send report
   * again* for.
   */
  reportedBack: boolean | null;
  items: {
    id: number;
    testCode: string;
    testName: string;
    category: LabCategory;
    specimenType: LabSpecimenType;
    resultedAt: string | null;
    criticalNotifiedAt: string | null;
    hasCritical: boolean;
  }[];
}

/**
 * A month of referred work, billed as one thing.
 *
 * WHY A STATEMENT AND NOT THE INVOICE LIST
 * ----------------------------------------
 * A reference laboratory raises an invoice per referral — the charge is
 * captured at accession, against the prices in force that day — and then sends
 * **one statement a month**, which is what the referring hospital pays.
 *
 * Reported from the receiving end: the payable notices arrived one per
 * referral, so "what do we owe them" was a column of figures to add up by eye,
 * and there was nothing either party could put in an envelope.
 *
 * Derived, never stored. A month that has closed is completely determined by
 * the invoices already in it, exactly as `Invoice.labAccessions` is determined
 * by its own line descriptions.
 *
 * NO TEST NAMES ANYWHERE ON EITHER SHAPE. A count and the specimen numbers,
 * which is everything needed to reconcile a line and nothing about what was
 * investigated — the rule `labSummaryDescription` follows, applied to a
 * document that leaves the building.
 */
export interface LabStatementSummary {
  /** The referring hospital's tenant, which is what the statement is *for*. */
  sourceTenantId: number;
  hospital: string;
  referrals: number;
  tests: number;
  total: string;
  paid: string;
  credited: string;
  /** Charge minus credits minus payments. Never `total - paid`. */
  outstanding: string;
  settled: boolean;
}

export interface LabStatements {
  /**
   * The resolved period, as hospital-local calendar days.
   *
   * A period is a **range**, not a month: referral agreements are written
   * weekly, ten-daily and fortnightly as often as monthly, and none of those is
   * expressible as `2026-09`. A month is still the default and the shorthand,
   * and it comes back as its first and last day like everything else so a
   * client has one shape to hold and to send back.
   */
  from: string;
  to: string;
  /**
   * `September 2026`, `1–15 September 2026`, `26 September – 2 October 2026`.
   *
   * Not decoration. A statement has no number, so what identifies it is the
   * laboratory, the hospital and the period — and two parties disagreeing about
   * which days a bill covers is the failure this label exists to prevent. A
   * whole calendar month still reads as the month.
   */
  label: string;
  data: LabStatementSummary[];
  total: string;
  outstanding: string;
}

/** One line of a statement, itemised by referral. */
export interface LabStatementLine {
  invoiceId: number;
  issuedAt: string;
  /** Our number for the specimen. */
  accession: string | null;
  /** Theirs, which is the only one the recipient can match to anything. */
  sourceAccession: string | null;
  reference: string;
  tests: number;
  amount: string;
  outstanding: string;
}

/**
 * One hospital's month, itemised — what the printed page carries.
 *
 * Read on demand rather than with the summary: a laboratory with thirty
 * partners would otherwise pull every referral of the month to draw a table of
 * thirty rows. It is also the answer to the question the summary cannot settle,
 * which is *is this right* before it is posted.
 */
export interface LabStatement {
  from: string;
  to: string;
  label: string;
  sourceTenantId: number;
  hospital: string;
  lines: LabStatementLine[];
  referrals: number;
  tests: number;
  total: string;
  paid: string;
  credited: string;
  outstanding: string;
}

/**
 * The mirror image, read at the hospital that owes it.
 *
 * Built from the `PartnerLabCharge` notices the laboratory wrote into our scope
 * on accession, grouped into the month they bill as one — so the statement that
 * arrives in the post can be checked against our own records line by line.
 * Two independently-kept sets of rows agreeing is worth far more than one
 * party's figure taken on trust.
 */
export interface PartnerLabStatement {
  partnerTenantId: number;
  partnerName: string;
  referrals: number;
  tests: number;
  total: string;
  outstandingCount: number;
  outstanding: string;
  settled: boolean;
  lines: {
    id: number;
    reference: string;
    sourceAccession: string | null;
    amount: string;
    testCount: number;
    incurredAt: string;
    settledAt: string | null;
    settledBy: string | null;
    settledNote: string | null;
  }[];
}

export interface PartnerLabStatements {
  from: string;
  to: string;
  label: string;
  data: PartnerLabStatement[];
  total: string;
  outstanding: string;
}

/** Who settles with a laboratory for work referred to it. */
export type ReferralBilling = 'ORIGIN_PAYS' | 'PATIENT_PAYS';

/** A lab at another hospital this one may send work to. */
export interface LabPartner {
  id: number;
  label: string;
  partnerTenantId: number;
  /** How this partnership is billed. See `ReferralBilling`. */
  billing: ReferralBilling;
  /**
   * What that laboratory will take work under *today*.
   *
   * Sent so the picker can offer only what will actually be honoured and name
   * the reason for the rest. An option quietly omitted is indistinguishable
   * from a feature that does not exist — the mistake the partner-pharmacy
   * handshake made, where switching on the receiving half showed the sender
   * nothing.
   */
  accepts: ReferralBilling[];
  /**
   * Set when the partnership is configured in a way that lab no longer
   * honours, so ordering through it is refused.
   *
   * Its own field because the person who meets the refusal cannot fix it: a
   * doctor did not choose the billing arrangement. The list shows it as
   * unavailable before it is picked rather than failing at the moment of
   * ordering.
   */
  lapsed: 'no-longer-accepting' | 'billing-not-accepted' | null;
  createdAt: string;
}

/**
 * An order raised at another hospital and transmitted here.
 *
 * The outcome is carried as data rather than implied by which tab returned the
 * row, so a list that mixes states still renders correctly.
 */
export interface LabReferral {
  id: number;
  reference: string;
  from: string;
  patientName: string;
  patientDob: string | null;
  requestedByName: string;
  clinicalDetails: string | null;
  priority: LabPriority;
  receivedAt: string;
  /** When this lab accessioned it and raised its own order. */
  /** Who owes this laboratory for the work, as agreed when it was sent. */
  billing: ReferralBilling;
  /**
   * When the sending hospital drew the specimen, and when it left them.
   *
   * Null means the tube has not been taken yet — the referral was transmitted
   * so this laboratory could expect the work, and the specimen is still to
   * come. An ordinary state, and one the queue has to name rather than leave
   * looking like a sample that went missing.
   */
  collectedAt: string | null;
  dispatchedAt: string | null;
  /**
   * The **sending** hospital's specimen number.
   *
   * Carried so both organisations can quote one identifier at each other. This
   * laboratory still raises its own accession when it accessions the work —
   * that is what goes on its own tube — and this is the number the other end
   * will say on the telephone.
   */
  sourceAccession: string | null;
  acceptedAt: string | null;
  resultedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  items: {
    id: number;
    sourceOrderItemId: number;
    testCode: string;
    testName: string;
    category: LabCategory;
    specimenType: LabSpecimenType;
  }[];
}

/** What kind of thing a lab attachment is. */
export type LabAttachmentKind = 'REPORT' | 'RAW' | 'OTHER';

/**
 * A file attached to one test's result — a signed report, an analyser printout.
 *
 * Metadata only. The bytes are fetched separately, with the auth header, by
 * `documents.ts` — a plain link would arrive unauthenticated and 401.
 *
 * `checksum` is here so a reader can confirm the file they downloaded is the
 * file that was uploaded, which is the question asked when a report is
 * disputed.
 */
export interface LabAttachment {
  id: number;
  orderItemId: number;
  fileName: string;
  /** Determined from the file's own bytes, never from what the client said. */
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  kind: LabAttachmentKind;
  description: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
}
