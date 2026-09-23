import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The specimen is drawn where the patient is, and only the tube travels.
 *
 * THE SCENARIO THIS EXISTS FOR
 * ----------------------------
 * A clinic with a doctor and no bench. The patient is in *its* waiting room,
 * gives the sample at *its* desk and pays *its* bill; the tube goes to a
 * partner laboratory by courier, and the laboratory invoices the clinic. That
 * is `ORIGIN_PAYS` with in-house collection, and it is the commonest reason a
 * small practice has a partner at all.
 *
 * WHAT WAS MISSING
 * ----------------
 * The billing half was built and the *specimen* half was not. `worklist()`
 * filtered every segment to `destination: IN_HOUSE`, on the reasoning that
 * work running elsewhere "is work somebody else is doing" — true of the
 * examination and false of the tube. So a PARTNER order vanished from the only
 * screen that could record a collection: the clinic had nowhere to say the
 * blood had been taken, no moment at which to print the label, and nothing to
 * hand the courier, while the patient stood in front of them.
 *
 * At the other end the mirror fault: accepting a referral landed the order in
 * ORDERED, so a technician was shown a *collect specimen* button for somebody
 * who was never in the building. The commonest way through that is to press it
 * anyway, which records a draw that did not happen at a time that is wrong.
 */

const read = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');
const LAB = read('lab.service.ts');
const REFERRAL = read('lab-referral.service.ts');
const CONTROLLER = read('lab.controller.ts');

