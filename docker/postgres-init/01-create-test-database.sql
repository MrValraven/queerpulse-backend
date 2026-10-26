-- Runs once, when the postgres service starts on an EMPTY data volume
-- (the official image executes /docker-entrypoint-initdb.d on first init only).
-- POSTGRES_DB already creates `queerpulse`; this adds the test database that
-- the e2e and *.postgres.spec suites use, owned by the same `queerpulse` role.
-- An existing volume never reruns this file: `scripts/dev-setup.mjs` creates
-- whichever of the two databases is missing on every run.
CREATE DATABASE queerpulse_test;
