import { ValidationPipe } from '@nestjs/common';
import {
  AddLabPartnerDto,
  CancelLabOrderDto,
  CreateLabOrderDto,
  CreateLabTestDto,
  CriticalNotifiedDto,
  RecordResultDto,
  RejectSpecimenDto,
  ReturnReferralResultDto,
  UpdateLabTestDto,
  VerifyLabOrderDto,
} from './dto/lab.dto';

/**
 * The bodies the clients actually send, through the pipe that actually runs.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `POST /lab-tests` returned 400 on every create. The admin form built one
 * object and posted it to both the create and the update route, adding `code`
 * for the create — one line shorter, and wrong, because `isActive` belongs to
 * `UpdateLabTestDto` and not to `CreateLabTestDto`. The global pipe runs with
 * `forbidNonWhitelisted: true`, correctly refused it, and the reply said
 * "Bad Request Exception" and nothing else.
 *
 * WHY THIS IS A TEST AND NOT JUST A FIX
 * -------------------------------------
 * Nothing in the repo compared a client body with the DTO meant to receive it.
 * Typechecking cannot: the client posts an object literal to a `body` parameter
 * typed `unknown`, and the DTO is a runtime contract enforced by decorators. So
 * the two are free to disagree, and the disagreement surfaces as a 400 in a log
 * — which is how this one arrived.
 *
 * These fixtures are copied from the call sites. They go stale if a screen
 * changes and this file does not, which is a real limitation and still leaves
 * this far better than nothing: every shape below is one a user can produce,
 * and three of them are the awkward ones — all-null, empty-array, and the
 * imaging test with no analytes at all.
 */

/** The real thing, configured exactly as `main.ts` configures it. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

async function reasons(body: unknown, metatype: unknown): Promise<string[]> {
  try {
    await pipe.transform(body, { type: 'body', metatype: metatype as never });
    return [];
  } catch (e) {
    const response = (e as { response?: { message?: string[] } }).response;
    return response?.message ?? [String(e)];
  }
}

const accepts = async (body: unknown, metatype: unknown) => expect(await reasons(body, metatype)).toEqual([]);

describe('the test catalogue', () => {
  const analyte = {
    name: 'Haemoglobin',
    unit: 'g/L',
    refLow: '130',
    refHigh: '170',
    refText: null,
    criticalLow: '70',
    criticalHigh: '200',
    position: 0,
  };

  const created = {
    code: 'FBC',
    name: 'Full blood count',
    category: 'HAEMATOLOGY',
    specimenType: 'BLOOD',
    sellingPrice: '12.00',
    turnaroundHours: 4,
    preparation: 'Purple-top EDTA tube.',
    analytes: [analyte],
  };

  it('accepts what the admin form posts', async () => {
    await accepts(created, CreateLabTestDto);
  });

  it('accepts a worded range instead of a numeric one', async () => {
    // A urine culture is "No growth", not a pair of numbers — and this is the
    // shape most likely to be forgotten, because every other analyte has
    // limits.
    await accepts(
      {
        ...created,
        code: 'MSU',
        analytes: [
          {
            name: 'Culture',
            unit: null,
            refLow: null,
            refHigh: null,
            refText: 'No growth',
            criticalLow: null,
            criticalHigh: null,
            position: 0,
          },
        ],
      },
      CreateLabTestDto,
    );
  });

  it('accepts an imaging test: unpriced, no specimen, no analytes', async () => {
    /*
     * Three awkward things at once, all of them ordinary. An X-ray has no
     * analytes and no specimen, and `sellingPrice: null` means nobody has
     * priced it — which is not zero, and which the form has to be able to send.
     */
    await accepts(
      {
        code: 'CXR',
        name: 'Chest X-ray',
        category: 'IMAGING',
        specimenType: 'NONE',
        sellingPrice: null,
        turnaroundHours: null,
        preparation: null,
        analytes: [],
      },
      CreateLabTestDto,
    );
  });

  it('refuses isActive on create, which is what the 400 was', async () => {
    /*
     * Pinned deliberately. `isActive` is not merely absent from the create DTO
     * by oversight — a new test is offered by definition, so there is nothing
     * to decide, and adding the field to make the error go away would create a
     * parameter that silently does nothing.
     *
     * The fix was on the client: build the two bodies separately, because
     * feeding two different contracts from one literal makes them look
     * interchangeable when they are not.
     */
    expect(await reasons({ ...created, isActive: true }, CreateLabTestDto)).toContain(
      'property isActive should not exist',
    );
  });

  it('accepts isActive on update, where retiring a test is the point', async () => {
    const { code: _code, ...rest } = created;
    await accepts({ ...rest, isActive: false }, UpdateLabTestDto);
  });

  it('accepts clearing the price on update', async () => {
    // Null clears it; the service tells "not sent" from "sent as null", which
    // is the distinction that threw a 500 on the letterhead the first time.
    await accepts({ sellingPrice: null }, UpdateLabTestDto);
  });

  it('accepts a price-only patch, which is the inline fix from two screens', async () => {
    await accepts({ sellingPrice: '9.50' }, UpdateLabTestDto);
  });
});

