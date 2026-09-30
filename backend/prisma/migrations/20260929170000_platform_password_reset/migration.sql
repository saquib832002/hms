-- Self-service password reset for vendor console accounts.
--
-- HAND-WRITTEN, like the twenty before it. Check it with `prisma migrate diff`
-- before applying it to anything holding data.
--
-- **`npm run db:rls` IS REQUIRED.** `platform_password_reset_tokens` is a new
-- table that must carry the *inverted* policy — `USING (app_current_tenant()
-- IS NULL)` — and it gets no policy from this migration. Without that step the
-- table has RLS disabled entirely and every hospital request could read it,
-- which is the one table where that matters most: these rows are links into
-- accounts that can open a break-glass grant against any hospital.

-- When this account last had its password reset through an emailed link.
-- `openGrant` refuses for a cooling-off period afterwards, so this column is
-- read on a security decision rather than only displayed.
--
-- Deliberately NOT backfilled. Every existing account has null, which reads as
-- "never reset this way" — true, since the feature did not exist. Filling it
-- with `updatedAt` would put a fabricated reset onto the record and start a
-- cooling-off nobody triggered.
ALTER TABLE "platform_users"
    ADD COLUMN "passwordResetAt" TIMESTAMP(3);

CREATE TABLE "platform_password_reset_tokens" (
    "id"             SERIAL       NOT NULL,
    "platformUserId" INTEGER      NOT NULL,
    -- sha256 hex of 32 random bytes. UNIQUE so a collision is a constraint
    -- violation rather than one person's link resetting another's password.
    "tokenHash"      TEXT         NOT NULL,
    "expiresAt"      TIMESTAMP(3) NOT NULL,
    "consumedAt"     TIMESTAMP(3),
    "requestedFor"   TEXT         NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_password_reset_tokens_tokenHash_key"
    ON "platform_password_reset_tokens"("tokenHash");

CREATE INDEX "platform_password_reset_tokens_platformUserId_idx"
    ON "platform_password_reset_tokens"("platformUserId");

CREATE INDEX "platform_password_reset_tokens_expiresAt_idx"
    ON "platform_password_reset_tokens"("expiresAt");

ALTER TABLE "platform_password_reset_tokens"
    ADD CONSTRAINT "platform_password_reset_tokens_platformUserId_fkey"
    FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
