# QueerPulse backend local setup

This guide covers the API on its own. For the whole stack (frontend, sign-in,
demo mode, daily checks in both repos) start with the frontend's
[SETUP.md](https://github.com/MrValraven/queer-pulse/blob/main/SETUP.md); it
expects this repo cloned next to it as `queerpulse-backend`.

- [Quick start with Docker](#quick-start-with-docker)
- [Already using the repo?](#already-using-the-repo)
- [What `docker compose up` runs](#what-docker-compose-up-runs)
- [Daily Docker commands](#daily-docker-commands)
- [Ports and overrides](#ports-and-overrides)
- [Moving your database into Docker](#moving-your-database-into-docker)
- [The native path: `pnpm dev:setup`](#the-native-path-pnpm-devsetup)
- [Reviewing an existing `.env`](#reviewing-an-existing-env)
- [What a fresh `.env` contains](#what-a-fresh-env-contains)
- [What `pnpm dev:doctor` checks](#what-pnpm-devdoctor-checks)
- [Signing in locally](#signing-in-locally)
- [MinIO (local uploads)](#minio-local-uploads)
- [Running without Docker](#running-without-docker)
- [Checking the production image](#checking-the-production-image)
- [The e2e test database](#the-e2e-test-database)
- [Migrations and seed, day to day](#migrations-and-seed-day-to-day)
- [Troubleshooting](#troubleshooting)

## Quick start with Docker

Prerequisites: [Docker Desktop](https://www.docker.com/products/docker-desktop/)
or [OrbStack](https://orbstack.dev) (lighter on macOS), with Docker Compose
2.24 or newer (check with `docker compose version`). Node, pnpm and Postgres all
run in containers, and `.env` is optional.

```bash
cd queerpulse-backend
docker compose up
```

The first run builds the `api` image and installs dependencies, so give it a
few minutes. Once the API has started:

```bash
curl http://localhost:3000/health/live
```

Swagger UI is at http://localhost:3000/docs outside production. Sign in on the
frontend as `admin@example.com`; the code prints in the `docker compose up`
output (see [Signing in locally](#signing-in-locally)).

To get your terminal back, start it in the background and follow the API log:

```bash
docker compose up -d
docker compose logs -f api
```

The native path ([`pnpm dev:setup` and `pnpm start:dev`](#the-native-path-pnpm-devsetup))
stays fully supported, for a machine without Docker or for running the API as a
host process under a debugger.

## Already using the repo?

If your checkout predates the Docker workflow (a native Postgres such as
Postgres.app, a hand-kept `.env`, `pnpm start:dev` on the host), take these
steps once, in this order:

1. **See where you stand.** Read-only; every problem comes with a `fix:` line.

   ```bash
   pnpm dev:doctor
   ```

2. **Review `.env`.** `pnpm dev:setup` now reviews an existing `.env` on a
   terminal and asks about each item it would change, after a timestamped
   backup. See [Reviewing an existing `.env`](#reviewing-an-existing-env).

   ```bash
   pnpm dev:setup
   ```

3. **Seed what is left.** The seed now runs cleanly on a database that already
   holds communities and listings created through the app, and adds only the
   fixture rows that are missing.

   ```bash
   pnpm run seed
   ```

4. **Move your data into Docker.** Copies the native database into the compose
   `postgres` once. Skip it to start Docker with a fresh database and the
   fixtures. See [Moving your database into Docker](#moving-your-database-into-docker).

   ```bash
   pnpm dev:import-db
   ```

5. **Start the stack.** Stop your native `pnpm start:dev` first: the `api`
   container needs port 3000.

   ```bash
   docker compose up
   ```

Your `.env` keeps serving both paths. The `api` container reads it for secrets
(JWT, Google OAuth, signing and VAPID keys) and sets its own values for what
differs inside Docker: `DATABASE_URL`, `DATABASE_SSL`, the `AWS_*` bucket keys,
`AWS_PUBLIC_ENDPOINT_URL`, `API_URL`, `PORT` and `NODE_ENV`.

## What `docker compose up` runs

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `postgres:16` | The database, stored in the `pgdata` volume. On an empty volume, `docker/postgres-init/` adds `queerpulse_test` beside `queerpulse` |
| `minio` | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | Local S3 stand-in for the Railway Bucket, for local development only. Stored in the `miniodata` volume |
| `api` | the Dockerfile's `dev` stage (Node 22, pnpm, `psql` 16, tini) | The repo bind-mounted at `/app`, with `node_modules` and the pnpm store in their own volumes (`api-node-modules`, `pnpm-store`). Serves the API with hot reload |

`api` waits for `postgres` and `minio` to report healthy, then runs
`node scripts/dev-setup.mjs --container`. Every step is idempotent, so a restart
is cheap:

1. **Dependencies.** `pnpm install --frozen-lockfile`. When `pnpm-lock.yaml` is
   out of date with `package.json`, it falls back to a plain `pnpm install`,
   which can rewrite the lockfile in your checkout (see
   [Troubleshooting](#troubleshooting)).
2. **`.env`.** On a fresh clone it creates `.env` and `.env.test` with fresh
   local secrets, written for an API on the host. An existing `.env` stays
   untouched: the container reads it and never writes it. A value boot needs
   that is missing or invalid gets a temporary one held in memory for that run;
   the log names each key and says `run pnpm dev:setup on your machine to save
   them`. Temporary JWT secrets mean every session resets when the container
   restarts.
3. **Databases.** Creates `queerpulse` and `queerpulse_test` when missing and
   migrates both.
4. **Seed.** Runs `pnpm run seed` when the dev database has no users or no
   `admin@example.com`.
5. **Bucket.** Creates `queerpulse-dev` in MinIO when missing.
6. **API.** Runs `pnpm start:dev`; a saved file under `src/` reloads it.

Inside Docker, `DATABASE_URL` points at `postgres:5432` and `AWS_ENDPOINT_URL`
at `minio:9000`. The browser cannot resolve `minio`, so the compose file also
sets `AWS_PUBLIC_ENDPOINT_URL=http://localhost:9000`: the API talks to
`minio:9000` and signs the presigned upload and download URLs it hands the
browser for `localhost:9000`. That variable is for the local bucket only, and
env validation refuses it when `NODE_ENV=production`.

## Daily Docker commands

```bash
docker compose up -d                  # start the stack in the background
docker compose logs -f api            # follow the API log (sign-in codes print here)
docker compose restart api            # rerun setup and the API, e.g. after a pull that changes dependencies
docker compose up -d api              # recreate the api container so it reads an edited .env
docker compose build api              # rebuild the dev image after a Dockerfile change
docker compose stop                   # stop the containers; every volume stays
docker compose down                   # remove the containers; every volume stays
```

Run any `pnpm` script inside the running container with
`docker compose exec api`:

```bash
docker compose exec api pnpm run migration:run
docker compose exec api pnpm run typeorm migration:show
docker compose exec api pnpm run seed
docker compose exec api pnpm run test
docker compose exec -e TEST_DATABASE_URL=postgres://queerpulse:queerpulse@postgres:5432/queerpulse_test api pnpm run test:e2e
```

The e2e run needs `TEST_DATABASE_URL` in the container: there `DATABASE_URL`
names the dev database, `.env.test` never overrides a variable that is already
set, and the e2e guard refuses any database whose name lacks `_test`.

**`docker compose down -v` deletes your local data.** It removes every volume:
the database, every uploaded file, and the container's `node_modules` and pnpm
store. The next `docker compose up` starts from an empty database with the
fixtures and reinstalls dependencies.

## Ports and overrides

| Host port | Service | Override |
| --- | --- | --- |
| 3000 | API (`api`) | `QP_API_PORT` |
| 9229 | Node inspector (`api`) | `QP_API_DEBUG_PORT` |
| 5432 | Postgres (`postgres`) | `QP_POSTGRES_PORT` |
| 9000 | MinIO S3 API (`minio`) | `QP_MINIO_PORT` |
| 9001 | MinIO console (`minio`) | `QP_MINIO_CONSOLE_PORT` |
| 3001 | production image (`app`, profile `prod-image`) | `QP_PROD_IMAGE_PORT` |

Compose reads these from your shell and from the `.env` next to
`docker-compose.yml`, so they can live in `.env`:

```bash
QP_POSTGRES_PORT=5433
```

Inside the Docker network nothing moves: `api` always reaches `postgres:5432`
and `minio:9000`. What a moved port touches on the host:

- `QP_API_PORT`: set `VITE_API_URL` in the frontend `.env` to the same port.
- `QP_POSTGRES_PORT`: native runs read `DATABASE_URL`, so give it the same port
  there.
- `QP_API_DEBUG_PORT`: the Node inspector. Set `QP_API_DEBUG=true` in `.env`
  and run `docker compose up -d api`; the API then starts under
  `nest start --debug 0.0.0.0:9229 --watch`, and a debugger attaches at
  `localhost:9229` (in VS Code: "Attach to Node Process", or an `attach`
  launch config with `"localRoot": "${workspaceFolder}"` and
  `"remoteRoot": "/app"`).

## Moving your database into Docker

`pnpm dev:import-db` copies an existing database (Postgres.app, Homebrew, any
server and any Postgres version) into the compose `postgres` once, so
`docker compose up` starts with your data. It runs on the host with Node and
Docker; the dump and restore happen in containers, so no local `pg_dump` or
`psql` is needed.

```bash
docker compose stop api        # the import refuses while api runs
pnpm dev:import-db --dry-run   # plan only: connects read-only, starts no container, writes nothing
pnpm dev:import-db
docker compose up
```

1. It reads the source from `DATABASE_URL` in `.env`, or from
   `--from postgres://user:password@localhost:5432/queerpulse`.
2. It starts the compose `postgres`. When the source already holds its host
   port (Postgres.app on 5432), it offers to write a free port such as
   `QP_POSTGRES_PORT=5433` into `.env`, after a backup, and then to point
   `DATABASE_URL` at that port too, so native runs use the container.
3. It dumps the source with `pg_dump` in a `postgres:<source major>` container
   to `.local/db-dumps/<db>-<YYYYMMDD-HHMMSS>.sql`. That folder is gitignored
   and holds real member data, so keep it on your machine.
4. It restores into `queerpulse` in one transaction, dropping the few lines
   Postgres 16 rejects.
5. It compares table and user counts with the source and prints the next steps.

The source is only read. When the compose database already has tables, the
import stops; `--replace` drops and recreates it (it asks first on a terminal,
and without one needs `--yes` as well). It refuses while the `api` service runs
because the api's start-up migrations would race the restore. On the next
`docker compose up`, `api` runs any migrations newer than your data and seeds
what is missing. To roll back, the dump is plain SQL:
`psql -d <database> -f .local/db-dumps/<file>.sql` restores it into any empty
database.

On a Linux host the dump container reaches the source at
`host.docker.internal`, so the source Postgres has to listen on the `docker0`
address and allow it in `pg_hba.conf`.

## The native path: `pnpm dev:setup`

Use it on a machine without Docker, or to run the API as a host process
(debugger, profiler). Prerequisites: Node 22 (`.nvmrc`; `engines` needs
`>= 22.11`), pnpm 9.15.0 through `corepack enable`, and Docker running for
Postgres and MinIO, or a native Postgres 16.

```bash
docker compose stop api   # only when the Docker api runs: both use port 3000
nvm use                   # or: fnm use
corepack enable
pnpm dev:setup
pnpm start:dev
```

`pnpm dev:setup` runs `node scripts/dev-setup.mjs`. It imports only Node
built-ins at the top, so it runs on a fresh clone before `pnpm install`. It is
idempotent: it creates only what is missing, runs only pending migrations, and
changes an existing `.env` only with your consent (see
[Reviewing an existing `.env`](#reviewing-an-existing-env)).

```bash
pnpm dev:setup --dry-run            # print every action, change nothing
pnpm dev:setup --skip-docker        # leave docker compose alone (native Postgres)
pnpm dev:setup --skip-seed          # never run the seed
pnpm dev:setup --update-env         # review .env even when only optional keys are missing
pnpm dev:setup --update-env --yes   # accept every .env proposal without asking
pnpm dev:setup --help
```

Host ports for the compose services come from `QP_POSTGRES_PORT`,
`QP_MINIO_PORT` and `QP_MINIO_CONSOLE_PORT` (defaults 5432, 9000, 9001), read
from your shell or from `.env`.

| Step | What happens |
| --- | --- |
| 1. Node and pnpm | Stops with a fix when Node is older than 22.11 or pnpm is missing or a major other than 9 |
| 2. Dependencies | `pnpm install` |
| 3. Docker services (Postgres, MinIO) | `docker compose up -d --wait` for whichever of `postgres` and `minio` is not already running. When another server already listens on the Postgres port (Postgres.app, Homebrew), setup uses that server and skips the compose `postgres`. When the MinIO port is taken, it skips MinIO and uploads stay off. Without Docker it warns and expects a native Postgres on `localhost:5432` |
| 4. Environment files | No `.env`: creates one from `.env.example` with fresh local values (see [What a fresh `.env` contains](#what-a-fresh-env-contains)). Existing `.env`: reviews it (next section). No `.env.test`: creates one from `.env.test.example` pointing `DATABASE_URL` at `<db>_test` |
| 5. Databases | Connects to the `postgres` maintenance database (falling back to `template1`) and runs `CREATE DATABASE` for `queerpulse` and `queerpulse_test` when they are missing |
| 6. Migrations | `pnpm run migration:run` on the dev database, then on the test database |
| 7. Seed | `pnpm run seed` on the dev database, only when it has no users or no `admin@example.com`. The test database is never seeded |
| 8. MinIO bucket | When `.env` points `AWS_ENDPOINT_URL` at the local MinIO port, creates the `AWS_S3_BUCKET_NAME` bucket (`queerpulse-dev`) if it is missing |
| 9. Doctor | Runs `pnpm dev:doctor` and prints next steps. Setup exits non-zero when the doctor reports a failure |

A real dry run on a machine without Docker and with an older database:

```
[3/9] Docker services (Postgres, MinIO)
  warn  Docker unavailable: docker is not installed, so no containers start
        uploads stay off without MinIO (the API boots fine; upload requests fail)
        Postgres must then run natively on localhost:5432: Postgres.app (https://postgresapp.com) or `brew install postgresql@16`

[5/9] Databases
  ok    database "queerpulse" exists on localhost:5432
  plan  would CREATE DATABASE "queerpulse_test" on localhost:5432

[7/9] Seed
  plan  would run `pnpm run seed` on "queerpulse" because admin@example.com does not exist yet (3 users present; the seed skips rows that already exist)
```

## Reviewing an existing `.env`

On a terminal, `pnpm dev:setup` lists what an existing `.env` needs and asks
about each item:

- missing keys, both the ones boot requires and the others `.env.example` sets;
- recommended local keys, such as `EMAIL_CODE_DEV_LOG=true`, the membership card
  signing keys and the Web Push (VAPID) keys;
- the `.env.example` placeholder `AWS_*` values while MinIO runs, with the local
  MinIO block as the proposal;
- invalid values that would stop the API booting, such as a JWT secret under 32
  characters or two equal JWT secrets.

| Answer | Effect |
| --- | --- |
| Enter | accept the proposed value |
| `s` | skip this item |
| `a` | accept this item and every remaining one |
| your own text | use what you typed as the value |

Before the first write, setup copies `.env` to `.env.backup-YYYYMMDD-HHMMSS`
(gitignored). Cancelling the review leaves `.env` unchanged.

When only optional keys are missing, setup prints them and moves on;
`pnpm dev:setup --update-env` reviews those too. Without a terminal (CI, a pipe)
it prints the lines to add, and `pnpm dev:setup --update-env --yes` accepts
every proposal without asking.

A native `pnpm start:dev` refuses to boot on a missing or invalid value, and in
development that error ends with:

```
Run `pnpm dev:setup`, which offers to fill in the missing or invalid values in .env.
```

## What a fresh `.env` contains

Setup copies `.env.example`, fills the keys below and writes the file with mode
`0600`. Everything else keeps its `.env.example` value: `NODE_ENV=development`,
`PORT=3000`, `FRONTEND_URL=http://localhost:5173`,
`API_URL=http://localhost:3000`, and placeholder Google OAuth keys (Google
sign-in stays off; email codes cover local sign-in).

| Key | Generated value |
| --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 48 random bytes each, base64, guaranteed distinct (boot requires 32+ characters and two different values) |
| `CARD_SIGNING_PRIVATE_KEY`, `CARD_SIGNING_PUBLIC_KEY` | a fresh Ed25519 key pair as PEM, stored on one double-quoted line with `\n` escapes (dotenv expands them) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | a fresh P-256 pair in base64url, the format `npx web-push generate-vapid-keys` prints; `VAPID_SUBJECT` keeps `mailto:hello@queerpulse.example` |
| `BAN_EVASION_PEPPER` | 32 random bytes, hex |
| `EMAIL_CODE_DEV_LOG` | `true`: email sign-in codes are logged by the API and never sent |
| `DATABASE_URL` | the `.env.example` URL with its port set to `QP_POSTGRES_PORT` (default 5432) |
| `AWS_*` with MinIO running or about to start | `AWS_ENDPOINT_URL=http://localhost:9000`, `AWS_DEFAULT_REGION=us-east-1`, `AWS_S3_BUCKET_NAME=queerpulse-dev`, `AWS_ACCESS_KEY_ID=queerpulse`, `AWS_SECRET_ACCESS_KEY=queerpulse-dev-secret`, `AWS_S3_FORCE_PATH_STYLE=true` |
| `AWS_*` without MinIO | the five placeholder lines are commented out, so storage is cleanly off |

With an existing `.env`, setup generates the same kinds of values and proposes
them in the [review](#reviewing-an-existing-env).

## What `pnpm dev:doctor` checks

`pnpm dev:doctor` (`node scripts/dev-doctor.mjs`) is read-only. It prints one
line per check with `ok`, `info`, `warn` or `fail`, a `fix:` line under every
problem, and a summary such as `0 failing, 6 warning(s)`. It exits non-zero
only when a check fails.

| Section | Checks |
| --- | --- |
| Toolchain | Node `>= 22.11`; pnpm matches the `pnpm@9.15.0` pin; `node_modules` exists and matches `pnpm-lock.yaml`; whether Docker runs (info only) |
| Configuration | `.env` exists; every key `.env.example` sets is present (missing boot-required keys fail, other missing keys warn, and a commented-out line counts as a deliberate opt-out); JWT secrets are 32+ characters and distinct; `FRONTEND_URL` includes `http://localhost:5173`; email sign-in codes are on (`EMAIL_CODE_DEV_LOG=true` or Resend); Google keys are real or placeholders (info); `.env.test` exists |
| Database | `DATABASE_URL` connects, and a failure names the cause (nothing listening, wrong password, missing role, missing database, TLS mismatch) with the exact command to fix it; pending migrations; applied migrations this checkout lacks (info, usually another branch); `admin@example.com` exists; the `_test` database exists; `DATABASE_URL` exported in your shell overriding `.env` (info) |
| Services | Object storage: unset, half set, still the `.env.example` placeholders, local endpoint without `AWS_S3_FORCE_PATH_STYLE=true`, or bucket reachable; the API answers `GET /health/live` on `PORT` (info when it is stopped) |

## Signing in locally

With `EMAIL_CODE_DEV_LOG=true`, open http://localhost:5173/auth/sign-in on the
frontend, enter `admin@example.com` (the platform Admin) or any seeded member
such as `ana@example.com`, and press **Email me a code**. The API log prints:

```
[dev] sign-in code for challenge <id>: <code>
```

On the Docker path that log is the `docker compose up` output, or
`docker compose logs -f api` when the stack runs in the background. On the
native path it is the `pnpm start:dev` terminal.

The API ignores `EMAIL_CODE_DEV_LOG` when `NODE_ENV=production`, and Google
OAuth is optional locally.

The seed (`src/database/seed.ts`) creates 32 accounts at `@example.com`: 31
fixture members plus the dev admin. It is idempotent (it skips rows that
already exist) and refuses to run when `NODE_ENV=production`. Seeded
communities and listings take their refs from the same sequences the app uses
(`communities_ref_seq`, `listings_ref_seq`), so `pnpm run seed` also works on a
database where people have created communities and listings through the app,
and seeds whatever is left. One collision remains: a member who signed up with
the same name as a fixture member (for example `ana-rocha`) shares that profile
slug, and the seed can fail on it.

## MinIO (local uploads)

Production stores uploads in a Railway Bucket (Tigris underneath). Locally, the
`minio` service in `docker-compose.yml` stands in for it. MinIO speaks the same
S3 API, so presigned uploads and `GET /files/<key>` work end to end. It is for
local development only.

| | |
| --- | --- |
| Image | `minio/minio:RELEASE.2025-04-22T22-12-26Z` |
| S3 API | http://localhost:9000 (`QP_MINIO_PORT`) |
| Console | http://localhost:9001 (`QP_MINIO_CONSOLE_PORT`), user `queerpulse`, password `queerpulse-dev-secret` |
| Bucket | `queerpulse-dev`, created by the `api` service on start or by `pnpm dev:setup` |
| Data | Docker volume `miniodata` (Postgres uses `pgdata`) |

- With the Docker `api`, the API talks to MinIO at `minio:9000` and
  `AWS_PUBLIC_ENDPOINT_URL=http://localhost:9000` makes the presigned URLs
  point at the host port the browser can reach. A native API talks to
  `localhost:9000` directly and needs no `AWS_PUBLIC_ENDPOINT_URL`.
- MinIO serves path-style URLs, so the local block sets
  `AWS_S3_FORCE_PATH_STYLE=true`. Only the exact string `true` turns it on, and
  boot refuses it when `NODE_ENV=production`.
- MinIO accepts browser uploads from every origin by default, so
  `pnpm storage:cors` is a deploy step for the real bucket only. To run it by
  hand against a bucket, load `.env` explicitly, because the script reads only
  `process.env`: `node --env-file=.env scripts/set-bucket-cors.mjs`.
- To start or restart MinIO on its own: `docker compose up -d --wait minio`.
- `docker compose down -v` deletes every volume, which wipes your local
  database and every uploaded file. Run `docker compose up` (or
  `pnpm dev:setup`) afterwards to rebuild.

## Running without Docker

1. Install and start Postgres 16: [Postgres.app](https://postgresapp.com), or
   `brew install postgresql@16 && brew services start postgresql@16`.
2. Create the role the default `DATABASE_URL` uses:

   ```bash
   psql -h localhost -p 5432 -d postgres -c "CREATE ROLE queerpulse LOGIN PASSWORD 'queerpulse' CREATEDB"
   ```

3. Run `pnpm dev:setup` (add `--skip-docker` if Docker is installed and you
   want setup to leave it alone). It creates both databases, migrates and seeds.

Uploads stay off: the five `AWS_*` lines are commented out, the API boots, and
each upload request fails with `Object storage is not configured`. To turn them
on later, start Docker and run `pnpm dev:setup` again: with MinIO running, the
review proposes the local MinIO block, and setup then creates the bucket.
Restart the API afterwards.

## Checking the production image

The `app` service builds the production image (the Dockerfile's `runtime`
stage) and sits behind the `prod-image` profile, so a plain `docker compose up`
never builds it. To check a release build locally:

```bash
docker compose --profile prod-image up app
curl http://localhost:3001/health/live
```

It listens on port 3001 (`QP_PROD_IMAGE_PORT`), so it runs beside `api`, and it
shares the compose `postgres`. It runs the deploy chain (`migration:preflight`,
`migration:run:prod`, `storage:cors`) and then `node dist/main`. It keeps
`NODE_ENV=development` on purpose; the comments in `docker-compose.yml` explain
what `production` would also need.

## The e2e test database

The e2e suites (`test/*.e2e-spec.ts`) delete every table between tests. The
guard in `test/db-safety.ts` refuses to run unless the database name ends in
`_test` or `TEST_DATABASE_URL` is set.

`pnpm dev:setup` handles this: it writes `.env.test` with `DATABASE_URL`
pointing at `queerpulse_test`, creates that database and migrates it. Values
`.env.test` omits fall back to `.env`.

```bash
pnpm run test:e2e
```

After pulling new migrations, migrate the test database too:

```bash
DATABASE_URL=postgres://queerpulse:queerpulse@localhost:5432/queerpulse_test pnpm run migration:run
```

or simply re-run `pnpm dev:setup`, which migrates both.

On the Docker path, `docker compose restart api` migrates both databases, and
the e2e suites run in the container with:

```bash
docker compose exec -e TEST_DATABASE_URL=postgres://queerpulse:queerpulse@postgres:5432/queerpulse_test api pnpm run test:e2e
```

## Migrations and seed, day to day

- `pnpm start:dev` applies pending migrations at boot by default
  (`AUTO_RUN_MIGRATIONS`), in the Docker `api` as on the host.
  `pnpm run migration:run` (or `docker compose exec api pnpm run migration:run`)
  applies them on demand, and `pnpm dev:doctor` reports how many are pending.
- Never rename or renumber an applied migration: TypeORM matches migrations by
  class name, so a renamed one looks pending and its `up()` re-runs.
- A new migration file opens with
  `// DO NOT RUN: authored for review only; the maintainer runs migrations.`
  That banner means "not applied yet" and comes off once it has run.
- For an "already exists" failure, diagnose the ledger with
  `pnpm run typeorm migration:show`. Leave `IF NOT EXISTS` guards out, and pass
  no extra `-d` (the script already sets `-d src/data-source.ts`).
- `pnpm run seed` (or `docker compose exec api pnpm run seed`) adds whatever
  fixtures a database lacks, such as the dev admin on a database seeded before
  it existed, and skips rows that already exist.

See [CLAUDE.md](CLAUDE.md) and the README's
[Database & migrations](README.md#database--migrations) for the full rules.

## Troubleshooting

### Docker path

| Symptom | Cause | Fix |
| --- | --- | --- |
| `docker compose up` stops with `bind: address already in use` for port 3000 | A native `pnpm start:dev` (or another server) already holds 3000 | Stop the native API (Ctrl+C in its terminal), then `docker compose up`. To run both, put `QP_API_PORT=3002` in `.env` and point the frontend's `VITE_API_URL` at `http://localhost:3002` |
| `docker compose up` stops with `bind: address already in use` for port 5432 | Postgres.app or a Homebrew Postgres holds 5432 | Put `QP_POSTGRES_PORT=5433` in `.env` and run `docker compose up` again. For native runs against the container, set `DATABASE_URL` in `.env` to port 5433 too. `pnpm dev:import-db` offers both edits for you |
| `docker compose up` rejects the `env_file` entry of `api` | Docker Compose is older than 2.24, which added `required: false` | Update Docker Desktop or OrbStack, then check `docker compose version` |
| Saving a file under `src/` leaves the API log silent, and the change only shows after `docker compose restart api` | File change events are not reaching the container through the bind mount (older Docker Desktop file sharing, or a checkout on a network or Windows drive) | In Docker Desktop, Settings > General: choose VirtioFS file sharing, or use OrbStack. As a fallback, put `TSC_WATCHFILE=DynamicPriorityPolling` and `TSC_WATCHDIRECTORY=DynamicPriorityPolling` in `.env` and run `docker compose up -d api` (polling uses more CPU) |
| The api log warns `` `pnpm install --frozen-lockfile` exited with code 1 ``, falls back to a plain `pnpm install`, and `git status` shows `pnpm-lock.yaml` changed | `pnpm-lock.yaml` is out of date with `package.json`, so the fallback install rewrote the lockfile in your checkout | When you changed dependencies yourself, commit the new lockfile. Otherwise `git restore pnpm-lock.yaml` and pull the branch that carries the matching lockfile |
| Every session signs out after `docker compose restart api`, and the api log says `this run uses temporary values held in memory` | `.env` lacks valid `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, so each container start generates new ones | Run `pnpm dev:setup` on the host to save them into `.env`, then `docker compose up -d api` |
| On Linux, `EACCES: permission denied` on `.env`, `.env.test`, `dist/`, `node_modules/` or `pnpm-lock.yaml` in your checkout | The dev container runs as root, so files it writes through the bind mount are root-owned (and `.env` is mode `0600`, so your user cannot read it) | From the repo root: `sudo chown -R "$(id -u):$(id -g)" .` |
| `pnpm dev:import-db` stops with `the compose api service is running` | The api's start-up migrations would race the restore | `docker compose stop api`, re-run the import, then `docker compose up` |

### Native path and both

| Symptom | Cause | Fix |
| --- | --- | --- |
| `fail  cannot reach Postgres: nothing is listening on localhost:5432` | Docker Desktop is stopped and no native Postgres runs | Start Docker Desktop and re-run `pnpm dev:setup`, or start Postgres.app / `brew services start postgresql@16` |
| `something else already listens on localhost:5432 (Postgres.app?)` | Another Postgres owns 5432, so setup uses it | Keep it (create the role, see [Running without Docker](#running-without-docker)), or add `QP_POSTGRES_PORT=5433` to `.env`, point `DATABASE_URL` at port 5433 and re-run `pnpm dev:setup`. With no `.env` yet, `QP_POSTGRES_PORT=5433 pnpm dev:setup` writes the port into `DATABASE_URL`; then add `QP_POSTGRES_PORT=5433` to `.env` so `docker compose` and later runs keep it |
| `role "queerpulse" does not exist on localhost:5432` | Native Postgres has no `queerpulse` role | `psql -h localhost -p 5432 -d postgres -c "CREATE ROLE queerpulse LOGIN PASSWORD 'queerpulse' CREATEDB"` |
| `role "queerpulse" may not create databases` | The role lacks `CREATEDB` | `psql -h localhost -p 5432 -d postgres -c "ALTER ROLE queerpulse CREATEDB"` |
| `something else already listens on localhost:9000` | Another service owns the MinIO port | `QP_MINIO_PORT=9100 QP_MINIO_CONSOLE_PORT=9101 pnpm dev:setup`, put the same two lines in `.env`, and point an existing `AWS_ENDPOINT_URL` at `http://localhost:9100` |
| `/auth/email-code` answers 503 `email_code_unavailable` | `EMAIL_CODE_DEV_LOG` is off and Resend is not configured | Add `EMAIL_CODE_DEV_LOG=true` to `.env`, then restart `pnpm start:dev` or run `docker compose up -d api` |
| Frontend requests fail with CORS errors | The frontend runs on an origin `FRONTEND_URL` lacks, usually `localhost:5174` from a second `pnpm dev` | Use port 5173, or add the origin to `FRONTEND_URL` (comma-separated, no trailing slash) and restart the API |
| Uploads fail with `Object storage is not configured` | The `AWS_*` keys are unset or commented out | See the last paragraph of [Running without Docker](#running-without-docker) |
| Boot refuses `AWS_S3_FORCE_PATH_STYLE=true` | `NODE_ENV=production` with the local MinIO flag | Remove it from that environment |
| The API or a migration uses an unexpected database; doctor prints `DATABASE_URL comes from your shell and overrides .env` | An exported `DATABASE_URL` wins, because dotenv never overwrites a variable that is already set | `unset DATABASE_URL`, and remove the export from your shell profile |
| `pnpm storage:cors` skips the bucket | The script reads only `process.env` | `node --env-file=.env scripts/set-bucket-cors.mjs` |
| The API crash-loops at boot against Railway, Render or Fly Postgres | Production defaults to TLS with certificate verification, which these providers fail | `DATABASE_SSL=false` on a private network, `DATABASE_SSL_INSECURE=true` through a public proxy, or `DATABASE_SSL_CA` when the provider publishes a CA. See [Database TLS & connection pool](README.md#database-tls--connection-pool) |
| `the server on localhost:5432 does not speak TLS but the connection asked for it` | `NODE_ENV=production` or `DATABASE_SSL=true` against a local Postgres | Set `DATABASE_SSL=false` in `.env`, or use `NODE_ENV=development` |
| A migration fails with "already exists", or an old migration shows as pending | The `migrations` ledger and the files disagree | `pnpm run typeorm migration:show` |
| `ERR_INVALID_ARG_TYPE` from `pnpm run typeorm` | `-d` was passed twice | Drop your `-d`; the script already passes it |
| Doctor: `no admin@example.com account` | Seeded before the dev admin existed | `pnpm run seed` |
| `pnpm run test:e2e` refuses to start | `.env.test` is missing or its database name lacks `_test` | `pnpm dev:setup` |
| CI fails on `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` was not committed after a dependency change | Run `pnpm install` and commit the updated lockfile |
