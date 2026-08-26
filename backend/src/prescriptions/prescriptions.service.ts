import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentStatus, DrugClass, PrescriptionStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { hospitalDayRange } from '../common/utils/hospital-time';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { checkAllergies } from '../pharmacy/allergy-check';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { ClinicSettingsService } from '../common/tenancy/clinic-settings.service';

const IN_CONSULTATION = [
  AppointmentStatus.CHECKED_IN,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.COMPLETED,
];

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

  async create(dto: CreatePrescriptionDto, user: AuthUser) {
    if (!user.doctorId) {
      throw new ForbiddenException('Only a doctor can issue a prescription');
    }

    const patient = await this.prisma.patient.findUnique({
      where: { id: dto.patientId },
      include: { allergies: true },
    });
    if (!patient) throw new NotFoundException(`Patient ${dto.patientId} not found`);

    const { start, end } = hospitalDayRange(new Date(), await this.tz());
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        doctorId: user.doctorId,
        patientId: dto.patientId,
        scheduledAt: { gte: start, lt: end },
        status: { in: IN_CONSULTATION },
      },
      select: { id: true, prescription: { select: { id: true } } },
    });
    if (!appointment) {
      throw new ForbiddenException(
        'You can only prescribe for patients you are seeing today',
      );
    }

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
        // One prescription per appointment (the FK is unique). A second one
        // for the same visit is a separate, unlinked prescription.
        appointmentId: appointment.prescription ? null : appointment.id,
        notes: dto.notes,
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
          })),
        },
      },
      include: this.detailInclude(),
    });

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
    return {
      data: await this.prisma.prescription.findMany({
        where: { patientId },
        orderBy: { issuedAt: 'desc' },
        include: this.detailInclude(),
      }),
    };
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

  /**
   * Rendered server-side so web and mobile print byte-identical documents.
   * A prescription printed from a phone must not differ from one printed at
   * the front desk.
   */
  async renderPrintable(id: number): Promise<string> {
    const p = await this.prisma.prescription.findUnique({
      where: { id },
      include: this.detailInclude(),
    });
    if (!p) throw new NotFoundException(`Prescription ${id} not found`);

    const esc = (s: unknown) =>
      String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      );

    const rows = (p.items ?? [])
      .map(
        (i) => `<tr>
        <td>${esc(i.medicineName)}</td><td>${esc(i.dosage)}</td>
        <td>${esc(i.frequency)}</td><td>${esc(i.duration)}</td></tr>`,
      )
      .join('');

    const dob = p.patient?.dob ? new Date(p.patient.dob).toISOString().slice(0, 10) : '';
    const issued = new Date(p.issuedAt as Date).toISOString().slice(0, 10);

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Prescription #${p.id}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color:#111; font-size:12pt; }
  header { border-bottom:2px solid #111; padding-bottom:8px; margin-bottom:16px; }
  h1 { font-size:16pt; margin:0; } .sub { font-size:9pt; color:#555; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 18px; font-size:10pt; margin-bottom:18px; }
  .label { color:#555; }
  table { width:100%; border-collapse:collapse; margin-bottom:24px; font-size:11pt; }
  th { text-align:left; border-bottom:1px solid #111; padding:6px 4px; font-size:9pt;
       text-transform:uppercase; letter-spacing:.5px; }
  td { padding:7px 4px; border-bottom:1px solid #ddd; }
  .rx { font-size:26pt; font-weight:bold; float:left; margin-right:10px; line-height:1; }
  .sig { margin-top:44px; border-top:1px solid #111; width:230px; padding-top:5px; font-size:9pt; }
  .foot { margin-top:26px; font-size:8pt; color:#666; border-top:1px solid #ddd; padding-top:6px; }
</style></head>
<body>
<header>
  <h1>Meridian Hospital</h1>
  <div class="sub">Prescription · Reference #${p.id}</div>
</header>

<div class="grid">
  <div><span class="label">Patient:</span> <strong>${esc(p.patient?.fullName)}</strong></div>
  <div><span class="label">Date:</span> ${esc(issued)}</div>
  <div><span class="label">Date of birth:</span> ${esc(dob)}</div>
  <div><span class="label">Patient ID:</span> ${esc(p.patient?.id)}</div>
  <div><span class="label">Prescriber:</span> ${esc(p.doctor?.fullName)}</div>
  <div><span class="label">Reg. no:</span> ${esc(p.doctor?.registrationNo ?? '—')}</div>
</div>

<div class="rx">&#8478;</div>
<table>
  <thead><tr><th>Medicine</th><th>Dosage</th><th>Frequency</th><th>Duration</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

${p.notes ? `<p><strong>Instructions:</strong> ${esc(p.notes)}</p>` : ''}

<div class="sig">Prescriber signature</div>
<div class="foot">
  Generated ${new Date().toISOString().slice(0, 10)} ·
  DEVELOPMENT BUILD — DUMMY DATA, NOT A VALID PRESCRIPTION
</div>
</body></html>`;
  }

  private detailInclude() {
    return {
      items: true,
      patient: { select: { id: true, fullName: true, dob: true, gender: true } },
      doctor: { select: { id: true, fullName: true, specialization: true, registrationNo: true } },
    };
  }
}