describe('the referring hospital can collect and send', () => {
  it('keeps partner orders on a worklist segment of their own', () => {
    expect(LAB).toMatch(/sendout: \{[\s\S]{0,200}destination: LabOrderDestination\.PARTNER/);
  });

  it('does not narrow that segment back to the hospital own bench', () => {
    /*
     * The `IN_HOUSE` filter is right for every other segment and would empty
     * this one — a spread that overrides the segment's own `destination` is
     * exactly how this list would silently go blank again.
     */
    expect(LAB).toMatch(/filter === 'sendout' \? \{\} : \{ destination: LabOrderDestination\.IN_HOUSE \}/);
  });

  it('lets a nurse draw the blood', () => {
    /*
     * A clinic with no bench has no laboratory technician in the building, and
     * on a ward it is a nurse who draws. Requiring LAB_TECHNICIAN left the
     * commonest send-out arrangement unable to record a collection at all.
     */
    expect(CONTROLLER).toMatch(
      /@Post\('orders\/:id\/collect'\)\s*\n\s*@Roles\(UserRole\.LAB_TECHNICIAN, UserRole\.NURSE\)/,
    );
  });

  it('records dispatch separately from collection', () => {
    /*
     * The gap between them is real: a specimen drawn at 09:14 and couriered at
     * 16:00 spent the day on a bench, and a potassium from it reads
     * differently. One timestamp for both would make a laboratory's judgement
     * about sample integrity a guess.
     */
    expect(LAB).toMatch(/async dispatch\(/);
    expect(LAB).toMatch(/dispatchedAt/);
  });

  it('refuses to send a tube nobody has drawn', () => {
    /*
     * Telling a partner something is on its way when it is not makes them wait
     * for a van rather than ring to ask.
     */
    expect(LAB).toMatch(/Take the specimen first/);
  });

  it('tells the partner when it was drawn, outside the transaction', () => {
    // Enters another tenant's scope, so it must not nest inside one this
    // request already holds — the self-deadlock this project shipped once.
    expect(REFERRAL).toMatch(/async noticeDispatch\(/);
    expect(REFERRAL).toMatch(/forTenant\(partnerTenantId/);
    expect(LAB).toMatch(/await this\.referrals\.noticeDispatch\(/);
  });
});

describe('the worklist says what is owed, and gates nothing on it', () => {
  /*
   * The person drawing the blood is standing in front of the patient, which is
   * the only moment the money is easy to collect. The row carried `invoiceId`
   * and nothing else — so a technician could see that *an* invoice existed and
   * not whether it was settled, which is the half that decides whether to ask.
   *
   * THE LINE THIS MUST NOT CROSS
   * ---------------------------
   * Payment gates nothing, and the temptation is at its strongest here because
   * the payer is right there and refusing to draw blood until they pay looks
   * like ordinary shop behaviour. It is the same gate `lab-billing.spec.ts`
   * and `consultation-billing.spec.ts` assert the absence of, and this screen
   * is where somebody would add it first.
   */
  const WEB = readFileSync(
    path.resolve(__dirname, '../../..', 'web/app/(app)/lab/worklist/page.tsx'),
    'utf8',
  );

  it('sends whether anything is still owed, not just that an invoice exists', () => {
    expect(LAB).toMatch(/settled: outstandingMinor <= 0/);
  });

  it('computes what is owed as charge minus credits minus payments', () => {
    /*
     * Never `total - paid`, which is the arithmetic that made a refund reopen
     * a balance nobody was chasing — the bug the credit-note work was written
     * to close, and it would reappear here as a lab row demanding money that
     * had already been given back.
     */
    expect(LAB).toMatch(/toMinor\(toMoneyString\(r\.invoice\.creditedAmount\)\)/);
  });

  it('carries no invoice lines onto the worklist', () => {
    /*
     * Four columns, deliberately. Including the invoice whole would put its
     * lines — and therefore test names — on a screen through a back door,
     * which is the leak `invoice-response.ts` shapes every other path to
     * prevent.
     *
     * SCOPED TO `worklist()`, AND IT HAD TO BE.
     * -----------------------------------------
     * This searched the whole file, and the day `statements()` arrived it
     * failed on a query it has nothing to say about — a monthly statement
     * selects `invoice` for its totals and `_count: { select: { items: true } }`
     * beside it, which is a *count* and is exactly the shape a statement is
     * supposed to carry.
     *
     * A file-wide matcher standing in for a statement about one query is the
     * same fault the `labSummaryDescription` guard had: the tempting repair is
     * to widen the character window until it stops matching, which quietly
     * leaves the rule asserting nothing. Naming the method is the honest fix,
     * and `lab-statement.spec.ts` asserts the statement's own version of the
     * rule — no test *name*, ever.
     */
    const start = LAB.indexOf('async worklist(');
    const body = LAB.slice(start, LAB.indexOf('async collect(', start));
    expect(start).toBeGreaterThan(-1);

    expect(body).toMatch(/invoice: \{[\s\S]{0,400}creditedAmount: true/);
    expect(body).not.toMatch(/invoice: \{[\s\S]{0,400}items:/);
  });

  it('offers payment as a link and never as a condition', () => {
    // The action is a navigation. A `disabled` bound to the invoice, or a
    // refusal in `collect`/`dispatch`, is the gate this must not become.
    expect(WEB).toMatch(/href=\{`\/lab\/invoices\?invoice=\$\{r\.invoice\.id\}`\}/);
    expect(LAB).not.toMatch(/async (collect|dispatch)[\s\S]{0,900}invoice[\s\S]{0,80}throw/);
  });
});

describe('the partner receives a specimen rather than drawing one', () => {
  it('accessions an already-drawn tube as collected', () => {
    expect(REFERRAL).toMatch(
      /status: referral\.collectedAt \? LabOrderStatus\.COLLECTED : LabOrderStatus\.ORDERED/,
    );
  });

  it('carries the sender draw time rather than stamping its own', () => {
    /*
     * Time since draw is what changes how a potassium, a glucose or a
     * coagulation screen should be read. Using the moment of receipt would
     * overstate the sample's freshness by however long the courier took.
     */
    expect(REFERRAL).toMatch(/collectedAt: referral\.collectedAt/);
    expect(REFERRAL).not.toMatch(/collectedAt: new Date\(\)/);
  });

  it('raises its own accession for the work it has taken on', () => {
    /*
     * This silently did not land on the first attempt — the replace missed and
     * every referred order went in with no number, which is invisible until
     * somebody tries to print a label for it.
     */
    expect(REFERRAL).toMatch(/accession: await this\.lab\.nextAccession\(tx\)/);
  });

  it('sends the specimen state to the incoming queue', () => {
    // A referral with no draw time is one whose tube has not been taken.
    // Showing nothing makes that look like a sample that went missing.
    expect(REFERRAL).toMatch(/collectedAt: r\.collectedAt/);
    expect(REFERRAL).toMatch(/dispatchedAt: r\.dispatchedAt/);
  });
});
