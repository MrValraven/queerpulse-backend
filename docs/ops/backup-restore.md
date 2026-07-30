# Backup & Restore Runbook

**Status:** launch-gating (audit P0-7). Until the checklist in §0 is green, a bad
migration or an accidental `DROP`/`DELETE` is **unrecoverable** — DMs, vouches,
housing intros, and consent logs have no second copy.

**Scope:** the production PostgreSQL database (Railway managed Postgres) and the
object-storage bucket (Railway Buckets, S3-compatible). Auth is Google-OAuth-only
and the schema is migration-owned (`synchronize` is never on), so a restore is
DB + bucket + a redeploy at a known migration — no external identity state to
reconcile.

---

## 0. Go-live checklist (do these before real users)

- [ ] **Railway managed backups enabled** on the Postgres service, retention set
      (see §1). *Dashboard action — cannot be scripted from this repo.*
- [ ] **Off-provider logical backup** running on a schedule to a bucket in a
      *different* provider/account than Railway (see §2). A backup that dies with
      the Railway account is not a backup.
- [ ] **One rehearsed restore** completed end-to-end into a scratch database and
      smoke-tested (see §4). An untested backup is a hypothesis, not a backup.
- [ ] **Bucket backup posture decided and written down** (see §5) — even if the
      decision is "avatars/photos are re-uploadable, not backed up", it must be a
      conscious, recorded decision.
- [ ] **Pre-migration snapshot step** adopted for every prod migration (see §3).
- [ ] **Restore RTO/RPO written down** and accepted by the maintainer (see §6).

---

## 1. Layer 1 — Railway managed backups (provider-native)

Railway Postgres supports scheduled volume/logical backups from the service's
**Backups** tab.

1. Railway dashboard → the Postgres service → **Backups** → enable scheduled
   backups. Set **daily** at minimum; **retention ≥ 7 days**.
