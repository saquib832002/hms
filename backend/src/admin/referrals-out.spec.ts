import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REFERRAL_DESTINATIONS,
  breakdownByDestination,
  owedToPartners,
  referredBilling,
} from './referrals-out';

describe('breakdownByDestination', () => {
  const partners = [
    { partnerTenantId: 7, label: 'Apollo Chemist, Jubilee Hills' },
    { partnerTenantId: 9, label: 'MedPlus Banjara' },
  ];

  it('separates in-house, external and each named partner', () => {
    const out = breakdownByDestination(
      [
        { destination: 'IN_HOUSE', routedToTenantId: null },
        { destination: 'IN_HOUSE', routedToTenantId: null },
        { destination: 'EXTERNAL', routedToTenantId: null },
        { destination: 'PARTNER', routedToTenantId: 7 },
        { destination: 'PARTNER', routedToTenantId: 7 },
        { destination: 'PARTNER', routedToTenantId: 9 },
      ],
      partners,
    );

    expect(out.inHouse).toBe(2);
    expect(out.external).toBe(1);
    expect(out.partner).toBe(3);
    expect(out.total).toBe(6);
    expect(out.partners).toEqual([
      { tenantId: 7, label: 'Apollo Chemist, Jubilee Hills', count: 2 },
      { tenantId: 9, label: 'MedPlus Banjara', count: 1 },
    ]);
  });

  it('keeps EXTERNAL as its own row rather than an unnamed partner', () => {
    /*
     * EXTERNAL is "the patient takes it away and fills it wherever they
     * choose" — no partner, no code, nothing to name. A row reading
     * "Partner: (unknown)" would send somebody looking for a partnership that
     * was never meant to exist, and this is the figure an owner most wants:
     * work walking out of the building with no further trace.
     */
    const out = breakdownByDestination(
      [{ destination: 'EXTERNAL', routedToTenantId: null }],
      partners,
    );
    expect(out.external).toBe(1);
    expect(out.partner).toBe(0);
    expect(out.partners).toEqual([]);
  });

  it('keeps the parts adding up to the whole', () => {
    const items = [
      { destination: 'IN_HOUSE', routedToTenantId: null },
      { destination: 'EXTERNAL', routedToTenantId: null },
      { destination: 'PARTNER', routedToTenantId: 7 },
      // A PARTNER row with nobody named. Should not exist; counted as external
      // rather than dropped, so the parts still sum to the total.
      { destination: 'PARTNER', routedToTenantId: null },
    ];
    const out = breakdownByDestination(items, partners);

    expect(out.inHouse + out.external + out.partner).toBe(out.total);
    expect(out.total).toBe(items.length);
    expect(out.partner).toBe(1);
    expect(out.external).toBe(2);
    // And the split sums to the partner figure above it.
    expect(out.partners.reduce((n, p) => n + p.count, 0)).toBe(out.partner);
  });

  it('names a removed partnership by id rather than dropping its count', () => {
    /*
     * Removing a partner is a soft delete precisely so "where did this go"
     * stays answerable, and the row may be absent from the active list. A
     * count that silently disappears is worse than one labelled awkwardly.
     */
    const out = breakdownByDestination([{ destination: 'PARTNER', routedToTenantId: 42 }], []);
    expect(out.partner).toBe(1);
    expect(out.partners).toEqual([{ tenantId: 42, label: 'Partner #42', count: 1 }]);
  });

  it('orders partners by count then name, so two runs agree', () => {
    const out = breakdownByDestination(
      [
        { destination: 'PARTNER', routedToTenantId: 9 },
        { destination: 'PARTNER', routedToTenantId: 7 },
      ],
      partners,
    );
    // Tied on one each, so alphabetical by label — not by insertion order,
    // which would reshuffle when nothing changed.
    expect(out.partners.map((p) => p.label)).toEqual([
      'Apollo Chemist, Jubilee Hills',
      'MedPlus Banjara',
    ]);
  });

  it('reports zeroes rather than an empty object for a quiet period', () => {
    const out = breakdownByDestination([], partners);
    expect(out).toEqual({ inHouse: 0, external: 0, partner: 0, partners: [], total: 0 });
  });

  it('knows exactly three destinations', () => {
    // Vacuous-pass guard, and a tripwire: a fourth enum member needs a decision
    // here rather than silently falling into the PARTNER branch.
    expect([...REFERRAL_DESTINATIONS]).toEqual(['IN_HOUSE', 'EXTERNAL', 'PARTNER']);
  });
});

