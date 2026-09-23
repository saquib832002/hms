import {
  BadRequestException,
  Inject,
  forwardRef,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Gender, LabOrderStatus, LabResultFlag, Prisma, ReferralBilling } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LabService } from './lab.service';
import { currentTenantId } from '../common/tenancy/tenant-context';
import { generateReference } from '../prescriptions/referral';
import { AddLabPartnerDto, ReturnReferralResultDto } from './dto/lab.dto';
import { toLabReferralPayload } from './lab-referral';
import { billingPhrase } from './referral-billing';
import { matchReferralItems, sourceItemIdByLocalId } from './referral-item-match';
import { AuthUser } from '../common/types/auth-user';

/**
 * Sending a test to a lab that is not yours, and getting the result back.
 *
 * THE PART THAT IS NEW IN THIS CODEBASE
 * -------------------------------------
 * Every cross-tenant write so far has gone one way: a prescription referral is
 * transmitted into the receiving pharmacy's scope and never answered. That is
 * deliberate there, and it would make this feature useless — a lab order that
 * goes out and never comes back is a doctor telephoning another company for a
 * number.
 *
 * So there are two `forTenant` calls in this file and they are exact mirrors:
 *
 *   transmit()      — writes a `LabReferral` into the RECEIVING lab's scope
 *   returnResult()  — writes values into the ORDERING hospital's scope
 *
 * Neither needs a policy exception. `"tenantId" = app_current_tenant()` remains
 * the whole truth on every table involved, in both directions. The rejected
 * design was a policy carve-out making a referral tagged for hospital B visible
 * to B — one line of SQL, after which every future reader of that policy has to
 * know about it.
 *
 * WHAT THE RETURN LEG IS ALLOWED TO TOUCH
 * ---------------------------------------
 * Three refusals, all load-bearing:
 *
 *  1. Only the order items **named on that referral**. The write is driven by
 *     `sourceOrderItemId` values the sending hospital itself put there, and
 *     each is re-checked against the referral before anything is written. A
 *     partner cannot reach an order they were never sent.
 *  2. Never an order the ordering hospital has already authorised. A verified
 *     report is part of a patient's record, and a partner overwriting one would
 *     silently restate a document a clinician has already acted on.
 *  3. Never twice. A referral that has been resulted is closed; a correction is
 *     a new order, so the original stays readable.
 *
 * The partner's flags and reference ranges cross **as they issued them** and
 * are not recomputed against the ordering hospital's catalogue. Their analyser
 * has their intervals, and re-flagging would be one organisation asserting
 * something about a measurement it did not make.
 */
@Injectable()
export class LabReferralService {
  constructor(
    private readonly prisma: PrismaService,
    /*
     * `forwardRef` because `LabService` injects this service too.
     *
     * The cycle is real rather than accidental: accepting a referral has to
     * price the work using the same arithmetic a local order uses — tax basis,
     * billing mode, captured unit prices — and duplicating that here is exactly
     * how two invoices for the same test come to disagree.
     */
    @Inject(forwardRef(() => LabService)) private readonly lab: LabService,
  ) {}

  // ── the partner directory ────────────────────────────────────────────────

