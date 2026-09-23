import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Undoing a handover that never happened.
 *
 * THE DISTINCTION THIS FILE PROTECTS
 * ----------------------------------
 * A **refund** returns money for medicine the patient has. A **reversal**
 * undoes a handover that did not occur: the patient could not pay, or changed
 * their mind, and the box never left the counter.
 *
 * They look almost identical in the database and they are opposite in law.
 * Dispensed medicine that has left the premises cannot lawfully be resold in
 * most jurisdictions, so automatically re-incrementing stock on a refund would
 * be a regulatory problem wearing the shape of a convenience — and it would
 * overstate the number the whole dispensing flow trusts.
 *
 * Nothing in the data can tell the two apart. Only a person can, which is why
 * the caller affirms it and why that affirmation is asserted here: the
 * tempting simplification is to drop the checkbox and "just undo it", and that
 * is precisely the change that turns this into an unlawful restock button.
 */

const SERVICE = readFileSync(resolve(__dirname, './pharmacy.service.ts'), 'utf8');
const DTO = readFileSync(resolve(__dirname, './dto/reverse-dispense.dto.ts'), 'utf8');
const CONTROLLER = readFileSync(resolve(__dirname, './pharmacy.controller.ts'), 'utf8');

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function reversalBody(): string {
  const src = strip(SERVICE);
  const start = src.indexOf('async reverseDispense(');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n  private async chargeSale(', start));
}

describe('a reversal is not a return', () => {
  it('requires the caller to affirm the medicine did not leave', () => {
    /*
     * The whole safety of this feature. Without it, "reverse" becomes a
     * restock button for medicine that is already in somebody's bag.
     */
    expect(strip(DTO)).toMatch(/notLeftPremises/);
    expect(reversalBody()).toMatch(/if \(!notLeftPremises\)/);
  });

  it('names the lawful alternative when it refuses', () => {
    // A refusal that does not say what to do instead gets worked around.
    const body = SERVICE.slice(SERVICE.indexOf('async reverseDispense('));
    expect(body).toMatch(/Receive stock/);
  });

  it('refuses once money has been taken', () => {
    /*
     * Voiding a paid invoice would make a payment disappear from the day's
     * takings with nothing to explain the gap — the same class of error as the
     * refunds that were missing from the collected figure. Refund first, then
     * reverse.
     */
    expect(reversalBody()).toMatch(/amountPaid/);
  });

  it('refuses to reverse the same dispense twice', () => {
    // Otherwise stock is credited twice for one event, and the shelf count
    // silently exceeds what is on the shelf.
    expect(reversalBody()).toMatch(/reversedAt/);
  });
});

describe('what a reversal puts back', () => {
  it('returns stock to the batch it came from', () => {
    /*
     * Not to "the medicine". Returning units to whichever batch is nearest
     * expiry would quietly move stock between batches — and the batch number
     * is what a recall is traced by. `DispenseLine.batchId` exists precisely
     * so this is possible.
     */
    const body = reversalBody();
    expect(body).toMatch(/stockBatch\.update/);
    expect(body).toMatch(/id: line\.batchId/);
    expect(body).toMatch(/increment: line\.quantity/);
  });

  it('un-dispenses the prescription items by the same amount', () => {
    expect(reversalBody()).toMatch(/quantityDispensed: \{ decrement: line\.quantity \}/);
  });

  it('derives the prescription status rather than assuming ISSUED', () => {
    /*
     * A prescription dispensed in two goes, with only the second reversed, is
     * PARTIALLY_DISPENSED. Setting ISSUED blindly would put a half-filled
     * prescription back in the queue as though nothing had been handed over.
     */
    const body = reversalBody();
    expect(body).toMatch(/PARTIALLY_DISPENSED/);
    expect(body).toMatch(/anyDispensed/);
  });

  it('voids the invoice rather than deleting it', () => {
    // A bill that vanishes is one nobody can explain to the person who saw it.
    const body = reversalBody();
    expect(body).toMatch(/voidedAt: new Date\(\)/);
    expect(body).not.toMatch(/invoice\.delete/);
  });

  it('does all of it in one transaction', () => {
    /*
     * Stock, the prescription and the invoice move together or not at all. A
     * partial reversal is the worst outcome available here: stock back on the
     * shelf with the bill still standing, or a voided bill with the medicine
     * still counted as sold.
     */
    expect(reversalBody()).toMatch(/this\.prisma\.\$transaction/);
  });
});

describe('who may do it', () => {
  it('is a pharmacist decision, and is audited', () => {
    const src = strip(CONTROLLER);
    const route = src.slice(src.indexOf("@Post('dispense-events/:id/reverse')"));
    expect(route).toMatch(/@Roles\(UserRole\.PHARMACIST\)/);
    expect(route).toMatch(/@AuditAction\('DISPENSE_REVERSE'\)/);
    // Admin is excluded for the same reason it cannot dispense: an operational
    // role must not sign for medicine moving, in either direction.
    expect(route.slice(0, route.indexOf('reverseDispense('))).not.toMatch(/UserRole\.ADMIN/);
  });
});