describe('owedToPartners', () => {
  const charge = (over: Partial<Parameters<typeof owedToPartners>[0][number]> = {}) => ({
    partnerTenantId: 7,
    partnerName: 'Vijaya Diagnostics',
    amountMinor: 10_000,
    settled: false,
    ...over,
  });

  it('totals what was charged and what is still unsettled', () => {
    const out = owedToPartners([
      charge({ amountMinor: 10_000, settled: true }),
      charge({ amountMinor: 2_500 }),
      charge({ amountMinor: 500 }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].charged).toBe('130.00');
    expect(out[0].unsettled).toBe('30.00');
    expect(out[0].charges).toBe(3);
  });

  it('takes the name off the charge, not from the partnership', () => {
    /*
     * The notice captures `partnerName` at accession, like every other
     * captured value here. A partnership relabelled next quarter must not
     * restate who charged what for work already done, and a partnership
     * *removed* would otherwise leave its historic charges nameless.
     */
    const out = owedToPartners([charge({ partnerName: 'Vijaya Diagnostics (Secunderabad)' })]);
    expect(out[0].label).toBe('Vijaya Diagnostics (Secunderabad)');
  });

  it('separates partners and orders by amount', () => {
    const out = owedToPartners([
      charge({ partnerTenantId: 7, partnerName: 'Small Lab', amountMinor: 1_000 }),
      charge({ partnerTenantId: 9, partnerName: 'Big Lab', amountMinor: 50_000 }),
    ]);
    expect(out.map((p) => p.label)).toEqual(['Big Lab', 'Small Lab']);
  });

  it('returns nothing for a period with no charges', () => {
    expect(owedToPartners([])).toEqual([]);
  });
});

describe('referredBilling', () => {
  it('counts what we charged, what is not ours, and what was missed', () => {
    const out = referredBilling([
      { unitPriceMinor: 12_000, payableExternally: false },
      { unitPriceMinor: 3_000, payableExternally: false },
      // PATIENT_PAYS: deliberately not ours to charge.
      { unitPriceMinor: null, payableExternally: true },
      { unitPriceMinor: null, payableExternally: true },
      // Ours, and nobody priced it. The one that is a real loss.
      { unitPriceMinor: null, payableExternally: false },
    ]);

    expect(out.charged).toBe('150.00');
    expect(out.payableElsewhere).toBe(2);
    expect(out.unpriced).toBe(1);
  });

  it('keeps "not ours to charge" apart from "nobody charged"', () => {
    /*
     * Third time in this project: blank is not zero for
     * `Medicine.sellingPrice` and `Doctor.consultationFee`, and *not ours to
     * charge* is not *nobody charged*. Merging them would make every "went out
     * uncharged" figure report `PATIENT_PAYS` work forever, at which point
     * people stop reading the figure that catches the real ones.
     */
    const allExternal = referredBilling([
      { unitPriceMinor: null, payableExternally: true },
      { unitPriceMinor: null, payableExternally: true },
    ]);
    expect(allExternal.payableElsewhere).toBe(2);
    expect(allExternal.unpriced).toBe(0);

    const allMissed = referredBilling([
      { unitPriceMinor: null, payableExternally: false },
      { unitPriceMinor: null, payableExternally: false },
    ]);
    expect(allMissed.payableElsewhere).toBe(0);
    expect(allMissed.unpriced).toBe(2);
  });
});

describe('the report names no medicine and no test', () => {
  const SOURCE = readFileSync(resolve(__dirname, './referrals-out.ts'), 'utf8');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('selects nothing that could carry one', () => {
    /*
     * Asserted on the *absence*, because a test that only checked the counts
     * were right would still pass if a drug name arrived beside them. A test
     * name is frequently the clinical question itself — "HIV antibody",
     * "Beta-hCG" — and this card is read by whoever reconciles bills, which is
     * the role `labSummaryDescription` and `PartnerLabCharge` already refuse to
     * name a test to.
     */
    const code = strip(SOURCE);
    for (const forbidden of [
      'medicineName',
      'medicineId',
      'testName',
      'testCode',
      'analyte',
      'diagnosis',
      'patientName',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('carries no patient identifier either', () => {
    // A referral breakdown is about organisations and counts. `patientId` here
    // would be a list of who was referred where, which is a clinical fact.
    expect(strip(SOURCE)).not.toMatch(/\bpatientId\b/);
  });
});