  async partners() {
    const rows = await this.prisma.labPartner.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, partnerTenantId: true, billing: true, createdAt: true },
    });

    /*
     * Each partner's own answer travels with it, so a screen can offer only
     * what that laboratory will actually take.
     *
     * The alternative — offering both and refusing on save — is the mistake
     * the partner-pharmacy handshake made in the other direction: an option
     * that is hidden, or that fails at the last moment, is indistinguishable
     * from a feature that does not work. `accepts` is what the client narrows
     * by, and it names the reason when a mode is unavailable rather than
     * silently omitting it.
     *
     * One query for the lot. `tenants` is global with no policy, and it goes
     * through the request's own transaction like every other global read —
     * asking the pool for a second connection while holding one is what
     * deadlocked this app once already.
     */
    const labs = rows.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.partnerTenantId))] } },
          select: { id: true, acceptsExternalLabOrders: true, acceptedReferralBilling: true },
        })
      : [];
    const byId = new Map(labs.map((l) => [l.id, l]));

    return {
      data: rows.map((r) => {
        const lab = byId.get(r.partnerTenantId);
        return {
          ...r,
          /** What this lab will take work under, today. May no longer include `billing`. */
          accepts: lab?.acceptedReferralBilling ?? [],
          /**
           * The partnership is set up in a way this lab no longer honours, so
           * ordering through it is refused. Surfaced as its own fact because
           * the person who can fix it is not the person who meets the refusal:
           * a doctor cannot change a billing arrangement, and a bare failure at
           * the moment of ordering is the dead end this project keeps having to
           * reopen.
           */
          lapsed: !(lab?.acceptsExternalLabOrders ?? false)
            ? 'no-longer-accepting'
            : !(lab?.acceptedReferralBilling ?? []).includes(r.billing)
              ? 'billing-not-accepted'
              : null,
        };
      }),
    };
  }

  /**
   * Change how a partnership is billed.
   *
   * Its own route rather than a field on add, because the commercial term
   * changes long after the partnership is set up and the alternative is
   * removing the partner and re-adding them — which works, soft-deletes a row
   * every order already sent points at, and is the sort of thing an
   * administrator does once before ringing somebody.
   *
   * Validated against the receiving lab exactly as `addPartner` is. Saving a
   * mode the other end will refuse produces a partnership that looks configured
   * and fails at the moment a doctor tries to use it.
   */
  async setPartnerBilling(id: number, billing: ReferralBilling) {
    const partner = await this.prisma.labPartner.findFirst({
      where: { id, isActive: true },
      select: { id: true, label: true, partnerTenantId: true },
    });
    if (!partner) throw new NotFoundException('No such partner');

    await this.requireAccepted(partner.partnerTenantId, partner.label, billing);

    return this.prisma.labPartner.update({
      where: { id },
      data: { billing },
      select: { id: true, label: true, partnerTenantId: true, billing: true, createdAt: true },
    });
  }

  /**
   * The receiving half of the handshake, in one place.
   *
   * Called when a partnership is created, when its billing is changed, and
   * again at ordering. Three checks rather than one because the answer can
   * change between them without anybody here being told — and the failure of
   * trusting a saved answer is that the specimen goes out and *neither* party
   * bills, which is the hole this whole change exists to close.
   */
  private async requireAccepted(tenantId: number, label: string, billing: ReferralBilling) {
    const lab = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { acceptsExternalLabOrders: true, acceptedReferralBilling: true },
    });

    if (!lab?.acceptsExternalLabOrders) {
      throw new BadRequestException(`${label} is no longer accepting work from other hospitals`);
    }
    if (!lab.acceptedReferralBilling.includes(billing)) {
      throw new BadRequestException(
        `${label} does not accept work ${billingPhrase(billing)}. They set that at their end — ask them to switch it on, or bill this partnership the other way.`,
      );
    }
  }

  /**
   * Add a lab by the code it gave you offline.
   *
   * Nobody can browse the directory. A dropdown of every lab on the platform
   * would turn the vendor's customer base into something any administrator can
   * read — the enumeration concern that already shapes the public signup form.
   *
   * "No such code", "they run no lab" and "they have not opted in" are one
   * identical refusal, for the same reason login does not separate "no such
   * account" from "wrong password".
   */
  async addPartner(dto: AddLabPartnerDto) {
    const slug = dto.slug.trim().toLowerCase();

    const target = await this.prisma.tenant.findUnique({
      // Scoped client: `tenants` is global and has no policy, and asking the
      // pool for a second connection inside the request's transaction is what
      // deadlocked the app once already.
      where: { slug },
      select: {
        id: true,
        isActive: true,
        hasLab: true,
        acceptsExternalLabOrders: true,
        acceptedReferralBilling: true,
      },
    });

    if (!target || !target.isActive || !target.hasLab || !target.acceptsExternalLabOrders) {
      throw new NotFoundException(
        'No lab is accepting orders under that code. Check it with them — they also have to switch on "accept orders from other hospitals"',
      );
    }
    if (target.id === currentTenantId()) {
      throw new BadRequestException('That is your own code');
    }

    const existing = await this.prisma.labPartner.findFirst({
      where: { partnerTenantId: target.id },
    });

    if (existing?.isActive) throw new ConflictException('That lab is already one of your partners');

    /*
     * Defaults to ORIGIN_PAYS, which is what every partnership predating this
     * was doing, and is refused immediately if that lab does not take it — so
     * the administrator finds out while adding rather than a doctor finding
     * out mid-consultation.
     */
    const billing = dto.billing ?? ReferralBilling.ORIGIN_PAYS;
    if (!target.acceptedReferralBilling.includes(billing)) {
      throw new BadRequestException(
        `${dto.label.trim()} does not accept work ${billingPhrase(billing)}. They set that at their end.`,
      );
    }

    if (existing) {
      /*
       * Re-adding a removed partner reactivates the row and takes the label
       * from the new attempt.
       *
       * Removal is a soft delete and has to be — orders already sent carry
       * `routedToTenantId`. But the unique index covers inactive rows, so a
       * plain create is refused naming a row the administrator cannot see and
       * has no way to reach. That happened with partner pharmacies and the
       * only exit was a database console.
       */
      const revived = await this.prisma.labPartner.update({
        where: { id: existing.id },
        data: { isActive: true, label: dto.label.trim(), billing },
        select: { id: true, label: true, partnerTenantId: true, billing: true, createdAt: true },
      });
      return revived;
    }

    try {
      return await this.prisma.labPartner.create({
        data: {
          tenantId: currentTenantId(),
          partnerTenantId: target.id,
          label: dto.label.trim(),
          billing,
        },
        select: { id: true, label: true, partnerTenantId: true, billing: true, createdAt: true },
      });
    } catch (err) {
      /*
       * Narrow on purpose. A bare catch here would report a dropped connection
       * as "already a partner" and send somebody looking for a row that was
       * never written.
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('That lab is already one of your partners');
      }
      throw err;
    }
  }

  /**
   * What a partner laboratory charges, so a doctor is not sending work at a
   * price nobody here can see.
   *
   * WHY THIS CROSSES THE TENANT BOUNDARY AT ALL
   * -------------------------------------------
   * Under ORIGIN_PAYS this hospital pays whatever the lab's catalogue says,
   * and until now it could not see that number at any point: not when choosing
   * where to send the work, not when pricing the patient, not afterwards. It
   * arrived as a statement.
   *
   * A price list is not patient data, and the laboratory has already opted in
   * to receiving work from other hospitals — this returns exactly what a
   * printed price list would, for a partnership that already exists, and
   * nothing else. No patients, no orders, no other hospital's rates.
   *
   * Read through `forTenant` into the partner's scope, like the referral
   * write, so their RLS policy is what decides what comes back rather than a
   * `where` clause here.
   */
  async partnerCatalogue(partnerId: number) {
    const partner = await this.prisma.labPartner.findFirst({
      where: { id: partnerId, isActive: true },
      select: { id: true, label: true, partnerTenantId: true, billing: true },
    });
    if (!partner) throw new NotFoundException('That partner lab is not one of yours');

    const tests = await this.prisma.forTenant(partner.partnerTenantId, () =>
      this.prisma.labTest.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { code: true, name: true, sellingPrice: true },
      }),
    );

    return {
      partner: { id: partner.id, label: partner.label, billing: partner.billing },
      data: tests.map((t) => ({
        code: t.code,
        name: t.name,
        /*
         * Null means *they* have not priced it, which is their unpriced-work
         * problem and not ours — but it is worth showing, because it is also
         * the case where an unexpected invoice is most likely to appear later.
         */
        sellingPrice: t.sellingPrice === null ? null : t.sellingPrice.toFixed(2),
      })),
    };
  }

  /**
   * What this hospital owes partner laboratories.
   *
   * Segmented rather than filtered to the outstanding ones — fifth time in
   * this codebase. "Did we ever pay them for that" is asked precisely once an
   * outstanding-only list would have dropped the row, and the outcome is sent
   * as data rather than implied by which tab asked for it.
   */
  async partnerCharges(status: 'outstanding' | 'settled' | 'all' = 'outstanding') {
    const where =
      status === 'outstanding'
        ? { settledAt: null }
        : status === 'settled'
          ? { settledAt: { not: null } }
          : {};

    const rows = await this.prisma.partnerLabCharge.findMany({
      where,
      orderBy: { incurredAt: 'desc' },
      take: 200,
      include: { settledBy: { select: { fullName: true } } },
    });

    /*
     * Totals are computed over the outstanding rows only and reported beside
     * the list rather than inside it. "What do we owe" is the question the
     * screen exists for, and making somebody add a column of figures by eye is
     * how it gets answered wrongly.
     */
    const outstanding = rows.filter((r) => r.settledAt === null);

    return {
      data: rows.map((r) => ({
        id: r.id,
        partnerName: r.partnerName,
        reference: r.reference,
        /** Our order number for the work, so the charge maps to our records. */
        sourceAccession: r.sourceAccession,
        amount: r.amount.toFixed(2),
        testCount: r.testCount,
        incurredAt: r.incurredAt,
        settledAt: r.settledAt,
        settledBy: r.settledBy?.fullName ?? null,
        settledNote: r.settledNote,
      })),
      outstandingCount: outstanding.length,
      outstandingTotal: outstanding
        .reduce((sum, r) => sum.add(r.amount), new Prisma.Decimal(0))
        .toFixed(2),
    };
  }

  /**
   * Record that a partner laboratory's charge has been dealt with.
   *
   * **Not a payment.** No money moves between two companies inside this
   * system, and pretending otherwise would put a number in this hospital's
   * takings that never passed through a till. It records that somebody here
   * says it is settled, and it is reversible for exactly that reason — the
   * commonest correction is marking the wrong row.
   */
  async settlePartnerCharge(id: number, user: AuthUser, settled: boolean, note?: string) {
    const row = await this.prisma.partnerLabCharge.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('No such charge');

    return this.prisma.partnerLabCharge.update({
      where: { id },
      data: settled
        ? { settledAt: new Date(), settledById: user.userId, settledNote: note?.trim() || null }
        : { settledAt: null, settledById: null, settledNote: null },
      select: { id: true, settledAt: true },
    });
  }

  /** Soft delete. Orders already sent must stay traceable. */
  async removePartner(id: number) {
    const partner = await this.prisma.labPartner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException('No such partner');

    await this.prisma.labPartner.update({ where: { id }, data: { isActive: false } });
    return { id, removed: true };
  }

  /** Resolve a `LabPartner` row id — never a raw tenant id from a client. */
  async requirePartner(partnerId: number) {
    const partner = await this.prisma.labPartner.findFirst({
      where: { id: partnerId, isActive: true },
      select: { id: true, label: true, partnerTenantId: true, billing: true },
    });
    if (!partner) throw new BadRequestException('That partner lab is not one of yours');

    /*
     * The handshake is re-checked here, at ordering, and not only when the
     * partnership was set up.
     *
     * Terms change at the other end without anybody here being told: a
     * laboratory that used to invoice hospitals stops doing so, or withdraws
     * from external work altogether. Trusting the row we saved months ago
     * would send the specimen anyway and discover the disagreement when an
     * invoice nobody expected arrives — or, worse, when neither party bills at
     * all, which is exactly the hole this whole change exists to close.
     *
     * `tenants` is a global model with no policy, so reading the partner's
     * settings needs no scope switch.
     */
    /*
     * Named, and it says who can fix it.
     *
     * A doctor cannot resolve this — they did not choose the billing
     * arrangement and cannot change it — so a bare refusal would be a dead end
     * of the kind this project keeps having to go back and reopen. The partner
     * list carries `lapsed` for the same reason, so the choice is shown as
     * unavailable before it is picked rather than refused after.
     */
    await this.requireAccepted(partner.partnerTenantId, partner.label, partner.billing);

    return partner;
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Write the referral into the receiving lab's scope.
   *
   * Outside the ordering transaction, exactly as `transmitReferral` is: this
   * opens a transaction in a different tenant, and nesting it inside one that
   * is already holding a pool connection is the self-deadlock the tenancy proxy
   * exists to prevent.
   */
  /**
   * Tell the partner the tube has been drawn and is on its way.
   *
   * The referral is transmitted at *ordering*, so the laboratory can expect the
   * work and price it; the specimen is drawn afterwards, at the referring
   * hospital, and travels by courier. Those are two events and the second one
   * had nowhere to go — so a reference laboratory could not tell a referral it
   * was still waiting for from one whose tube was already in the van.
   *
   * Enters the partner's scope, outside any transaction, exactly as `transmit`
   * and the payable notice do. Best-effort: a failure here must not undo a
   * dispatch that physically happened, and the times are a courtesy on top of
   * a tube that is arriving regardless.
   */
  async noticeDispatch(orderId: number, collectedAt: Date, dispatchedAt: Date) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      select: { routedToTenantId: true },
    });
    if (!order?.routedToTenantId) return;

    const partnerTenantId = order.routedToTenantId;

    try {
      await this.prisma.forTenant(partnerTenantId, () =>
        this.prisma.labReferral.updateMany({
          /*
           * Matched on the sender's order id rather than a referral id, which
           * belongs to the partner's scope and is not ours to hold. `updateMany`
           * because there is no unique index on that pair — and it is the right
           * shape anyway: nothing here should fail because a row is missing.
           */
          where: { sourceTenantId: currentTenantId(), sourceOrderId: orderId },
          data: { collectedAt, dispatchedAt },
        }),
      );
    } catch {
      /*
       * Swallowed, and this is the one place in this service where that is
       * right. The tube is with the courier; the referral already exists and
       * the laboratory will accession it when it arrives. Failing the
       * dispatch would leave the sending hospital unable to record something
       * that has physically happened.
       */
    }
  }

  async transmit(
    orderId: number,
    partner: { id: number; label: string; partnerTenantId: number; billing: ReferralBilling },
  ) {
    const order = await this.prisma.labOrder.findUnique({
      where: { id: orderId },
      include: {
        patient: { select: { fullName: true, dob: true } },
        doctor: { select: { fullName: true } },
        items: {
          select: {
            id: true,
            testCode: true,
            testName: true,
            category: true,
            specimenType: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('No such order');

    const sourceTenantId = currentTenantId();
    const sourceTenant = await this.prisma.tenant.findUnique({
      where: { id: sourceTenantId },
      select: { name: true },
    });

    const payload = toLabReferralPayload({
      patient: order.patient,
      /*
       * Referring work on that arrived as a referral is not supported, and the
       * fallback says so rather than transmitting an empty name. `transmit` is
       * only reached from `createOrder`, which always has a doctor.
       */
      doctor: order.doctor ?? { fullName: 'Referring hospital' },
      clinicalDetails: order.clinicalDetails,
      priority: order.priority,
      items: order.items,
    });

    for (let attempt = 0; attempt < 5; attempt++) {
      const reference = generateReference();
      try {
        const created = await this.prisma.forTenant(partner.partnerTenantId, () =>
          this.prisma.labReferral.create({
            data: {
              tenantId: partner.partnerTenantId,
              sourceTenantId,
              sourceTenantName: sourceTenant?.name ?? 'Unknown hospital',
              sourceOrderId: order.id,
              /*
               * Our number for this specimen, carried so both organisations can
               * quote one identifier at each other. A send-out with two
               * identifiers and no mapping is how a telephone call about a tube
               * turns into twenty minutes of searching — real reference labs
               * print the referring site's number beside their own for exactly
               * this reason.
               */
              sourceAccession: order.accession,
              reference,
              patientName: payload.patientName,
              patientDob: payload.patientDob,
              requestedByName: payload.requestedByName,
              clinicalDetails: payload.clinicalDetails,
              priority: payload.priority,
              /*
               * The snapshot. Taken from the partnership at the moment of
               * sending, and never read back off it — renegotiating the
               * contract next quarter must not restate who owed what for work
               * already done, and the partnership row is in the sender's scope
               * and unreachable from the receiving end anyway.
               */
              billing: partner.billing,
              items: {
                create: payload.items.map((i) => ({
                  tenantId: partner.partnerTenantId,
                  sourceOrderItemId: i.sourceOrderItemId,
                  testCode: i.testCode,
                  testName: i.testName,
                  category: i.category,
                  specimenType: i.specimenType,
                })),
              },
            },
            select: { reference: true },
          }),
        );
        return { reference: created.reference, lab: partner.label };
      } catch (err) {
        // Only a reference collision retries. Anything else is a real failure
        // and must not be hidden behind five silent attempts.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }

    throw new InternalServerErrorException('Could not allocate a referral reference');
  }

  // ── receiving ────────────────────────────────────────────────────────────

  /**
   * The inbound queue.
   *
   * Segmented, not filtered to the open items — "which hospitals sent us work,
   * and what happened to it" is asked precisely once a waiting-only list would
   * have dropped the row.
   */
  async inbound(status: 'waiting' | 'resulted' | 'declined' | 'all' = 'waiting') {
    const where =
      status === 'waiting'
        ? { resultedAt: null, declinedAt: null }
        : status === 'resulted'
          ? { resultedAt: { not: null } }
          : status === 'declined'
            ? { declinedAt: { not: null } }
            : {};

    const rows = await this.prisma.labReferral.findMany({
      where,
      orderBy: status === 'waiting' ? { createdAt: 'asc' } : { createdAt: 'desc' },
      take: 100,
      include: { items: true },
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        from: r.sourceTenantName,
        patientName: r.patientName,
        patientDob: r.patientDob,
        requestedByName: r.requestedByName,
        clinicalDetails: r.clinicalDetails,
        priority: r.priority,
        receivedAt: r.receivedAt,
        /*
         * Who owes this laboratory for it, as agreed when it was sent.
         *
         * Read by the technician before they accept, because it decides what
         * happens next on their own screen: an institutional debt is recorded
         * now and chased later, and a patient's is collected when they walk in
         * to give the sample. Accepting used to hand straight over to the till
         * either way, which under PATIENT_PAYS opens a payment form for
         * somebody who is not in the building.
         */
        billing: r.billing,
        /** Their number for the tube, so a telephone call resolves in one go. */
        sourceAccession: r.sourceAccession,
        /*
         * When they drew it, and when it left them.
         *
         * A referral with no draw time is one whose tube has not been taken
         * yet — transmitted so this laboratory can expect the work. Sent as its
         * own state rather than left to look like a specimen that has gone
         * missing, which is what an unexplained queue row invites somebody to
         * conclude.
         *
         * Time since draw is clinical: a potassium from a six-hour-old tube is
         * a different number, and a laboratory that cannot see it is guessing
         * at sample integrity.
         */
        collectedAt: r.collectedAt,
        dispatchedAt: r.dispatchedAt,
        /*
         * Accessioned or not. Sent as data for the same reason the outcome is:
         * the screen must be able to tell "still to be taken on" from "on the
         * bench" without inferring it from which tab asked.
         */
        acceptedAt: r.acceptedAt,
        /*
         * The outcome is sent as data rather than implied by which tab
         * returned the row. A screen that infers state from its own filter
         * cannot render a list that mixes them, and eventually one does.
         */
        resultedAt: r.resultedAt,
        declinedAt: r.declinedAt,
        declineReason: r.declineReason,
        items: r.items.map((i) => ({
          id: i.id,
          sourceOrderItemId: i.sourceOrderItemId,
          testCode: i.testCode,
          testName: i.testName,
          category: i.category,
          specimenType: i.specimenType,
        })),
      })),
    };
  }

  /**
   * Take the work on: accession the referral into this laboratory's own queue.
   *
   * WHY A REFERRAL BECOMES A REAL ORDER
   * -----------------------------------
   * It used to be reported in one shot — a form with values and a typed name,
   * transmitted straight back. A local order goes ORDERED → COLLECTED →
   * IN_PROGRESS → RESULTED → VERIFIED, with specimen acceptance at one end and
   * authorisation at the other. Same laboratory, same bench, two workflows.
   *
   * There was no reason for that, and it skipped the control this module is
   * built around: "nothing is a result until it is verified" held for a
   * hospital's own orders and not for the work it did for anybody else. Under
   * ISO 15189 the *performing* laboratory owns the examination and its release,
   * so a referral is a send-out rather than a shortcut — the reference lab
   * accessions it and issues an authorised report like any other.
   *
   * From here the order is indistinguishable from local work. The return leg
   * fires on verification, which is what puts the two-step gate on both sides.
   */
  async accept(id: number, user: AuthUser, mappings: { referralItemId: number; labTestId: number }[] = []) {
    const referral = await this.prisma.labReferral.findUnique({
      where: { id },
      include: { items: true, localOrder: { select: { id: true } } },
    });
    if (!referral) throw new NotFoundException('No such referral');
    if (referral.declinedAt) throw new ConflictException('That referral was declined');
    if (referral.resultedAt) throw new ConflictException('That referral has already been reported');
    if (referral.localOrder) {
      // The unique index on `lab_orders.referralId` is the real guarantee; this
      // is only here to produce a sentence somebody can act on.
      throw new ConflictException('That referral has already been accepted');
    }

    /*
     * Map the sender's test codes onto this laboratory's own catalogue.
     *
     * Codes are the only thing the two hospitals share — names drift and ids
     * are meaningless across a tenant boundary. A code this lab does not offer
     * is not a silent skip: the technician is told which one, because the
     * answer is either to add it to the catalogue or to decline the referral,
     * and both are decisions a person makes.
     */
    const chosen = new Map(mappings.map((m) => [m.referralItemId, m.labTestId]));

    /*
     * Codes first, then whatever the technician mapped by hand.
     *
     * A code match is only a convenience: two independent businesses have no
     * reason to share a compendium, so `FBC` here and `CBC` there is the normal
     * case rather than the exception. Where the codes agree this costs one tap;
     * where they do not, the technician says which of their own tests it is.
     */
    /*
     * Every active test, not just the codes that happen to match.
     *
     * The code comparison below is case- and whitespace-insensitive, which a
     * database `in` filter on the raw strings cannot do portably — and a
     * catalogue holding `Fbc` against a referral sending `FBC` failed to match
     * for no reason a technician could see. A laboratory's catalogue is tens of
     * rows, so reading it whole costs nothing and removes a class of silent
     * near-miss.
     */
    const candidates = await this.prisma.labTest.findMany({
      where: { isActive: true },
      // `sellingPrice` is selected because the order item captures it — see
      // below. Reading it back off the catalogue at invoice time is the
      // `medicineName`-as-FK trap: repricing next year would restate what
      // another hospital was charged today.
      select: { id: true, code: true, name: true, specimenType: true, sellingPrice: true },
    });
    /** Codes are compared trimmed and upper-cased — `fbc`, ` FBC ` and `FBC` are one test. */
    const normalise = (code: string) => code.trim().toUpperCase();

    const byCode = new Map(candidates.map((t) => [normalise(t.code), t]));
    const byId = new Map(candidates.map((t) => [t.id, t]));

    const resolved = referral.items.map((item) => ({
      item,
      // The technician's choice wins over a code that happens to collide.
      test: chosen.has(item.id) ? byId.get(chosen.get(item.id)!) : byCode.get(normalise(item.testCode)),
    }));

    const unmatched = resolved.filter((r) => !r.test);
    if (unmatched.length > 0) {
      /*
       * Names the tests rather than the codes, and asks for a mapping rather
       * than telling a technician to do an administrator's job.
       *
       * The old message said "add it to the catalogue", which is a route the
       * person reading it does not have — creating a test is admin-only. A
       * refusal whose instruction the reader cannot follow is the shape this
       * project has hit six times, and it is worse than no message.
       */
      throw new BadRequestException(
        `Say which of your tests these are: ${unmatched.map((r) => `${r.item.testName} (${r.item.testCode})`).join(', ')}`,
      );
    }

    const accepted = await this.prisma.$transaction(async (tx) => {
      /*
       * The referred patient is registered here, and flagged.
       *
       * A laboratory labels tubes and prints a report carrying identifiers, so
       * it genuinely needs a patient row. What it must not do is put a stranger
       * into the list reception searches — the same objection that keeps a
       * pharmacy walk-in out of `Patient` entirely — so the row is marked and
       * patient search excludes it.
       */
      const patient = await tx.patient.create({
        data: {
          tenantId: currentTenantId(),
          fullName: referral.patientName,
          // The sender may not have sent one; `dob` is required here and a
          // referral's is optional. The epoch is a visible placeholder rather
          // than a plausible wrong date.
          dob: referral.patientDob ?? new Date(0),
          /*
           * OTHER as a placeholder, and it is a real limitation.
           *
           * `LabReferral` carries a name and a date of birth and no sex, so the
           * performing lab does not know it — and reference ranges are banded
           * by age *and* sex. Recorded in CLAUDE.md rather than guessed at:
           * inventing a sex to make a range apply would produce a flag that
           * looks authoritative and may be wrong in the direction that matters.
           */
          gender: Gender.OTHER,
          isReferralOrigin: true,
        },
      });

      const order = await tx.labOrder.create({
        data: {
          tenantId: currentTenantId(),
          /*
           * Our own number for the tube, because the work is now ours.
           *
           * The sender's travels on the referral and is shown beside it — a
           * reference laboratory labels an incoming specimen with its own
           * accession and reports under it, and quoting the referring site's
           * number back is a courtesy on top, never a replacement.
           */
          accession: await this.lab.nextAccession(tx),
          /*
           * A send-out arrives already drawn, so accession is a **receipt**
           * rather than a collection.
           *
           * The referring hospital took the blood, labelled the tube and put it
           * in a courier bag; the patient was never here. Landing the order in
           * ORDERED would leave a technician looking at a *collect specimen*
           * button for somebody who is not in the building — and the commonest
           * way through that is to press it anyway, recording a draw that never
           * happened at a time that is wrong.
           *
           * The **sender's** draw time is carried across rather than the moment
           * of receipt. Time since draw is what changes how a potassium, a
           * glucose or a coagulation screen should be read, and stamping it
           * with our own clock would overstate the sample's freshness by
           * however long the courier took.
           *
           * Where the sender has not drawn it yet — the referral transmitted
           * ahead of the tube, which is ordinary — the order stays ORDERED and
           * this laboratory waits for it, exactly as it should.
           */
          status: referral.collectedAt ? LabOrderStatus.COLLECTED : LabOrderStatus.ORDERED,
          collectedAt: referral.collectedAt,
          patientId: patient.id,
          // No doctor: the requester works at another company. Their name is on
          // the referral and the response reads it from there.
          doctorId: null,
          referralId: referral.id,
          priority: referral.priority,
          clinicalDetails: referral.clinicalDetails,
          items: {
            create: resolved.map(({ item: i, test }) => {
              return {
                tenantId: currentTenantId(),
                testId: test!.id,
                // Captured as text, like `PrescriptionItem.medicineName`: a
                // catalogue rename next year must not restate what was run.
                testCode: i.testCode,
                testName: test!.name,
                category: i.category,
                specimenType: test!.specimenType,
                /*
                 * The price, captured at the moment of accession.
                 *
                 * This was missing, and it is why accepted referrals raised no
                 * invoice: `chargeOrder` reads `unitPrice` off the order item,
                 * every referred item had null, so every test looked unpriced
                 * and the charge returned nothing. Local orders have always
                 * captured it here; the referral path simply did not.
                 */
                unitPrice: test!.sellingPrice,
              };
            }),
          },
        },
        select: { id: true },
      });

      await tx.labReferral.update({
        where: { id: referral.id },
        data: { acceptedAt: new Date() },
      });

      /*
       * Charge for the work, to whoever the referral says owes it.
       *
       * Accepting raised a real order and no invoice at all, so referred work
       * was done for nothing — the exact counterpart of the unpriced dispense
       * that this codebase surfaces daily, except silent, because no screen
       * lists another company's debts.
       *
       * Which party is charged comes from `referral.billing`, snapshotted by
       * the sending hospital. Under ORIGIN_PAYS that is the institution and the
       * invoice carries no patient; under PATIENT_PAYS it is the patient, who
       * is the one who will actually walk up to this counter — and who, at the
       * other end, was deliberately charged nothing.
       *
       * Exactly one invoice exists between the two organisations either way.
       * That is the property worth holding on to, and `referral-billing.spec.ts`
       * asserts it in both directions.
       */
      const charge = await this.lab.chargeReferredOrder(
        tx,
        order.id,
        referral.billing,
        // Their hospital *and* their order number. An institutional invoice
        // that names only the company is one they cannot match to anything
        // when it arrives — which is the same complaint from the other side of
        // the same transaction.
        referral.sourceAccession
          ? `${referral.sourceTenantName} · ${referral.sourceAccession}`
          : referral.sourceTenantName,
        patient.id,
      );

      return {
        id: referral.id,
        accepted: true,
        orderId: order.id,
        patientId: patient.id,
        invoiceId: charge.invoiceId,
        /** Tests with no price, so the technician is told rather than finding out later. */
        unpriced: charge.unpriced,
        chargedTotal: charge.total ?? null,
        chargedTests: resolved.length,
      };
    });

    /*
     * Tell the referring hospital what it now owes.
     *
     * Under ORIGIN_PAYS the invoice above is raised against them and lives in
     * *this* laboratory's tenant, so from their side the debt is invisible:
     * their books show the patient's charge and nothing owing, and "what do we
     * owe this lab" cannot be answered anywhere in their product. They find out
     * when a statement arrives.
     *
     * OUTSIDE THE TRANSACTION, deliberately, exactly as `transmit` is. The
     * write enters another tenant's scope and `TenantInterceptor` already holds
     * one pool connection for this request — nesting a second `forTenant`
     * inside the accession transaction is the self-deadlock this project
     * already shipped once.
     *
     * The cost of that is a window where the work is accepted and the notice
     * is not written. That is the right way round: a failure here must not
     * roll back an accession the laboratory has already committed to, and the
     * unique index makes a retry safe rather than doubling the debt. It is
     * best-effort and says so — the authoritative record is the lab's own
     * invoice, and this is a copy so the other party can see it.
     */
    await this.noticeCharge(referral, accepted);

    return accepted;
  }

  /**
   * Write the payable into the sending hospital's books.
   *
   * PATIENT_PAYS writes nothing, because the hospital owes nothing — the
   * patient settles at the counter. Writing a zero, or a row marked "not
   * yours", would put another company's transaction into their payables for
   * the sake of symmetry.
   */
  private async noticeCharge(
    referral: {
      id: number;
      billing: ReferralBilling;
      sourceTenantId: number;
      reference: string;
      sourceAccession: string | null;
    },
    accepted: { chargedTotal: string | null; chargedTests: number },
  ) {
    if (referral.billing !== ReferralBilling.ORIGIN_PAYS) return;
    if (!accepted.chargedTotal || Number(accepted.chargedTotal) <= 0) return;

    const us = await this.prisma.tenant.findUnique({
      where: { id: currentTenantId() },
      select: { id: true, name: true },
    });
    if (!us) return;

    try {
      await this.prisma.forTenant(referral.sourceTenantId, () =>
        this.prisma.partnerLabCharge.create({
          data: {
            tenantId: referral.sourceTenantId,
            partnerTenantId: us.id,
            // Denormalised, so the notice still names us after a rename or
            // after they have removed the partnership.
            partnerName: us.name,
            sourceReferralId: referral.id,
            reference: referral.reference,
            // Their order number, so the hospital that owes this can answer
            // "what is this charge for" from its own records.
            sourceAccession: referral.sourceAccession,
            // Narrowed above, and stated here because Prisma's Decimal input
            // does not accept null and a silent `?? 0` would record a debt of
            // nothing as though somebody had decided it was free.
            amount: accepted.chargedTotal as string,
            testCount: accepted.chargedTests,
          },
        }),
      );
    } catch (err) {
      /*
       * Only a duplicate is swallowed, and only because it means the notice is
       * already there. Anything else is re-thrown: a silent failure here is a
       * debt the other hospital never learns about, which is the exact fault
       * this method exists to fix.
       */
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }

  /**
   * The specimen was unusable — tell the sender to take another.
   *
   * Distinct from `decline`, and the distinction is the point. Declining means
   * "we will not do this work" and closes the referral; rejecting means "this
   * sample cannot be run, send another" and leaves it open at both ends. The
   * ordering hospital sees REJECTED either way, but only one of them leaves
   * their referral still live here.
   */
  async rejectBack(id: number, reason: string) {
    const referral = await this.prisma.labReferral.findUnique({
      where: { id },
      select: { id: true, sourceTenantId: true, sourceOrderId: true, resultedAt: true },
    });
    if (!referral) throw new NotFoundException('No such referral');
    if (referral.resultedAt) {
      throw new ConflictException('That referral has already been reported');
    }

    await this.pushBack(referral.sourceTenantId, async () => {
      await this.prisma.labOrder.update({
        where: { id: referral.sourceOrderId },
        data: {
          status: LabOrderStatus.REJECTED,
          rejectedAt: new Date(),
          rejectReason: `The partner lab could not run this sample: ${reason}`,
        },
      });
    });

    return { id, rejected: true };
  }

  async decline(id: number, reason: string) {
    const referral = await this.prisma.labReferral.findUnique({ where: { id } });
    if (!referral) throw new NotFoundException('No such referral');
    if (referral.resultedAt) {
      throw new ConflictException('That referral has already been reported');
    }

    await this.prisma.labReferral.update({
      where: { id },
      data: { declinedAt: new Date(), declineReason: reason.trim() },
    });

    /*
     * The decline is written back too, and it has to be. A sending hospital
     * that never learns a sample was rejected is a hospital whose patient is
     * waiting for a result nobody is producing — which is the failure this
     * whole return leg exists to prevent.
     */
    await this.pushBack(referral.sourceTenantId, async () => {
      await this.prisma.labOrder.update({
        where: { id: referral.sourceOrderId },
        data: {
          status: LabOrderStatus.REJECTED,
          rejectedAt: new Date(),
          rejectReason: `Declined by the partner lab: ${reason.trim()}`,
        },
      });
    });

    return { id, declined: true };
  }

  /**
   * Send the result back to the hospital that ordered it.
   *
   * The mirror of `transmit`. Everything about it is deliberately narrow: it
   * writes only onto the order items this referral named, only while that order
   * is unauthorised, and only once.
   */
  async returnResult(id: number, dto: ReturnReferralResultDto) {
    const referral = await this.prisma.labReferral.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!referral) throw new NotFoundException('No such referral');
    if (referral.declinedAt) throw new ConflictException('That referral was declined');
    if (referral.resultedAt) {
      throw new ConflictException(
        'That referral has already been reported. A correction is a new order, so the original stays readable',
      );
    }

    /*
     * The allowlist. Every id written to must appear on this referral —
     * re-checked here rather than trusted from the request body, because the
     * body is the one thing a partner controls.
     */
    const allowed = new Set(referral.items.map((i) => i.sourceOrderItemId));
    const unknown = dto.items.filter((i) => !allowed.has(i.sourceOrderItemId));
    if (unknown.length > 0) {
      throw new BadRequestException('That result names a test which is not on this referral');
    }

    const missing = referral.items.filter(
      (i) => !dto.items.some((d) => d.sourceOrderItemId === i.sourceOrderItemId),
    );
    if (missing.length > 0) {
      // Every test on the requisition, or none of it — the same rule the
      // in-house `verify` applies, for the same reason: a partial report looks
      // complete, and the tests missing from it are the ones nobody chases.
      throw new ConflictException(
        `Still to be reported: ${missing.map((i) => i.testName).join(', ')}`,
      );
    }

    /*
     * The files, read on **our** side before the scope switches.
     *
     * WHY THE REPORT HAD TO START TRAVELLING
     * --------------------------------------
     * Reported from use: the partner authorised a report with a PDF attached
     * and the ordering doctor saw values and no document. For a full blood
     * count the analytes are the result; for histopathology, cytology or any
     * imaging the **file is the result**, and this return leg carried values,
     * findings, impression and methodology and nothing else. So the one thing
     * the referring clinician actually needed never crossed — and it looked
     * like an empty report rather than a missing one.
     *
     * Copied rather than linked, exactly as `PrescriptionReferralItem` copies
     * medicine text. Linking means the ordering hospital reading a row in the
     * laboratory's tenant, which is the RLS carve-out this whole feature was
     * built to avoid — `tenantId = app_current_tenant()` stays the whole truth
     * on both sides.
     *
     * Read here, outside `pushBack`, because inside it the tenancy proxy points
     * at the *sender's* transaction and these rows are ours. That is the same
     * ordering mistake `provisioning` made once, arriving in a new place.
     */
    const localItems = await this.prisma.labOrderItem.findMany({
      where: { order: { referralId: referral.id } },
      select: { id: true, testCode: true, testName: true },
    });
    /*
     * The same pairing `transmitIfReferred` used to build the values above —
     * one implementation, so a file cannot land on a different test from the
     * numbers it belongs to.
     */
    const sourceIdOf = sourceItemIdByLocalId(matchReferralItems(localItems, referral.items));

    const attachments = await this.prisma.labAttachment.findMany({
      where: { orderItem: { order: { referralId: referral.id } } },
      orderBy: { id: 'asc' },
      select: {
        orderItemId: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        checksum: true,
        kind: true,
        description: true,
        /*
         * The second method in this service's history to pull the bytes, and
         * `lab-attachments.spec.ts` names it as a deliberate exception rather
         * than letting the count drift. There is no way to move a file across a
         * tenant boundary without reading it, and the alternative was the
         * policy exception above.
         */
        data: { select: { content: true } },
      },
    });

    await this.pushBack(referral.sourceTenantId, async () => {
      const order = await this.prisma.labOrder.findUnique({
        where: { id: referral.sourceOrderId },
        select: { id: true, status: true },
      });
      if (!order) throw new NotFoundException('The ordering hospital no longer has that order');
      if (order.status === LabOrderStatus.VERIFIED) {
        throw new ConflictException('The ordering hospital has already reported that order');
      }

      for (const item of dto.items) {
        await this.prisma.labResultValue.deleteMany({ where: { orderItemId: item.sourceOrderItemId } });
        if (item.values?.length) {
          await this.prisma.labResultValue.createMany({
            data: item.values.map((v, i) => ({
              tenantId: referral.sourceTenantId,
              orderItemId: item.sourceOrderItemId,
              analyteName: v.analyteName.trim(),
              unit: v.unit ?? null,
              value: v.value.trim(),
              /*
               * No numeric parse and no re-flagging. The partner's analyser
               * has the partner's reference intervals, and recomputing a flag
               * against this hospital's catalogue would be one organisation
               * asserting something about a measurement it did not make.
               */
              numericValue: null,
              referenceRange: null,
              flag: LabResultFlag.UNKNOWN,
              position: i,
            })),
          });
        }

        await this.prisma.labOrderItem.update({
          where: { id: item.sourceOrderItemId },
          data: {
            findings: item.findings?.trim() || null,
            impression: item.impression?.trim() || null,
            methodology: item.methodology?.trim() || null,
            resultedAt: new Date(),
            // No `resultedById` — the person who ran it has no account at the
            // ordering hospital, and inventing one would make a partner's work
            // indistinguishable from their own staff's in an audit.
            performedByName: dto.verifiedBy.trim(),
          },
        });
      }

      /*
       * The files, written onto the matching test in their record.
       *
       * A snapshot, like everything else that crosses: bytes, name, sniffed
       * type, size and checksum, copied. The checksum travels so both parties
       * can say the document they hold is the one that was issued, which is the
       * question asked when a report is disputed.
       *
       * `uploadedById` is deliberately **null**. The technician who attached it
       * has no account at the ordering hospital, and inventing one would make a
       * partner's file indistinguishable from their own staff's in an audit —
       * the same rule that keeps `resultedById` null on a returned result.
       * `LabOrder.routedToTenantId` and the routing trail already name which
       * laboratory it came from, on the order the file hangs off.
       *
       * Every attachment crosses, not only the signed report. The referring
       * clinician gets what the laboratory holds — an analyser printout beside
       * the PDF is context a doctor can use, and deciding on their behalf that
       * the raw trace is "internal" is the sort of curation that leaves
       * somebody ringing up to ask for it.
       */
      for (const file of attachments) {
        const sourceOrderItemId = sourceIdOf.get(file.orderItemId);
        /*
         * Skipped rather than guessed. A file whose test could not be matched
         * has nowhere honest to go, and attaching it to the wrong test is worse
         * than not sending it — the same refusal the values half makes, which
         * has already blocked the transmission and named the test by here.
         */
        if (sourceOrderItemId === undefined || !file.data) continue;

        await this.prisma.labAttachment.create({
          data: {
            tenantId: referral.sourceTenantId,
            orderItemId: sourceOrderItemId,
            fileName: file.fileName,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            checksum: file.checksum,
            kind: file.kind,
            description: file.description,
            uploadedById: null,
            data: {
              create: {
                tenantId: referral.sourceTenantId,
                content: new Uint8Array(file.data.content),
              },
            },
          },
        });
      }

      /*
       * Authorised on arrival, and named.
       *
       * The partner's pathologist signed it off; asking the ordering
       * hospital's technician to authorise a report they did not produce would
       * be a rubber stamp, and in a clinic with no lab there is no technician
       * to ask — which is exactly the clinic most likely to use a partner.
       *
       * Last, deliberately: everything above is written while the order is
       * still unverified, and this is the line that makes the whole thing
       * readable. One transaction, so a failure part-way leaves the ordering
       * hospital with an order still in progress rather than an authorised
       * report missing its files.
       */
      await this.prisma.labOrder.update({
        where: { id: referral.sourceOrderId },
        data: {
          status: LabOrderStatus.VERIFIED,
          verifiedAt: new Date(),
          externalVerifiedBy: dto.verifiedBy.trim(),
        },
      });
    });

    await this.prisma.labReferral.update({
      where: { id },
      data: { resultedAt: new Date() },
    });

    return { id, reported: true };
  }

  /**
   * Enter the ordering hospital's scope and write.
   *
   * The only place in this module that leaves the caller's tenant, and the
   * reason it is one method: a second copy of `forTenant(sourceTenantId, …)`
   * somewhere else in the file is how a cross-tenant write eventually happens
   * without the checks above it.
   */
  private pushBack(sourceTenantId: number, write: () => Promise<void>) {
    /*
     * `forTenant` opens a transaction, sets `app.tenant_id` on it with
     * `set_config(..., true)` — transaction-local, never plain `SET`, which
     * would persist on a pooled connection into the next request — and runs
     * the callback inside it. The tenancy proxy then routes every
     * `this.prisma.<model>` call in `write` onto that transaction, which is
     * why the callback takes no client of its own.
     */
    return this.prisma.forTenant(sourceTenantId, write);
  }
}
