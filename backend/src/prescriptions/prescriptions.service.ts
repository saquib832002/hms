import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentStatus,
  DrugClass,
  PrescriptionDestination,
  PrescriptionStatus,
  UserRole,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { partnerLabels, routingTrail } from '../common/routing/routing-trail';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { checkAllergies } from '../pharmacy/allergy-check';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';
import { generateReference, toReferralPayload } from './referral';
import { NOT_TREATING, resolveTreatingScope } from '../common/clinical/treating-scope';

// The attended-statuses list moved to `common/clinical/treating-scope.ts`,
// shared with record-writing. Two copies of it is how the two rules drift.

export interface AllergyWarning {
  substance: string;
  severity: string;
  matchedMedicine: string;
}

@Injectable()
export class PrescriptionsService {
  constructor(
    private clinic: ClinicSettingsService,
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * The caller's hospital timezone.
   *
   * Async because it is a per-tenant lookup now, not a process-wide
   * constant — two hospitals on one deployment keep different clocks, and
   * the clock decides what "today" contains.
   */
  private async tz(): Promise<string> {
    return (await this.clinic.current()).timezone;
  }

  /**
   * Write the copy into the receiving pharmacy's tenant.
   *
   * ENTERING SOMEBODY ELSE'S SCOPE, ON PURPOSE
   * ------------------------------------------
   * `forTenant` opens a transaction with `app.tenant_id` set to the
   * destination, so the rows land under *their* policy and are theirs from the
   * moment they exist. This is the only place in the system that writes into a
   * tenant other than the caller's, and it is deliberate rather than
   * incidental: the alternative was a policy exception letting one hospital
   * read another's prescription, which would have cost the property that makes
   * the whole isolation provable.
   *
   * `unscoped.forTenant` rather than the request's own transaction — nesting
   * one tenant's transaction inside another's would leave `app.tenant_id`
   * pointing at the wrong hospital for whatever ran next on that connection.
   *
   * THE REFERENCE COLLISION
   * -----------------------
   * `reference` is unique per receiving pharmacy, and six characters will
   * eventually repeat. Retried rather than made longer, because the length is
   * set by a person reading it aloud at a counter, not by the birthday problem.
   */
  private async transmitReferral(
    prescriptionId: number,
    partner: { partnerTenantId: number; label: string },
    source: Parameters<typeof toReferralPayload>[0],
  ): Promise<{ reference: string; pharmacy: string }> {
    const payload = toReferralPayload(source);
    const sourceTenantId = currentTenantId();

    // Scoped client: `tenants` has no policy, and a second pool connection
    // inside the request's transaction is what deadlocked the app.
    const sender = await this.prisma.tenant.findUnique({
      where: { id: sourceTenantId },
      select: { name: true },
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = generateReference();
      try {
        await this.prisma.forTenant(partner.partnerTenantId, () =>
          this.prisma.prescriptionReferral.create({
            data: {
              tenantId: partner.partnerTenantId,
              sourceTenantId,
              sourceTenantName: sender?.name ?? 'Unknown hospital',
              sourcePrescriptionId: prescriptionId,
              reference,
              patientName: payload.patientName,
              patientDob: payload.patientDob,
              prescriberName: payload.prescriberName,
              prescriberRegistrationNo: payload.prescriberRegistrationNo,
              issuedAt: payload.issuedAt,
              items: {
                create: payload.items.map((i) => ({
                  tenantId: partner.partnerTenantId,
                  medicineName: i.medicineName,
                  dosage: i.dosage,
                  frequency: i.frequency,
                  duration: i.duration,
                })),
              },
            },
          }),
        );
        return { reference, pharmacy: partner.label };
      } catch (err) {
        // P2002 is the reference colliding at that pharmacy. Anything else is
        // real and should surface rather than being retried into silence.
        const collision =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!collision) throw err;
      }
    }

    throw new InternalServerErrorException(
      'Could not generate a unique reference for that pharmacy. The prescription was saved — try routing it again.',
    );
  }

  async create(dto: CreatePrescriptionDto, user: AuthUser) {
    if (!user.doctorId) {
      throw new ForbiddenException('Only a doctor can issue a prescription');
    }

    const patient = await this.prisma.patient.findUnique({
      where: { id: dto.patientId },
      include: { allergies: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${dto.patientId} not found`);

    /*
     * Resolve the destination before anything is written.
     *
     * A partner is named by *this hospital's* `PharmacyPartner` row, never by a
     * raw tenant id from the client — otherwise a doctor could address any
     * hospital on the platform, including ones that never agreed to receive
     * anything. Checked again here rather than trusted from the DTO, because
     * the partner may have been deactivated since the screen loaded.
     */
    const destination = dto.destination ?? PrescriptionDestination.IN_HOUSE;
    let partner: { partnerTenantId: number; label: string } | null = null;

    if (destination === PrescriptionDestination.PARTNER) {
      if (!dto.partnerId) {
        throw new BadRequestException('Choose which pharmacy this is going to');
      }
      const row = await this.prisma.pharmacyPartner.findUnique({
        where: { id: dto.partnerId },
        select: { partnerTenantId: true, label: true, isActive: true },
      });
      if (!row || !row.isActive) {
        throw new BadRequestException('That pharmacy is no longer one of your partners');
      }
      partner = { partnerTenantId: row.partnerTenantId, label: row.label };
    }

    /*
     * Who this doctor may prescribe for. The rule and its reasoning live in
     * `treating-scope.ts`, shared with record-writing so the two cannot drift
     * into permitting different things.
     */
    const scope = await resolveTreatingScope(this.prisma, await this.tz(), user.doctorId, dto.patientId);
    if (!scope) throw new ForbiddenException(NOT_TREATING);

    /*
     * Linked to the appointment only when it belongs to that visit — same day,
     * and that visit has no prescription already (the FK is unique).
     *
     * A repeat written six weeks later is not part of the consultation it
     * followed from, and attaching it there would put it on that visit's
     * record and its invoice. `Invoice.appointmentId` is unique and billing
     * reads this link, so a wrong one is not cosmetic.
     */
    const appointmentId =
      scope.sameDay && scope.appointment && !scope.appointment.hasPrescription
        ? scope.appointment.id
        : null;

    // Phase 4: link each item to the catalogue by exact name where possible.
    // The prescribed text is still stored verbatim — the link is additional,
    // never a replacement, so a later catalogue rename cannot rewrite what a
    // doctor wrote.
    const catalogue = await this.prisma.medicine.findMany({
      where: { isActive: true },
      select: { id: true, name: true, drugClass: true },
    });
    const byName = new Map(catalogue.map((m) => [m.name.trim().toLowerCase(), m]));
    const resolved = dto.items.map((i) => ({
      ...i,
      matched: byName.get(i.medicineName.trim().toLowerCase()) ?? null,
    }));

    // Class-aware from here on: this catches Amoxicillin against a penicillin
    // allergy, which the Phase 1 substring check could not.
    const { conflicts } = checkAllergies(
      resolved.map((i) => ({
        medicineName: i.medicineName,
        drugClass: (i.matched?.drugClass as DrugClass | undefined) ?? null,
        catalogueName: i.matched?.name ?? null,
      })),
      (patient.allergies ?? []).map((a) => ({ substance: a.substance, severity: a.severity })),
    );

    const prescription = await this.prisma.prescription.create({
      data: {
        tenantId: currentTenantId(),
        patientId: dto.patientId,
        doctorId: user.doctorId,
        // Resolved above: null for a repeat, for a ward prescription, and for
        // a second prescription on a visit that already has one (the FK is
        // unique). A prescription is a record in its own right — the link is
        // "this came out of that visit", not "this belongs to somebody".
        appointmentId,
        notes: dto.notes,
        destination,
        routedToTenantId: partner?.partnerTenantId ?? null,
        items: {
          // Nested relation creates sit outside top-level `data`, so the write
          // proxy does not stamp them. Named explicitly; the compiler agrees.
          create: resolved.map((i) => ({
            tenantId: currentTenantId(),
            medicineName: i.medicineName,
            medicineId: i.matched?.id ?? null,
            dosage: i.dosage,
            frequency: i.frequency,
            duration: i.duration,
            /*
             * What the prescriber ordered. Null when they left it open — an
             * as-needed or ongoing course — and the pharmacist settles that at
             * the counter rather than the system inferring a total and then
             * being unable to say the prescription was ever finished.
             */
            quantityPrescribed: i.quantityPrescribed ?? null,
          })),
        },
      },
      include: this.detailInclude(),
    });

    /*
     * The copy, written into the receiving pharmacy's own tenant.
     *
     * After the prescription exists, not inside its transaction. If the
     * transmission fails the prescription still stands — the patient has a
     * valid prescription they can take anywhere, which is strictly better than
     * losing it because another hospital's row could not be written. The
     * failure surfaces as an error the doctor sees, and re-routing is possible.
     */
    let referral: { reference: string; pharmacy: string } | null = null;
    if (partner) {
      referral = await this.transmitReferral(prescription.id, partner, {
        patient: { fullName: patient.fullName, dob: patient.dob },
        doctor: {
          fullName: prescription.doctor?.fullName ?? 'Unknown',
          registrationNo: prescription.doctor?.registrationNo ?? null,
        },
        issuedAt: prescription.issuedAt,
        items: resolved,
      });
    }

    // Still returned rather than thrown, even now that the check is reliable.
    //
    // The hard stop lives at dispensing, not prescribing. A prescriber may
    // knowingly prescribe despite a recorded allergy — a label that is really
    // an intolerance, a decision taken with the patient — and blocking them
    // mid-consultation would push that decision onto paper where nothing sees
    // it. The pharmacist is the second check, and that is where an override
    // must be documented.
    return {
      ...prescription,
      /** Present only when it was sent to a partner. The patient quotes it. */
      referral,
      allergyWarnings: conflicts.map((c) => ({
        substance: c.substance,
        severity: c.severity,
        matchedMedicine: c.medicineName,
        matchedOn: c.matchedOn,
        level: c.level,
        message: c.message,
      })),
    };
  }

  async findOne(id: number, user: AuthUser) {
    const prescription = await this.prisma.prescription.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!prescription) throw new NotFoundException(`Prescription ${id} not found`);

    if (user.role === UserRole.DOCTOR && prescription.doctorId !== user.doctorId) {
      // Another doctor's prescription is still clinically relevant — a doctor
      // needs to see what a colleague prescribed. Readable, not editable.
      return prescription;
    }
    return prescription;
  }

  async findForPatient(patientId: number) {
    const rows = await this.prisma.prescription.findMany({
      where: { patientId },
      orderBy: { issuedAt: 'desc' },
      include: this.detailInclude(),
    });

    return { data: await this.withRouting(rows) };
  }

  /**
   * Attach "where did this go" to a batch of prescriptions.
   *
   * `destination` and `routedToTenantId` have been on the row since routing
   * shipped and reached no screen, so a doctor reading a history could not tell
   * a prescription sent to a partner pharmacy from one filled at the counter
   * downstairs. Resolved in one query for the whole list — see the note in
   * `routing-trail.ts` about the connection budget.
   */
  private async withRouting<
    T extends { destination: string; routedToTenantId: number | null; issuedAt: Date },
  >(rows: T[]) {
    const labels = await partnerLabels(
      this.prisma,
      'PRESCRIPTION',
      rows.map((r) => r.routedToTenantId),
    );

    return rows.map((row) => ({
      ...row,
      routing: routingTrail(
        'PRESCRIPTION',
        {
          destination: row.destination,
          routedToTenantId: row.routedToTenantId,
          // A referral is transmitted immediately after the prescription is
          // written, so the issue time is the send time to within a second.
          // A separate column would be a second thing to keep true.
          sentAt: row.issuedAt,
        },
        labels,
      ),
    }));
  }

  /**
   * The rule from CLAUDE.md, enforced where it belongs.
   *
   * Once a prescription has been dispensed, the patient is holding medicine
   * that matches what was printed. Editing the record afterwards makes the
   * system disagree with physical reality — and the audit trail would show a
   * prescription that was never actually the one filled.
   */
  async cancel(id: number, user: AuthUser) {
    const existing = await this.prisma.prescription.findUnique({
      where: { id },
      select: { id: true, doctorId: true, status: true, dispensedAt: true },
    });
    if (!existing) throw new NotFoundException(`Prescription ${id} not found`);

    if (existing.dispensedAt || existing.status === PrescriptionStatus.DISPENSED) {
      throw new ConflictException(
        'This prescription has been dispensed and can no longer be changed',
      );
    }
    if (existing.status === PrescriptionStatus.CANCELLED) {
      throw new ConflictException('This prescription is already cancelled');
    }
    if (user.role === UserRole.DOCTOR && existing.doctorId !== user.doctorId) {
      throw new ForbiddenException('You can only cancel prescriptions you issued');
    }

    return this.prisma.prescription.update({
      where: { id },
      data: { status: PrescriptionStatus.CANCELLED },
      include: this.detailInclude(),
    });
  }

  /*
   * `renderPrintable` used to live here: a template literal that built the
   * whole prescription as HTML, with `<h1>Meridian Hospital</h1>` written into
   * it — the demo seed's name, printed on every tenant's prescriptions.
   *
   * Replaced by `DocumentsService`, which draws the calling hospital's own
   * letterhead and returns a real PDF. Deleted rather than left beside it,
   * because two renderers of the same document drift and the one that drifts
   * is the one nobody is looking at.
   */

  private detailInclude() {
    return {
      items: true,
      patient: { select: { id: true, fullName: true, dob: true, gender: true } },
      doctor: { select: { id: true, fullName: true, specialization: true, registrationNo: true } },
    };
  }
}
