# Deploying to a VPS — Ubuntu 22.04 LTS

Start to finish, for one VPS running everything: Postgres, the API, the web app
and nginx. That is the right shape for one clinic or a handful of them.

Ubuntu 22.04 gets security updates until **April 2027**. Plan the jump to 24.04
before then; it is a `do-release-upgrade` and not a redeployment, but it is not
something to do the week it expires.

---

## 0. Read this before you deploy anything

**`CLAUDE.md` rule 6 has not changed: dummy data only, until the hosting is
sorted out.**

The moment a real patient's name goes into this system, the box it runs on is
handling PHI. A plain VPS from a generic provider is almost certainly not
covered by a Business Associate Agreement, and in most jurisdictions that is not
a technicality you can decide to ignore — it is the difference between a breach
being an incident and a breach being a fine.

That is not an argument against this guide. Deploy it. Run it hard with dummy
data, with your own staff, for as long as you like — that is exactly how you
find the things no test can. Just make the BAA conversation a gate on the first
real patient, not a later cleanup.

**Three things have still never run outside a laptop**, so expect to meet them:

- The **web app has never rendered against a live API** on a server.
- **Mobile has only ever talked to a dev server** — §9, its API origin needs
  setting before a real build.
- The **platform API has never run at all**. Ignore it unless you are using
  break-glass support access; if you are, assume it has a bug.

---

## 1. What you are deploying

```
        :443 nginx  (TLS)
              │
              ▼
        :3001 Next.js  ──rewrite /api/v1/*──►  :3000 NestJS
                                                    │
                                                    ▼
                                              :5432 Postgres
```

Two Node processes and a database. **Only nginx is exposed.** The API is never
directly reachable, and that is deliberate: the refresh token is an httpOnly
cookie with `SameSite=Strict` scoped to `/api/v1/auth`, so the browser only
sends it to the origin that served the page. `next.config.mjs` already proxies
`/api/v1/*` for exactly this reason.

**Sizing:** 2 vCPU, 4 GB RAM, 40 GB SSD. The memory peak is the Next.js build,
not the running app — on a 2 GB box, build elsewhere and copy `dist/` and
`.next/` up.

---

## 2. Server preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx curl ca-certificates gnupg unattended-upgrades
```

**Node 20.** Do not use `apt install nodejs` on its own — 22.04 ships Node 12,
which this will not run on.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # expect v20.x
```

**Postgres 16**, matching `docker-compose.yml`. Ubuntu's own package is
Postgres 14 — which does work, the multi-tenancy design was verified against 14
— but running the same major version as the compose file means one less
difference between what you tested and what you deployed.

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-16
psql --version
```

Turn on automatic security updates — this box will be on the internet holding
health data:

```bash
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

Create an unprivileged user for the app. Nothing here runs as root.

```bash
sudo useradd -r -m -d /opt/hms -s /bin/bash hms
```

---

## 3. Postgres, and the two database roles

**This is the section to get right.**

Row-Level Security is why Postgres was chosen over MySQL, and it is silently
defeated by connecting as the wrong role. A superuser **bypasses RLS entirely**
— `FORCE ROW LEVEL SECURITY` does not stop them. If the running API connects as
the database owner, every tenant sees every other tenant's patients and nothing
in the app will tell you.

So there are two connection strings and they are not interchangeable:

| Variable | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `hms_app` — plain, non-superuser | the running API |
| `DATABASE_URL_ADMIN` | `hms_owner` — the database owner | migrations, RLS, seed |

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE hms_owner LOGIN PASSWORD 'CHANGE_ME_OWNER';
CREATE DATABASE hms_db OWNER hms_owner;
SQL
```

You do **not** create `hms_app` by hand. `npm run db:rls` creates it and syncs
its password to whatever `DATABASE_URL` says — pick that password now.

Ubuntu's default `pg_hba.conf` already has `host all all 127.0.0.1/32
scram-sha-256`, so local TCP password auth works with no edits. Confirm the
server is only listening on loopback:

```bash
sudo ss -lntp | grep 5432     # expect 127.0.0.1:5432, not 0.0.0.0:5432
```

If it shows `0.0.0.0`, set `listen_addresses = 'localhost'` in
`/etc/postgresql/16/main/postgresql.conf` and restart.

---

## 4. Get the code and configure it

```bash
sudo -u hms -i
git clone <your-repo-url> /opt/hms/app
cd /opt/hms/app
```

**`backend/.env`** — then `chmod 600 backend/.env`. It holds two database
passwords and two signing secrets.

```bash
NODE_ENV=production
PORT=3000

