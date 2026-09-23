import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A batch is one physical lot, and receiving must not quietly redefine it.
 *
 * WHY THIS IS A SOURCE TEST
 * -------------------------
 * The bug it guards against was a *missing* field in an update, which is
 * invisible in every way a test normally looks: the call succeeded, the
 * quantity went up, no error was raised, and the wrong expiry date sat in the
 * database looking exactly like a right one. Nothing short of reading the write
 * would have caught it, so this reads the write.
 *
 * THE BUG
 * -------
 * `receiveStock` used `upsert`, and the update branch incremented `quantity`
 * and never touched `expiresAt`. Receiving the same batch number with a
 * different expiry silently kept the old date. If the new carton expired
 * sooner, its units were recorded as in date past their real expiry — and FEFO
 * would then hand them out first, being shortest-dated. A stock system quietly
 * dispensing expired medicine is the worst failure available on this screen.
 */

const SERVICE = readFileSync(resolve(__dirname, './pharmacy.service.ts'), 'utf8');

/** The body of `receiveStock`, comments stripped. */
function receiveStock(): string {
  const start = SERVICE.indexOf('async receiveStock(');
  expect(start).toBeGreaterThan(-1);
  const end = SERVICE.indexOf('\n  async ', start + 10);
  return SERVICE.slice(start, end === -1 ? undefined : end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('receiving a delivery', () => {
  const body = receiveStock();

  it('does not upsert, because an upsert cannot refuse', () => {
    /*
     * `upsert` has exactly two outcomes — create or merge — and the case that
     * matters here is a third: the same batch number describing a different
     * lot, which must not be merged and must not become a second row either.
     * A read, then a decision, then a write.
     */
    expect(body).not.toContain('.upsert(');
    expect(body).toContain('findUnique(');
  });

  it('refuses a repeat batch whose expiry disagrees', () => {
    expect(body).toMatch(/existing\.expiresAt\.getTime\(\)\s*!==\s*expiresAt\.getTime\(\)/);
    expect(body).toContain('ConflictException');
  });

  it('names both dates, so somebody holding the carton can tell which is wrong', () => {
    // An error saying only "conflict" leaves the pharmacist with no way to act
    // except guessing, and the carton in their hand has the answer on it.
    expect(body).toContain('existing.expiresAt.toISOString()');
    expect(body).toContain('expiresAt.toISOString()');
  });

  it('never writes an expiry on the merge path', () => {
    /*
     * The positive form of the original bug. A future "fix" that sets
     * `expiresAt` on the update — which looks like exactly the right repair —
     * would silently rewrite the expiry of stock already on the shelf, under a
     * batch number that is supposed to identify one lot forever.
     */
    const update = body.slice(body.indexOf('stockBatch.update('));
    expect(update).not.toMatch(/expiresAt\s*[,:]/);
  });

  it('sets a cost price once and then leaves it alone', () => {
    /*
     * Overwriting was the previous behaviour and it restates history: units
     * from this lot may already have been sold and reported at the old cost.
     * Averaging is the accountant's answer and needs a decision about those
     * already-sold units, so it is absent rather than half-built.
     */
    expect(body).toMatch(/existing\.costPrice === null/);
  });

  it('still rejects stock that is already expired', () => {
    // Unchanged, and worth pinning beside the rest: the cheapest check here is
    // the one that stops a bad carton reaching the shelf at all.
    expect(body).toContain('That batch has already expired');
  });
});

describe('the inventory ordering', () => {
  const start = SERVICE.indexOf('async inventory(');
  const body = SERVICE.slice(start, SERVICE.indexOf('\n  async ', start + 10));

  it('defaults to expiry rather than alphabetical', () => {
    expect(SERVICE).toMatch(/async inventory\(query\?: string, sort: 'expiry' \| 'name' = 'expiry'\)/);
  });

  it('sorts medicines with nothing sellable to the bottom', () => {
    /*
     * The trap in every "sort by date" implementation: a null sorts first in a
     * naive comparator, so the list whose entire purpose is "shift this next"
     * would open with rows that have nothing to shift.
     */
    expect(body).toContain('if (a.earliestExpiry === null) return 1;');
    expect(body).toContain('if (b.earliestExpiry === null) return -1;');
  });

  it('computes the earliest expiry from sellable stock only', () => {
    // An expired batch cannot be sold. Counting it would put a medicine at the
    // top of the list on the strength of stock that has to be destroyed.
    expect(body).toMatch(/filter\(\(b\) => !b\.expired && b\.quantity > 0\)/);
  });
});
