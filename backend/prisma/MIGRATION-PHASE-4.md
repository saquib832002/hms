# Phase 4 migration — the medicine catalogue

The one migration in this project that touches existing clinical data. Read this before running it.

## What changed, and what deliberately didn't

`PLAN.md` said `PrescriptionItem.medicineName` would *become* a foreign key to `Medicine`. **It doesn't, and that's on purpose.**

A prescription is a contemporaneous clinical record — closer to a signed document than a row of application state. If `medicineName` were replaced by a join, renaming or correcting a catalogue entry would silently rewrite what a doctor prescribed six months ago. That's not a data-modelling nicety; it's the difference between a record and a report.

So:

| Column | Role |
|---|---|
| `medicineName` | **Kept, verbatim, forever.** What the prescriber actually wrote. Never edited by the catalogue. |
| `medicineId` | **New, nullable.** The catalogue link. Enables class-based allergy checking and stock tracking. |
| `quantityDispensed` | **New.** Running total across dispense events. |

Nullable is the second deliberate choice. A `NOT NULL` FK would mean the migration fails on the first row whose text doesn't match a catalogue entry — which, given free-text entry, is certain. Nullable means the migration always succeeds and the leftovers surface as work rather than as an outage.

## Running it

```bash
cd backend
npx prisma migrate dev --name phase4_pharmacy
npm run seed        # local only — reseeds the catalogue and stock
```

On a database with prescriptions you want to keep, **skip the reseed** and backfill instead:

```sql
-- 1. Populate the catalogue from what has actually been prescribed.
--    drug_class defaults to OTHER; see step 3 — this is the important bit.
INSERT INTO medicines (name, form, strength, "drugClass", "reorderLevel", "isActive", "createdAt", "updatedAt")
SELECT DISTINCT
  TRIM(medicine_name), 'Unknown', 'Unknown', 'OTHER', 20, true, NOW(), NOW()
FROM prescription_items
WHERE TRIM(medicine_name) <> ''
ON CONFLICT (name) DO NOTHING;

-- 2. Link items by exact, case-insensitive name.
UPDATE prescription_items pi
SET medicine_id = m.id
FROM medicines m
WHERE pi.medicine_id IS NULL
  AND LOWER(TRIM(pi.medicine_name)) = LOWER(TRIM(m.name));

-- 3. What is left needs a human.
SELECT medicine_name, COUNT(*)
FROM prescription_items
WHERE medicine_id IS NULL
GROUP BY medicine_name
ORDER BY COUNT(*) DESC;
```

Step 3's output is exactly what the **Map medicines** sheet on the dispensing queue shows, so the leftovers can be handled in the UI rather than in SQL.

## The part that is easy to get wrong

**Step 1 sets every `drugClass` to `OTHER`, and `OTHER` matches no allergy.**

Class-based allergy checking is the entire reason the catalogue exists. A catalogue full of `OTHER` produces a system that runs every check, reports no conflicts, and looks like it's working. That is strictly worse than the Phase 1 substring check, because the substring check at least caught the obvious cases and never claimed to be reliable.

So after backfilling, set the classes on anything that matters:

```sql
UPDATE medicines SET "drugClass" = 'PENICILLIN'
WHERE name ILIKE ANY (ARRAY['%amoxicillin%','%penicillin%','%flucloxacillin%','%augmentin%']);

UPDATE medicines SET "drugClass" = 'NSAID'
WHERE name ILIKE ANY (ARRAY['%ibuprofen%','%naproxen%','%diclofenac%','%aspirin%']);

UPDATE medicines SET "drugClass" = 'SULFONAMIDE'
WHERE name ILIKE ANY (ARRAY['%trimoxazole%','%trimethoprim%','%sulfa%']);

-- Anything still OTHER is unchecked. Find out how much:
SELECT COUNT(*) FROM medicines WHERE "drugClass" = 'OTHER';
```

The dispensing screen flags uncatalogued *items* as "not allergy-checked". It does **not** flag a medicine sitting in the catalogue with the wrong class — that failure is invisible from the UI, which is why it's called out here.

`form` and `strength` land as `'Unknown'` and are cosmetic; the class is not.

## Rollback

The migration is additive — three nullable/defaulted columns and four new tables. Reverting the schema loses the catalogue, stock and dispensing history, but no prescription data: `medicineName` was never touched.

## Known gaps

- No controlled-drugs register. `Medicine.isControlled` is flagged and shown in the UI, but the separate witnessed-entry register a real pharmacy needs is not built.
- Expired stock is excluded from dispensing and reported, but there is no write-off workflow to remove it.
- `suggestQuantity` returns null for any frequency or duration it cannot read confidently, so a prescription containing one unreadable item never reaches `DISPENSED` automatically. It stays `PARTIALLY_DISPENSED` for a human to judge — deliberate, but it means that status doesn't strictly mean "part given".
