-- Slot uniqueness for appointments.
--
-- WHY THIS IS NOT IN schema.prisma
-- --------------------------------
-- Both rules must ignore cancelled and no-show rows, and Prisma cannot declare
-- a partial unique index. A plain `@@unique([doctorId, scheduledAt])` — which
-- is what this replaced — means a cancelled appointment holds its slot for
-- ever: reception cancels the 09:20, tries to rebook it, and is told the slot
-- is taken by an appointment that no longer exists.
--
-- WHAT THE TWO RULES ARE
-- ----------------------
--  1. A doctor cannot be in two places at once. This one already existed.
--  2. A patient cannot be in two places at once. This one did not, so the same
--     patient could be booked with two different doctors at the same instant —
--     which is not a scheduling preference, it is a physically impossible
--     appointment that someone would only discover in the waiting room.
--
-- WHY IN THE DATABASE RATHER THAN THE SERVICE
-- -------------------------------------------
-- The service checks too, for a readable error. But two receptionists tapping
-- "book" in the same second both pass an application check and both insert.
-- Only the index is a guarantee. Same argument as the RLS policies: the thing
-- that decides must be the thing that cannot be bypassed.
--
-- Idempotent. Safe to run repeatedly; `npm run db:setup` runs it for you.

BEGIN;

-- The old, unfiltered constraint. Named by Prisma from the model.
DROP INDEX IF EXISTS "appointments_doctorId_scheduledAt_key";
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS "appointments_doctorId_scheduledAt_key";

-- 1. One live appointment per doctor per slot.
DROP INDEX IF EXISTS appointment_doctor_slot_active;
CREATE UNIQUE INDEX appointment_doctor_slot_active
  ON appointments ("doctorId", "scheduledAt")
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW');

-- 2. One live appointment per patient per slot.
--
-- Deliberately not scoped by doctor: the whole point is that the patient is a
-- single person who cannot attend two consultations simultaneously, whoever
-- those consultations are with.
DROP INDEX IF EXISTS appointment_patient_slot_active;
CREATE UNIQUE INDEX appointment_patient_slot_active
  ON appointments ("patientId", "scheduledAt")
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW');

COMMIT;

-- Prove both, against rows that are rolled back.
--
-- The RLS work taught this lesson twice: a policy that reads correctly and was
-- never executed is a policy nobody has tested. The same applies to an index
-- whose WHERE clause has a typo — it would simply never fire, and the first
-- symptom would be a patient double-booked in production.
DO $$
DECLARE
  t_id  int;
  p_id  int;
  d_id  int;
  d2_id int;
  slot  timestamp := '2099-01-01 09:00:00';
  failed boolean;
BEGIN
  SELECT id INTO t_id FROM tenants ORDER BY id LIMIT 1;
  SELECT id INTO p_id FROM patients WHERE "tenantId" = t_id ORDER BY id LIMIT 1;
  SELECT id INTO d_id FROM doctors  WHERE "tenantId" = t_id ORDER BY id LIMIT 1;
  SELECT id INTO d2_id FROM doctors WHERE "tenantId" = t_id AND id <> d_id ORDER BY id LIMIT 1;

  IF p_id IS NULL OR d2_id IS NULL THEN
    RAISE NOTICE 'Skipping slot-index self-check: needs a patient and two doctors (run the seed).';
    RETURN;
  END IF;

  INSERT INTO appointments ("tenantId","patientId","doctorId","scheduledAt",status,"updatedAt")
  VALUES (t_id, p_id, d_id, slot, 'SCHEDULED', now());

  -- Same patient, DIFFERENT doctor, same instant. Must be refused.
  failed := false;
  BEGIN
    INSERT INTO appointments ("tenantId","patientId","doctorId","scheduledAt",status,"updatedAt")
    VALUES (t_id, p_id, d2_id, slot, 'SCHEDULED', now());
  EXCEPTION WHEN unique_violation THEN
    failed := true;
  END;

  IF NOT failed THEN
    RAISE EXCEPTION
      'appointment_patient_slot_active is not enforcing: the same patient was booked with two doctors at once.';
  END IF;

  -- Cancel the first, and the slot must become reusable.
  UPDATE appointments SET status = 'CANCELLED'
   WHERE "patientId" = p_id AND "scheduledAt" = slot;

  BEGIN
    INSERT INTO appointments ("tenantId","patientId","doctorId","scheduledAt",status,"updatedAt")
    VALUES (t_id, p_id, d2_id, slot, 'SCHEDULED', now());
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'A cancelled appointment is still holding its slot. The partial WHERE clause is not being applied.';
  END;

  RAISE NOTICE 'Slot indexes verified: patient double-booking refused, cancelled slots reusable.';
  RAISE EXCEPTION 'rollback self-check';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'rollback self-check' THEN
    RAISE NOTICE 'Slot index self-check passed.';
  ELSE
    RAISE;
  END IF;
END $$;