2. Confirm the first backup actually appears (don't assume the toggle worked).
3. Note that provider-native backups live inside the same Railway account — they
   protect against DB corruption and bad migrations, **not** against account
   loss, billing lapse, or a provider-side incident. That is why Layer 2 exists.

This layer is the fast-path for the common case (bad migration this morning →
restore this morning's snapshot).

---

## 2. Layer 2 — Off-provider logical backup (`pg_dump`)

A nightly `pg_dump` in **custom format** (`-Fc`, compressed, restorable with
`pg_restore` selectively) pushed to storage **outside** Railway.

Use the companion script: [`scripts/pg-backup.sh`](../../scripts/pg-backup.sh).

```bash
# Requires: pg_dump (postgresql-client 16+), and DATABASE_URL pointing at prod.
# Writes a timestamped .dump and prints the path; optionally uploads if
# BACKUP_UPLOAD_CMD is set (see the script header for the S3/rclone contract).
DATABASE_URL="$PROD_DATABASE_URL" ./scripts/pg-backup.sh
```

**Where to run the schedule (pick one):**

- **GitHub Actions scheduled workflow** (recommended — off-Railway by
  construction). A `cron` workflow that installs `postgresql-client`, runs
  `scripts/pg-backup.sh` with `PROD_DATABASE_URL` from repo secrets, and uploads
  the dump to an S3/B2/R2 bucket in a *different* account. Keep ≥ 14 daily + 8
  weekly.
- A separate always-on box / Railway cron service *writing to a non-Railway
  bucket*. Acceptable, but the compute being on Railway means you depend on
  Railway to *produce* the backup; the storage must still be elsewhere.

**Encrypt at rest.** These dumps contain DMs, emails, and consent logs. If the
destination bucket isn't already encrypted with a key you control, pipe through
`age`/`gpg` before upload (the script supports `BACKUP_ENCRYPT_CMD`).

**Retention:** apply lifecycle rules on the bucket (e.g. keep 14 daily, 8 weekly,
6 monthly). Don't keep raw PII dumps forever — that's its own liability.

---

## 3. Pre-migration snapshot (every prod migration)

`railway.json` runs `migration:run:prod` as `preDeployCommand`. Migrations are
the single most likely cause of data loss. Before applying a migration to prod:

1. Trigger an **on-demand** Railway backup (Backups tab → "Back up now"), OR run
   `scripts/pg-backup.sh` manually and confirm the dump exists.
2. Follow the two-phase CONCURRENTLY recipe for migrations that mix transactional
   DDL with `CREATE INDEX CONCURRENTLY` (see the migration notes in the root
   `CLAUDE.md` and the memory runbook: apply transactional migrations with
   `-t each`, then the CONCURRENTLY ones with `-t none`; call the TypeORM CLI
   directly — nested `pnpm run … -- --flag` drops the flag).
3. After deploy, verify `pnpm run typeorm migration:show` is clean (no pending).

This is the difference between "restore last night and lose a day" and "restore
the snapshot from 90 seconds ago and lose nothing."

---

## 4. Restore procedure (and the mandatory rehearsal)

**Rehearse this into a scratch DB before launch. Then rehearse it again quarterly.**

### 4a. Restore a logical dump

```bash
# 1. Create/target a SCRATCH database (never restore onto prod as a "test").
createdb queerpulse_restore_test           # or a fresh Railway DB

# 2. Restore. -Fc dumps use pg_restore. --clean --if-exists makes it idempotent.
pg_restore \
  --dbname="$SCRATCH_DATABASE_URL" \
  --clean --if-exists --no-owner --no-privileges \
  path/to/queerpulse-YYYYMMDD-HHMMSS.dump

# 3. Point a checked-out backend at the scratch DB and verify schema state:
DATABASE_URL="$SCRATCH_DATABASE_URL" pnpm run typeorm migration:show   # expect no pending
```

See [`scripts/pg-restore.sh`](../../scripts/pg-restore.sh) for a guarded wrapper
(it refuses to restore onto a URL whose DB name doesn't look like a scratch/test
target, mirroring the e2e `_test` guard).

### 4b. Restore from a Railway managed backup

Railway dashboard → Postgres → Backups → pick a snapshot → **Restore**. This
replaces the service's volume. For a point-in-time-ish recovery you generally:
restore the newest snapshot *before* the bad event, then redeploy the app at the
matching migration state, then re-apply any known-good migrations.

### 4c. Bring the app back up

1. Ensure the app image is at (or ahead of) the restored schema's migration
   state — a redeploy runs `migration:run:prod` and will apply anything the
   restore is missing.
2. Smoke test: `/health/ready`, sign in, open a DM thread, load the directory,
   load an event. Confirm no 500s from a schema/data mismatch.

### 4d. Restore rehearsal — pass criteria

A rehearsal only counts if you: restored a real dump into a scratch DB,
`migration:show` came back clean, the app booted against it, and you could read a
DM and an event. Record the date + the dump timestamp used in §6.

---

## 5. Object storage (Railway Buckets / S3) posture

Uploaded avatars and photos live in the bucket, **not** in Postgres, and are
**not** covered by any DB backup. Two acceptable postures — pick and record one:

- **(A) Not backed up (documented acceptance).** Rationale: images are
  re-uploadable, non-authoritative, and the DB keeps the object keys; a lost
  bucket degrades to broken images, not data-integrity loss. Cheapest. If chosen,
  say so explicitly in §6 so it isn't a silent gap.
- **(B) Backed up.** Enable bucket versioning + a cross-account replication/sync
  (e.g. `rclone sync` on the same GitHub Actions schedule as §2) to a bucket in a
  different account. Required if any bucket content is ever treated as
  authoritative (e.g. legal/consent evidence, verification documents).

> Related known gap (audit): **no `DeleteObjectCommand` exists anywhere**, so
> account erasure does not remove bucket objects. That's a separate erasure/GDPR
> fix, but it interacts with backup posture — a backup of the bucket also
> re-materialises objects a user asked to be erased. Whichever posture you pick,
> the erasure-vs-backup interaction must be handled when object deletion lands.

---

## 6. RTO / RPO (fill in and accept)

| Metric | Target | Actual (measured in rehearsal) |
|---|---|---|
| **RPO** (max data loss) | ≤ 24h (nightly) / ≤ minutes for migrations (§3) | _record_ |
| **RTO** (time to restore) | ≤ ___ | _record_ |
| Last rehearsed restore | _date_ | dump used: _timestamp_ |
| Bucket posture | (A) not backed up / (B) backed up | _which_ |

---

## 7. What this does NOT cover (adjacent, tracked elsewhere)

- **Single-replica constraint** (in-memory throttler/presence, no socket Redis
  adapter) — availability, not durability. See audit P2.
- **No metrics / alerting** on stuck deletion rows or failed backups — add a
  backup-success alert (a nightly job that pages if the newest off-provider dump
  is > 26h old is the single highest-value alert here).
- **Secrets rotation runbook** (JWT secrets, OAuth client) — separate runbook.