# The API connects as hms_app. Never as the owner. See §3.
DATABASE_URL="postgresql://hms_app:CHANGE_ME_APP@127.0.0.1:5432/hms_db"
DATABASE_URL_ADMIN="postgresql://hms_owner:CHANGE_ME_OWNER@127.0.0.1:5432/hms_db"

# Generate real ones — twice, they must differ:  openssl rand -hex 32
JWT_ACCESS_SECRET="..."
JWT_REFRESH_SECRET="..."
JWT_ACCESS_TTL="15m"
JWT_REFRESH_TTL_DAYS=7

# A fallback only. Each hospital's real timezone lives on its tenant row and is
# set from Admin → Clinic Settings.
HOSPITAL_TIMEZONE="Asia/Kolkata"

# Your public origin. Nothing else may call the API from a browser.
CORS_ORIGINS="https://hms.example.com"
```

**`web/.env.local`** — the only variable the web app needs, read at build time
by `next.config.mjs` to wire up the proxy:

```bash
API_ORIGIN=http://127.0.0.1:3000
```

---

## 5. Build, migrate, apply the constraints

Order matters; each step depends on the one before.

```bash
cd /opt/hms/app/backend
npm ci
npx prisma generate
npm run build

# 1. Schema. Uses DATABASE_URL_ADMIN — hms_app cannot create tables.
node prisma/admin-cli.js migrate deploy

# 2. Row-Level Security. Creates hms_app, applies every policy, and
#    self-checks both directions against a row it inserts and rolls back.
npm run db:rls

# 3. Partial unique indexes Prisma cannot express — a doctor and a patient
#    each cannot be double-booked, ignoring cancelled and no-show rows.
npm run db:constraints
```

`migrate deploy`, **not** `migrate dev`. `dev` can decide to reset the database,
which on a server holding real rows is exactly the wrong instinct.

**Do not run `npm run seed`.** It deletes every row before inserting demo data.
`assertSafeToWipe()` refuses if it finds records it did not create, but do not
rely on being saved by it.

Then the web app:

```bash
cd /opt/hms/app/web
npm ci
npm run build
```

---

## 6. The first hospital and the first administrator

**There is no bootstrap command, and that is a genuine gap.** Everything that
creates a tenant and its first admin lives in `seed.ts`, which wipes first.

Until there is a `create-tenant` script, do it in SQL — once, carefully.
Generate the password hash with the same Argon2 settings the app uses:

```bash
cd /opt/hms/app/backend
node -e "require('@node-rs/argon2').hash('TemporaryPassw0rd!').then(console.log)"
```

Then connect **as the owner** — RLS would otherwise hide the rows you are
creating:

```bash
psql "postgresql://hms_owner:CHANGE_ME_OWNER@127.0.0.1:5432/hms_db"
```

```sql
INSERT INTO tenants (name, slug, timezone, currency, "slotMinutes",
                     "clinicStartHour", "clinicEndHour", "isActive",
                     "createdAt", "updatedAt")
VALUES ('Your Clinic', 'your-clinic', 'Asia/Kolkata', 'INR', 15, 9, 17, true,
        now(), now())
RETURNING id;

INSERT INTO users (email, "passwordHash", "fullName", role, "isActive",
                   "mustChangePassword", "tenantId", "createdAt", "updatedAt")
VALUES ('admin@yourclinic.com', '<hash from above>', 'Owner', 'ADMIN', true,
        true, <tenant id>, now(), now());
```

`mustChangePassword` is `true` on purpose: the account is forced through a
password change at first sign-in, so the temporary password above stops working
immediately.

Everything else — departments, doctors, staff, roles — is created in the app.

---

## 7. systemd

**`/etc/systemd/system/hms-api.service`**

```ini
[Unit]
Description=HMS API
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=hms
WorkingDirectory=/opt/hms/app/backend
EnvironmentFile=/opt/hms/app/backend/.env
ExecStart=/usr/bin/node dist/main
Restart=always
RestartSec=5

# The audit queue is in-process. SIGTERM drains it and spills whatever it
# cannot write to backend/var/audit-spill.jsonl; SIGKILL loses it outright.
# Give the drain room.
KillSignal=SIGTERM
TimeoutStopSec=30

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/hms/app/backend/var

[Install]
WantedBy=multi-user.target
```

`ReadWritePaths` is not optional. `ProtectSystem=strict` makes the filesystem
read-only, and the audit spill file is the one thing the API must be able to
write — it is where security events go when the database will not take them.

**`/etc/systemd/system/hms-web.service`**

```ini
[Unit]
Description=HMS Web
After=network.target hms-api.service

