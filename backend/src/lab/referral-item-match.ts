/**
 * Matching this laboratory's order items back onto the referral that asked for
 * them.
 *
 * WHY THIS IS A FILE AND NOT TWO INLINE LOOPS
 * -------------------------------------------
 * Two things need the same answer and must never disagree about it: the values
 * written back into the ordering hospital's rows, and the attached files copied
 * alongside them. If those two joins ever drift, a report arrives with the
 * potassium on one test and its PDF on another — worse than either being wrong
 * alone, because each half looks plausible.
 *
 * The same reasoning as `resolveAuditTarget`, `resolveTreatingScope` and
 * `course-quantity.ts`: the rule was retyped at each call site, and that is
 * where the divergence comes from.
 *
 * WHY TEST CODE, AND NOT ARRAY POSITION
 * -------------------------------------
 * This started as `local[i] → referred[i]` across two queries with **no
 * `orderBy` on either**. Postgres returns rows in no particular order unless
 * asked, so on a multi-test referral it could write a potassium into another
 * hospital's record under the glucose. It typechecked, it looked right, and
 * nothing would have caught it but a clinician reading an impossible result.
 *
 * `accept` captures the **sender's** `testCode` onto the local item — not this
 * laboratory's code, deliberately, since ours is meaningless across the
 * boundary. That makes the code an exact join key rather than a coincidence of
 * insertion order.
 *
 * A referral naming the same code twice is legal — a repeat on one requisition
 * — so codes are consumed from a queue in id order: the first local FBC answers
 * the first referred FBC. Deterministic, and it degrades into a *refusal* rather
 * than a guess, which is the property that matters. An unmatched test is named
 * back so somebody can telephone, because writing a result onto the wrong test
 * in another organisation's record is the worst outcome available here.
 */

/** Codes are compared trimmed and upper-cased — `fbc`, ` FBC ` and `FBC` are one test. */
const normalise = (code: string) => code.trim().toUpperCase();

export interface LocalItem {
  id: number;
  testCode: string;
  /** Only for the refusal message. */
  testName?: string;
}

export interface ReferredItem {
  /** The *ordering hospital's* order item id — what a result is written onto. */
  sourceOrderItemId: number;
  testCode: string;
}

export interface ItemMatch {
  /** Pairs, in local id order. */
  pairs: { localItemId: number; sourceOrderItemId: number }[];
  /** Local items with no referral row to answer. Names, for the message. */
  unmatched: string[];
}

export function matchReferralItems(local: LocalItem[], referred: ReferredItem[]): ItemMatch {
  const queue = new Map<string, ReferredItem[]>();
  for (const item of referred) {
    const key = normalise(item.testCode);
    const waiting = queue.get(key) ?? [];
    waiting.push(item);
    queue.set(key, waiting);
  }

  const pairs: ItemMatch['pairs'] = [];
  const unmatched: string[] = [];

  for (const item of [...local].sort((a, b) => a.id - b.id)) {
    const match = queue.get(normalise(item.testCode))?.shift();
    if (!match) {
      unmatched.push(item.testName ?? item.testCode);
      continue;
    }
    pairs.push({ localItemId: item.id, sourceOrderItemId: match.sourceOrderItemId });
  }

  return { pairs, unmatched };
}

/** Local order item id → the ordering hospital's item id. */
export function sourceItemIdByLocalId(match: ItemMatch): Map<number, number> {
  return new Map(match.pairs.map((p) => [p.localItemId, p.sourceOrderItemId]));
}
