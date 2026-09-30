-- Self-service password reset.
--
-- HAND-WRITTEN, like the nineteen before it. `prisma migrate diff` is the
-- proper tool and needs the schema engine binary, whose download is blocked on
-- this machine. Check it with that command before applying this to anything
-- holding data.
--
-- `npm run db:rls` is NOT needed, and that is a decision rather than an
-- omission. `password_reset_tokens` carries no `tenantId` and gets no policy,
-- for the reason `refresh_tokens` and `devices` do not: it is read on an
-- unauthenticated request where `app.tenant_id` is unset, so the generic
-- tenant policy would make every valid link read as expired. The model's own
-- comment in schema.prisma carries the full argument.
--
-- Nothing is backfilled and nothing could be: a reset token is minted by a
-- request and means nothing without the raw value that only ever existed in an
-- email.

CREATE TABLE "password_reset_tokens" (
    "id"           SERIAL       NOT NULL,
    "userId"       INTEGER      NOT NULL,
    -- sha256 hex of a 32-byte random value. UNIQUE so a collision is a
    -- constraint violation rather than one person's link resetting another
    -- person's password — the same reasoning as refresh_tokens.tokenHash.
    "tokenHash"    TEXT         NOT NULL,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    -- Nullable, and consumption sets it rather than deleting the row. A token
    -- presented twice must be distinguishable from one that never existed.
    "consumedAt"   TIMESTAMP(3),
    "requestedFor" TEXT         NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key"
    ON "password_reset_tokens"("tokenHash");

CREATE INDEX "password_reset_tokens_userId_idx"
    ON "password_reset_tokens"("userId");

-- Expiry is indexed because the only query that is not a hash lookup is the
-- sweep that clears dead rows. Without it that becomes a sequential scan over
-- a table whose whole purpose is to accumulate.
CREATE INDEX "password_reset_tokens_expiresAt_idx"
    ON "password_reset_tokens"("expiresAt");

-- ON DELETE CASCADE, matching refresh_tokens. There is no route that deletes a
-- user — audit rows reference them — but if one ever existed, leaving live
-- reset tokens pointing at a gone account would be the worst available residue.
ALTER TABLE "password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