[Service]
Type=simple
User=hms
WorkingDirectory=/opt/hms/app/web
Environment=NODE_ENV=production
Environment=PORT=3001
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/hms/app/backend/var && sudo chown hms:hms /opt/hms/app/backend/var
sudo systemctl daemon-reload
sudo systemctl enable --now hms-api hms-web
sudo systemctl status hms-api hms-web
```

The API's boot log should read `API listening on http://localhost:3000/api/v1`
and, in production, **not** print the dummy-data warning.

---

## 8. nginx and TLS

`/etc/nginx/sites-available/hms`:

```nginx
server {
    listen 80;
    server_name hms.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name hms.example.com;

    ssl_certificate     /etc/letsencrypt/live/hms.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hms.example.com/privkey.pem;

    # The refresh cookie is Secure in production, so it is never sent over
    # plain HTTP. Without TLS, sign-in appears to work and every reload logs
    # the user out — a confusing failure with an obvious cause.
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`X-Forwarded-For` matters more here than in a typical app: the login rate limit
buckets on IP + email, and every audit row records an IP. Without it, every row
in your audit log reads `127.0.0.1` and the throttle treats the whole internet
as one client.

```bash
sudo ln -s /etc/nginx/sites-available/hms /etc/nginx/sites-enabled/hms
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d hms.example.com
```

Certbot installs its own renewal timer; check it with
`systemctl list-timers | grep certbot`.

**Firewall:**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Postgres on 5432 stays closed — it is only reached over loopback.

---

## 9. The mobile app

In development the app derives the API host from the Expo dev server, which is
why it works on your LAN with no configuration. **A production build has no dev
server**, so it falls back to `expo.extra.apiOrigin` in `app.json`. Set it
before building:

```json
{
  "expo": {
    "extra": { "apiOrigin": "https://hms.example.com", "apiPort": 443 }
  }
}
```

Then `eas build`, or `npx expo run:android --variant release` for a local APK.
Android blocks plaintext HTTP by default, so §8's TLS is a prerequisite for
mobile, not just good practice.

---

## 10. Backups

The database holds everything. Nothing else on the box is irreplaceable.

```bash
sudo -u postgres mkdir -p /var/backups/hms
sudo tee /etc/cron.daily/hms-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
F=/var/backups/hms/hms_db-$(date +\%F).sql.gz
sudo -u postgres pg_dump hms_db | gzip > "$F"
find /var/backups/hms -name '*.sql.gz' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/hms-backup
sudo /etc/cron.daily/hms-backup    # run it once now
```

**Restore it somewhere else at least once.** A backup you have never restored is
a hypothesis, not a backup, and the first time you test it should not be the day
you need it. Copies on the same VPS also die with the VPS — get them off the box.

---

## 11. Updating

```bash
sudo -u postgres pg_dump hms_db | gzip > ~/pre-deploy-$(date +%F).sql.gz

sudo -u hms -i
cd /opt/hms/app && git pull
cd backend && npm ci && npx prisma generate && npm run build \
  && node prisma/admin-cli.js migrate deploy && npm run db:constraints
cd ../web && npm ci && npm run build
exit

sudo systemctl restart hms-api hms-web
```

Re-run `npm run db:rls` whenever a migration adds a table. A new table has no
policy until one is applied, and **a table without a policy is visible to every
tenant**. The script is safe to run repeatedly.

---

## 12. After it is up

**Check the boot log names the routes you expect.**

```bash
journalctl -u hms-api -n 200 | grep RouterExplorer | grep admin
```

A missing `Mapped {/api/v1/admin/reports/consultations, GET}` means the build
did not recompile — which presents as a 404 that looks like a routing bug.

**Verify tenant isolation for real.** The most valuable minute you will spend on
a live database:

```bash
psql "postgresql://hms_app:CHANGE_ME_APP@127.0.0.1:5432/hms_db" \
  -c "SELECT count(*) FROM patients;"
```

**Zero is the correct answer.** With no tenant in scope, the policy — not the
query — decides that nothing is visible. A non-zero count means the API is
connecting as a superuser and isolation is off.

**Watch for the audit spill file.** `backend/var/audit-spill.jsonl` existing
means audit writes failed and were saved to disk rather than lost. Nothing
alerts on it; someone has to look. If it appears, `npm run audit:replay` puts
the entries back and is safe to run twice.

```bash
journalctl -u hms-api -f
ls -la /opt/hms/app/backend/var/
```