describe('ordering', () => {
  it('accepts what both order screens post', async () => {
    await accepts(
      {
        patientId: 12,
        testIds: [1, 2],
        priority: 'ROUTINE',
        destination: 'IN_HOUSE',
        clinicalDetails: '?anaemia, 3 months',
      },
      CreateLabOrderDto,
    );
  });

  it('accepts a partner send', async () => {
    await accepts(
      { patientId: 12, testIds: [3], priority: 'URGENT', destination: 'PARTNER', partnerId: 4 },
      CreateLabOrderDto,
    );
  });

  it('accepts an order with no clinical details', async () => {
    // Wanted, and not required — a doctor who leaves it blank still gets their
    // test, and the screen asks rather than insists.
    await accepts({ patientId: 12, testIds: [1] }, CreateLabOrderDto);
  });

  it('refuses an empty requisition', async () => {
    expect(await reasons({ patientId: 12, testIds: [] }, CreateLabOrderDto)).not.toEqual([]);
  });

  it('accepts a cancellation with a reason and refuses a bare one', async () => {
    await accepts({ reason: 'Ordered in error — duplicate of yesterday.' }, CancelLabOrderDto);
    expect(await reasons({ reason: 'no' }, CancelLabOrderDto)).not.toEqual([]);
  });
});

describe('resulting', () => {
  it('accepts values, findings and an impression together', async () => {
    await accepts(
      {
        values: [{ analyteName: 'Haemoglobin', value: '128', unit: 'g/L' }],
        findings: 'Mild normocytic anaemia.',
        impression: 'Consistent with chronic disease.',
        methodology: 'Sysmex XN-1000',
      },
      RecordResultDto,
    );
  });

  it('accepts a censored value and a worded one', async () => {
    /*
     * `value` is a string precisely so these are possible. A numeric column
     * would force "<0.01" into a note nobody reads, or into a zero, which is a
     * lie about a laboratory measurement.
     */
    await accepts(
      {
        values: [
          { analyteName: 'Troponin', value: '<0.01', unit: 'ng/mL' },
          { analyteName: 'Culture', value: 'Growth of E. coli', unit: null },
        ],
      },
      RecordResultDto,
    );
  });

  it('accepts a narrative-only report, which is what imaging is', async () => {
    await accepts(
      { findings: 'Clear lung fields. No effusion.', impression: 'Normal chest radiograph.' },
      RecordResultDto,
    );
  });

  it('accepts a long histopathology report', async () => {
    // Truncating one is a clinical error rather than a formatting one, so the
    // cap is generous and this checks it really is.
    await accepts({ findings: 'a'.repeat(15_000) }, RecordResultDto);
  });

  it('accepts the empty verify body both clients send', async () => {
    await accepts({}, VerifyLabOrderDto);
  });

  it('accepts a recorded telephone call and refuses an empty one', async () => {
    await accepts({ notifiedTo: 'Dr Rao, medical on-call, 03:40' }, CriticalNotifiedDto);
    expect(await reasons({ notifiedTo: '' }, CriticalNotifiedDto)).not.toEqual([]);
  });

  it('requires a reason to reject a specimen', async () => {
    // The reason is the thing that gets somebody to take another sample.
    await accepts({ reason: 'Haemolysed. Please resend in a fresh EDTA tube.' }, RejectSpecimenDto);
    expect(await reasons({}, RejectSpecimenDto)).not.toEqual([]);
  });
});

describe('the cross-tenant leg', () => {
  it('accepts what the report sheet posts back', async () => {
    await accepts(
      {
        verifiedBy: 'Dr S Mehta, Consultant Haematologist',
        items: [
          {
            sourceOrderItemId: 77,
            values: [{ analyteName: 'Haemoglobin', value: '128', unit: 'g/L' }],
            findings: 'Mild anaemia.',
            impression: null,
          },
        ],
      },
      ReturnReferralResultDto,
    );
  });

  it('accepts a value with no unit, which is what the free-text parser produces', async () => {
    /*
     * The web sheet takes "Analyte: value unit" lines and splits them. A line
     * with no space after the colon — "Culture: No growth" is split, but
     * "Result:Negative" is not — yields no unit at all, and the DTO has to
     * take it.
     */
    await accepts(
      {
        verifiedBy: 'Dr S Mehta',
        items: [{ sourceOrderItemId: 77, values: [{ analyteName: 'Result', value: 'Negative' }] }],
      },
      ReturnReferralResultDto,
    );
  });

  it('refuses a report naming no tests', async () => {
    expect(await reasons({ verifiedBy: 'Dr S Mehta', items: [] }, ReturnReferralResultDto)).not.toEqual(
      [],
    );
  });

  it('refuses a report with nobody signing it', async () => {
    // "Who signed this off" is the first thing asked when a result is queried,
    // and it arrives at a hospital where that person has no account.
    expect(
      await reasons({ items: [{ sourceOrderItemId: 1 }] }, ReturnReferralResultDto),
    ).not.toEqual([]);
  });

  it('accepts adding a partner by code', async () => {
    await accepts({ slug: 'st-marys', label: "St Mary's Pathology" }, AddLabPartnerDto);
  });
});
