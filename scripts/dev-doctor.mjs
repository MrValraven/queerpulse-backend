// Read-only health check for a local QueerPulse backend checkout:
//
//   pnpm dev:doctor
//
// Every check prints `ok`, `info`, `warn` or `fail`, with a one-line fix when
// it is anything but ok. The exit code is 1 when at least one check fails.
//
// It NEVER changes anything: no file writes, no migrations, no seeding, no
// CREATE DATABASE, no bucket writes. Database access is SELECT-only, storage
// access is a single HeadBucket, and the API probe is one GET. Every network
// call has a short timeout so the doctor never hangs. Secret values are never
// printed, only key names and lengths.
//
// The helpers are exported because scripts/dev-setup.mjs reuses them. This
// module imports Node built-ins only at the top level (dev-setup runs before
// `pnpm install`); `pg` and `@aws-sdk/client-s3` are imported lazily and their
// absence is reported as a finding.
//
// The .env editing helpers below (formatEnvValue, applyEnvEdits,
// writeEnvFileEdits, createPrompter) are shared with dev-setup.mjs and
// dev-import-db.mjs. The doctor itself never calls the ones that write.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants as fileConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const ENV_PATH = join(PROJECT_ROOT, '.env');
export const ENV_EXAMPLE_PATH = join(PROJECT_ROOT, '.env.example');
export const ENV_TEST_PATH = join(PROJECT_ROOT, '.env.test');
export const ENV_TEST_EXAMPLE_PATH = join(PROJECT_ROOT, '.env.test.example');

export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_NODE_MINOR = 11;
export const REQUIRED_PNPM_MAJOR = 9;
export const FRONTEND_DEV_ORIGIN = 'http://localhost:5173';
export const DEV_ADMIN_EMAIL = 'admin@example.com';
export const LOCAL_MINIO_BUCKET = 'queerpulse-dev';
export const LOCAL_MINIO_USER = 'queerpulse';
export const LOCAL_MINIO_PASSWORD = 'queerpulse-dev-secret';

// Variables env validation refuses to boot without (src/config/env.validation.ts).
export const BOOT_REQUIRED_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
];

export const STORAGE_KEYS = [
  'AWS_ENDPOINT_URL',
  'AWS_DEFAULT_REGION',
  'AWS_S3_BUCKET_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

// The values .env.example ships with. They boot, but they are not credentials.
const GOOGLE_PLACEHOLDERS = new Set([
  'your-google-client-id',
  'your-google-client-secret',
]);
const STORAGE_PLACEHOLDERS = new Set([
  'your-bucket-access-key-id',
  'your-bucket-secret-access-key',
]);

const DATABASE_TIMEOUT_MS = 3_000;
const STORAGE_TIMEOUT_MS = 3_000;
const API_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Env files

// Same grammar as dotenv's parse(): `KEY=value`, optional `export`, single,
// double or backtick quotes, `#` comments, and multi-line double-quoted values
// in which `\n` and `\r` escapes expand. Re-implemented here so it works before
// `pnpm install`; the app reads the file through dotenv, so a PEM written as
// "-----BEGIN...\n...\n-----END..." arrives with real newlines either way.
const ENV_LINE_PATTERN =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function parseEnvText(text) {
  const values = {};
  const normalizedText = text.replace(/\r\n?/gm, '\n');
  for (const match of normalizedText.matchAll(ENV_LINE_PATTERN)) {
    const key = match[1];
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
    if (quote === '"') {
      value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    }
    values[key] = value;
  }
  return values;
}

export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  return parseEnvText(readFileSync(path, 'utf8'));
}

// Keys a file assigns on an uncommented line, in file order.
export function listAssignedKeys(text) {
  return [...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map(
    (match) => match[1],
  );
}

// Keys a file mentions only as `# KEY=...`, i.e. deliberately switched off.
export function listCommentedKeys(text) {
  return [...text.matchAll(/^\s*#\s*([A-Z][A-Z0-9_]*)=/gm)].map(
    (match) => match[1],
  );
}

// What the app sees: a variable exported in the shell wins over .env, because
// dotenv never overwrites an already-set variable.
export function effectiveValue(fileValues, key) {
  if (process.env[key] !== undefined) return process.env[key];
  return fileValues?.[key];
}

// True inside the compose `api` service, which sets QP_IN_CONTAINER=1.
export function isInsideContainer() {
  return process.env.QP_IN_CONTAINER === '1';
}

const restartApiFixText =
  'run `docker compose restart api` on your machine (setup re-runs on every start)';

// Picks the fix that applies where the script runs.
function containerAwareFix(hostFix, containerFix) {
  return isInsideContainer() ? containerFix : hostFix;
}

// ---------------------------------------------------------------------------
// Value checks that mirror what env validation refuses at boot

// Mirrors invalidFrontendOrigins() in src/config/frontend-origins.ts: each
// comma-separated entry, trailing slashes stripped, must round-trip through
// `new URL(entry).origin` unchanged.
export function findInvalidFrontendOrigins(rawValue) {
  return (rawValue ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => {
      if (entry.length === 0) return false;
      try {
        return new URL(entry).origin !== entry;
      } catch {
        return true;
      }
    });
}

// Returns why a DATABASE_URL cannot work, or null when it is well formed.
export function describeDatabaseUrlProblem(databaseUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    return 'it is not a URL (expected postgres://user:password@host:port/database)';
  }
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
    return `its scheme is "${parsedUrl.protocol.replace(/:$/, '')}" (expected postgres or postgresql)`;
  }
  if (!parsedUrl.hostname) return 'it names no host';
  if (!parsedUrl.pathname.replace(/^\//, '')) return 'it names no database';
  return null;
}

export const MINIMUM_JWT_SECRET_LENGTH = 32;

// ---------------------------------------------------------------------------
// .env editing (dev-setup.mjs and dev-import-db.mjs; never the doctor)

// The literal text to put after `KEY=` so dotenv reads back exactly `value`.
// Returns null for a value one .env line cannot hold.
export function formatEnvValue(value) {
  if (value === '') return '';
  if (/^[^\s#'"`\\]+$/.test(value)) return value;
  if (/[\r\n]/.test(value)) {
    // dotenv expands `\n` only inside double quotes, which is how a PEM fits
    // on one line.
    if (value.includes('"') || value.includes('\r') || /\\n/.test(value)) {
      return null;
    }
    return `"${value.replace(/\n/g, '\\n')}"`;
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !/\\[nr]/.test(value)) return `"${value}"`;
  return null;
}

function hasClosingQuote(text, quote) {
  for (
    let characterIndex = 0;
    characterIndex < text.length;
    characterIndex += 1
  ) {
    if (text[characterIndex] === '\\') {
      characterIndex += 1;
    } else if (text[characterIndex] === quote) {
      return true;
    }
  }
  return false;
}

const ASSIGNMENT_START_PATTERN = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/;

// Finds every `KEY=value` assignment and the line span it covers. A quoted
// value that opens without closing continues until the line that closes it,
// the way dotenv reads a multi-line PEM. Commented lines are never matched.
export function locateEnvAssignments(text) {
  const lines = text.split('\n');
  const assignments = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = ASSIGNMENT_START_PATTERN.exec(
      lines[lineIndex].replace(/\r$/, ''),
    );
    if (!match) continue;
    const valueText = match[2];
    const quote = valueText[0];
    let endIndex = lineIndex;
    if (
      (quote === '"' || quote === "'" || quote === '`') &&
      !hasClosingQuote(valueText.slice(1), quote)
    ) {
      let searchIndex = lineIndex + 1;
      while (
        searchIndex < lines.length &&
        !hasClosingQuote(lines[searchIndex], quote)
      ) {
        searchIndex += 1;
      }
      // Never closed: dotenv then reads only the first line, so do we.
      if (searchIndex < lines.length) endIndex = searchIndex;
    }
    assignments.push({ key: match[1], startIndex: lineIndex, endIndex });
    lineIndex = endIndex;
  }
  return { lines, assignments };
}

// Applies [{ key, value }] to .env text. A key that already has an assignment
// gets that line replaced (the last one, which is the one dotenv keeps); any
// other key is appended under `addedComment`. Every other line stays as it was.
export function applyEnvEdits(text, edits, addedComment) {
  const { lines, assignments } = locateEnvAssignments(text);
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const editsByKey = new Map(edits.map((edit) => [edit.key, edit.value]));
  const replacementsByStartIndex = new Map();
  const appendedLines = [];
  const replacedKeys = [];
  const appendedKeys = [];
  for (const [key, value] of editsByKey) {
    const formattedValue = formatEnvValue(value);
    if (formattedValue === null) {
      throw new Error(
        `${key} cannot be written to .env: its value mixes both quote kinds or holds a literal \\n next to a line break`,
      );
    }
    const lastAssignment = assignments
      .filter((assignment) => assignment.key === key)
      .at(-1);
    if (lastAssignment) {
      const exportPrefix =
        /^\s*export\s+/.exec(lines[lastAssignment.startIndex])?.[0] ?? '';
      const carriageReturn = lines[lastAssignment.endIndex].endsWith('\r')
        ? '\r'
        : '';
      replacementsByStartIndex.set(lastAssignment.startIndex, {
        endIndex: lastAssignment.endIndex,
        line: `${exportPrefix}${key}=${formattedValue}${carriageReturn}`,
      });
      replacedKeys.push(key);
    } else {
      appendedLines.push(`${key}=${formattedValue}`);
      appendedKeys.push(key);
    }
  }
  const outputLines = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const replacement = replacementsByStartIndex.get(lineIndex);
    if (replacement) {
      outputLines.push(replacement.line);
      lineIndex = replacement.endIndex;
    } else {
      outputLines.push(lines[lineIndex]);
    }
  }
  let updatedText = outputLines.join('\n');
  if (appendedLines.length > 0) {
    if (updatedText.length > 0 && !updatedText.endsWith('\n')) {
      updatedText += lineBreak;
    }
    if (updatedText.length > 0 && !/\n\r?\n$/.test(updatedText)) {
      updatedText += lineBreak;
    }
    updatedText += [addedComment, ...appendedLines].join(lineBreak) + lineBreak;
  }
  return { text: updatedText, replacedKeys, appendedKeys };
}

function padNumber(value, width = 2) {
  return String(value).padStart(width, '0');
}

// Local time as YYYYMMDD-HHMMSS.
export function formatTimestamp(date = new Date()) {
  return `${date.getFullYear()}${padNumber(date.getMonth() + 1)}${padNumber(date.getDate())}-${padNumber(date.getHours())}${padNumber(date.getMinutes())}${padNumber(date.getSeconds())}`;
}

// Local date as YYYY-MM-DD.
export function formatDate(date = new Date()) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

// Copies the file to `<path>.backup-YYYYMMDD-HHMMSS` (mode 0600, never
// overwriting an earlier backup) and returns the backup path.
export function backupEnvFile(envPath, date = new Date()) {
  const basePath = `${envPath}.backup-${formatTimestamp(date)}`;
  let backupPath = basePath;
  for (let suffix = 2; existsSync(backupPath); suffix += 1) {
    backupPath = `${basePath}-${suffix}`;
  }
  copyFileSync(envPath, backupPath, fileConstants.COPYFILE_EXCL);
  chmodSync(backupPath, 0o600);
  return backupPath;
}

// Backs the file up, then applies the edits in place, keeping its mode.
export function writeEnvFileEdits(envPath, edits, toolName, date = new Date()) {
  const originalText = readFileSync(envPath, 'utf8');
  const result = applyEnvEdits(
    originalText,
    edits,
    `# Added by ${toolName} on ${formatDate(date)}`,
  );
  const backupPath = backupEnvFile(envPath, date);
  writeFileSync(envPath, result.text, { mode: statSync(envPath).mode & 0o777 });
  return { ...result, backupPath };
}

// ---------------------------------------------------------------------------
// Prompts

export function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// A small question helper over node:readline/promises. ask() resolves to the
// trimmed answer, or to null once the input closes (Ctrl+C or Ctrl+D), so a
// caller can stop without writing anything.
export function createPrompter() {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let isClosed = false;
  const closedPromise = new Promise((resolvePromise) => {
    readline.once('close', () => {
      isClosed = true;
      resolvePromise(null);
    });
  });
  // Without this listener readline only pauses on Ctrl+C and the script hangs.
  readline.on('SIGINT', () => {
    process.stdout.write('\n');
    readline.close();
  });
  const ask = async (question) => {
    if (isClosed) return null;
    const answer = await Promise.race([
      readline.question(question).catch(() => null),
      closedPromise,
    ]);
    return answer === null ? null : answer.trim();
  };
  // Resolves true or false, or null when the input closed.
  const confirm = async (question, isYesDefault = true) => {
    const hint = isYesDefault ? '[Y/n]' : '[y/N]';
    for (;;) {
      const answer = await ask(`${question} ${hint} `);
      if (answer === null) return null;
      if (answer === '') return isYesDefault;
      if (/^y(es)?$/i.test(answer)) return true;
      if (/^no?$/i.test(answer)) return false;
      console.log('  Answer y or n.');
    }
  };
  const close = () => {
    if (!isClosed) readline.close();
  };
  return { ask, confirm, close };
}

// ---------------------------------------------------------------------------
// Toolchain

export function checkNodeVersion() {
  const found = process.versions.node;
  const [major, minor] = found.split('.').map(Number);
  const isSupported =
    major > REQUIRED_NODE_MAJOR ||
    (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR);
  return {
    found,
    needed: `${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0`,
    isSupported,
  };
}

export function readPinnedPnpmVersion() {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'),
    );
    const pinned = /^pnpm@(.+)$/.exec(packageJson.packageManager ?? '');
    return pinned ? pinned[1] : `${REQUIRED_PNPM_MAJOR}.x`;
  } catch {
    return `${REQUIRED_PNPM_MAJOR}.x`;
  }
}

export function runQuietly(command, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
  return {
    isMissing: result.error?.code === 'ENOENT',
    hasTimedOut: result.error?.code === 'ETIMEDOUT',
    isSuccess: !result.error && result.status === 0,
    output: `${result.stdout ?? ''}`.trim(),
    errorOutput: `${result.stderr ?? ''}`.trim(),
  };
}

export function checkPnpmVersion() {
  const pinned = readPinnedPnpmVersion();
  const result = runQuietly('pnpm', ['--version']);
  if (result.isMissing) return { found: null, pinned, isSupported: false };
  const found = result.isSuccess ? result.output.split('\n').pop() : null;
  const major = Number((found ?? '').split('.')[0]);
  return { found, pinned, isSupported: major === REQUIRED_PNPM_MAJOR };
}

export function detectDocker() {
  const compose = runQuietly(
    'docker',
    ['compose', 'version', '--short'],
    5_000,
  );
  if (compose.isMissing)
    return {
      hasCompose: false,
      isDaemonRunning: false,
      reason: 'docker is not installed',
    };
  if (!compose.isSuccess) {
    return {
      hasCompose: false,
      isDaemonRunning: false,
      reason: 'docker is installed but the `docker compose` plugin is missing',
    };
  }
  const daemon = runQuietly(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    8_000,
  );
  if (!daemon.isSuccess) {
    return {
      hasCompose: true,
      isDaemonRunning: false,
      composeVersion: compose.output,
      reason: daemon.hasTimedOut
        ? 'the Docker daemon did not answer within 8s'
        : 'the Docker daemon is not running (start Docker Desktop, OrbStack or colima)',
    };
  }
  return {
    hasCompose: true,
    isDaemonRunning: true,
    composeVersion: compose.output,
  };
}

// Parses `docker compose ps --format json`: one JSON object per line since
// compose 2.21, a single JSON array before that.
export function parseComposePsOutput(output) {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) return [];
  if (trimmedOutput.startsWith('[')) return JSON.parse(trimmedOutput);
  return trimmedOutput
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// The compose services of this project with their state, read-only.
export function readComposeServices(timeoutMs = 5_000) {
  const result = runQuietly(
    'docker',
    ['compose', 'ps', '--all', '--format', 'json'],
    timeoutMs,
  );
  if (!result.isSuccess) {
    return {
      isKnown: false,
      reason: result.hasTimedOut
        ? `\`docker compose ps\` did not answer within ${timeoutMs / 1000}s`
        : `\`docker compose ps\` failed: ${result.errorOutput.split('\n')[0] || 'it printed nothing'}`,
    };
  }
  try {
    return {
      isKnown: true,
      services: parseComposePsOutput(result.output).map((container) => ({
        service: container.Service,
        state: container.State,
        health: container.Health ?? '',
      })),
    };
  } catch {
    return {
      isKnown: false,
      reason:
        '`docker compose ps --format json` printed something that is not JSON',
    };
  }
}

// True when something accepts TCP connections on localhost:<port>. Connects
// only; never binds.
export async function isPortListening(port, timeoutMs = 1_000) {
  const tryHost = (host) =>
    new Promise((resolvePromise) => {
      const socket = new Socket();
      const finish = (isListening) => {
        socket.destroy();
        resolvePromise(isListening);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  const [isIpv4Listening, isIpv6Listening] = await Promise.all([
    tryHost('127.0.0.1'),
    tryHost('::1'),
  ]);
  return isIpv4Listening || isIpv6Listening;
}

// ---------------------------------------------------------------------------
// Postgres

export async function loadPg() {
  try {
    const pgModule = await import('pg');
    return pgModule.default ?? pgModule;
  } catch {
    return null;
  }
}

export async function loadS3() {
  try {
    return await import('@aws-sdk/client-s3');
  } catch {
    return null;
  }
}

// Mirrors src/config/database-ssl.ts (re-implemented here so the script runs
// without a compiled dist/, the convention migration-preflight.mjs follows).
export function resolvePostgresSsl(fileValues) {
  const explicit = effectiveValue(fileValues, 'DATABASE_SSL');
  const nodeEnv = effectiveValue(fileValues, 'NODE_ENV');
  const isSslEnabled =
    explicit === 'true'
      ? true
      : explicit === 'false'
        ? false
        : nodeEnv === 'production';
  if (!isSslEnabled) return false;
  if (effectiveValue(fileValues, 'DATABASE_SSL_INSECURE') === 'true') {
    return { rejectUnauthorized: false };
  }
  const ssl = { rejectUnauthorized: true };
  const certificateAuthority = effectiveValue(fileValues, 'DATABASE_SSL_CA');
  if (certificateAuthority) {
    ssl.ca = certificateAuthority.includes('BEGIN CERTIFICATE')
      ? certificateAuthority
      : readFileSync(certificateAuthority, 'utf8');
  }
  return ssl;
}

export function describeDatabaseUrl(databaseUrl) {
  const parsedUrl = new URL(databaseUrl);
  return {
    host: parsedUrl.hostname || 'localhost',
    port: Number(parsedUrl.port || 5432),
    user: decodeURIComponent(parsedUrl.username || ''),
    database: decodeURIComponent(parsedUrl.pathname.replace(/^\//, '')),
  };
}

export function withDatabaseName(databaseUrl, databaseName) {
  const parsedUrl = new URL(databaseUrl);
  parsedUrl.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsedUrl.toString();
}

export function testDatabaseName(databaseName) {
  return databaseName.endsWith('_test') ? databaseName : `${databaseName}_test`;
}

// Turns a pg connection or query error into a cause and a fix that name the
// exact server, role and database involved.
export function explainPostgresError(error, target) {
  const address = `${target.host}:${target.port}`;
  const code = error?.code;
  const message = `${error?.message ?? error}`;
  if (code === 'ECONNREFUSED') {
    return {
      reason: `nothing is listening on ${address}`,
      fix: containerAwareFix(
        'start Postgres: `docker compose up` (or `pnpm dev:setup`) starts the compose container when Docker runs, or open Postgres.app / `brew services start postgresql@16`',
        'run `docker compose up -d --wait postgres` on your machine, then `docker compose restart api`',
      ),
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      reason: `the database host "${target.host}" does not resolve`,
      fix: containerAwareFix(
        'point DATABASE_URL in .env at localhost or a reachable host',
        'check that docker-compose.yml points the api service DATABASE_URL at the `postgres` service',
      ),
    };
  }
  if (/timeout/i.test(message)) {
    return {
      reason: `${address} did not answer within ${DATABASE_TIMEOUT_MS / 1000}s`,
      fix: `check that Postgres on ${address} is running and not paused`,
    };
  }
  if (code === '28P01') {
    return {
      reason: `password authentication failed for role "${target.user}" on ${address}`,
      fix: 'fix the password in DATABASE_URL in .env',
    };
  }
  if (code === '28000' && /does not exist/.test(message)) {
    return {
      reason: `role "${target.user}" does not exist on ${address}`,
      fix: `psql -h ${target.host} -p ${target.port} -d postgres -c "CREATE ROLE ${target.user} LOGIN PASSWORD 'queerpulse' CREATEDB"`,
    };
  }
  if (code === '28000') {
    return {
      reason: `the server on ${address} rejected role "${target.user}" (pg_hba.conf has no matching entry)`,
      fix: `allow local password logins for "${target.user}" in that server's pg_hba.conf`,
    };
  }
  if (code === '3D000') {
    return {
      reason: `database "${target.database}" does not exist on ${address}`,
      fix: containerAwareFix(
        'run `pnpm dev:setup` to create it',
        restartApiFixText,
      ),
    };
  }
  if (code === '42501') {
    return {
      reason: `role "${target.user}" may not create databases on ${address}`,
      fix: `psql -h ${target.host} -p ${target.port} -d postgres -c "ALTER ROLE ${target.user} CREATEDB"`,
    };
  }
  if (/does not support SSL/i.test(message)) {
    return {
      reason: `the server on ${address} does not speak TLS but the connection asked for it`,
      fix: 'set DATABASE_SSL=false in .env (or unset NODE_ENV=production)',
    };
  }
  return {
    reason: `${code ? `${code}: ` : ''}${message} (on ${address})`,
    fix: 'check DATABASE_URL in .env',
  };
}

export async function connectPostgres(pg, databaseUrl, fileValues) {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: resolvePostgresSsl(fileValues),
    connectionTimeoutMillis: DATABASE_TIMEOUT_MS,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    application_name: 'queerpulse-dev-doctor',
  });
  // An idle client that loses its server emits 'error'; without a listener
  // that would crash the script with an unrelated stack trace.
  client.on('error', () => {});
  await client.connect();
  return client;
}

export async function databaseExists(client, databaseName) {
  const result = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );
  return result.rowCount > 0;
}

export async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) AS relation', [
    `public.${tableName}`,
  ]);
  return result.rows[0]?.relation !== null;
}

// The ledger names this checkout carries: each migration's `name` property,
// falling back to its class name (what TypeORM records when `name` is unset).
export function listMigrationNames() {
  const migrationsDirectory = join(PROJECT_ROOT, 'src', 'migrations');
  const names = [];
  for (const fileName of readdirSync(migrationsDirectory)) {
    if (!fileName.endsWith('.ts') || fileName.endsWith('.spec.ts')) continue;
    const source = readFileSync(join(migrationsDirectory, fileName), 'utf8');
    const nameProperty = /^\s*(?:public\s+)?name\s*=\s*['"]([^'"]+)['"]/m.exec(
      source,
    );
    const className =
      /export\s+class\s+(\w+)\s+implements\s+MigrationInterface/.exec(source);
    const migrationName = nameProperty?.[1] ?? className?.[1];
    if (migrationName) names.push(migrationName);
  }
  return names;
}

// Ledger rows under a pre-rename name count as applied: the app rewrites them
// at boot (src/database/renamed-migrations.ts) instead of re-running them.
function readRenamedMigrationPairs() {
  try {
    const source = readFileSync(
      join(PROJECT_ROOT, 'src', 'database', 'renamed-migrations.ts'),
      'utf8',
    );
    return [
      ...source.matchAll(
        /previousName:\s*'([^']+)',\s*currentName:\s*'([^']+)'/g,
      ),
    ].map((match) => ({ previousName: match[1], currentName: match[2] }));
  } catch {
    return [];
  }
}

// Read-only: one SELECT on the `migrations` ledger, compared with the files.
export async function findPendingMigrations(client) {
  const carriedNames = listMigrationNames();
  if (!(await tableExists(client, 'migrations'))) {
    return {
      pendingNames: carriedNames,
      unknownAppliedNames: [],
      carriedCount: carriedNames.length,
    };
  }
  const ledger = await client.query('SELECT name FROM migrations');
  const appliedNames = new Set(ledger.rows.map((row) => row.name));
  for (const { previousName, currentName } of readRenamedMigrationPairs()) {
    if (appliedNames.has(previousName)) appliedNames.add(currentName);
  }
  const carriedNameSet = new Set(carriedNames);
  const renamedPreviousNames = new Set(
    readRenamedMigrationPairs().map((pair) => pair.previousName),
  );
  return {
    pendingNames: carriedNames.filter((name) => !appliedNames.has(name)),
    unknownAppliedNames: ledger.rows
      .map((row) => row.name)
      .filter(
        (name) => !carriedNameSet.has(name) && !renamedPreviousNames.has(name),
      ),
    carriedCount: carriedNames.length,
  };
}

// ---------------------------------------------------------------------------
// Storage

export function isPlaceholderStorage(fileValues) {
  return STORAGE_KEYS.some((key) =>
    STORAGE_PLACEHOLDERS.has(effectiveValue(fileValues, key) ?? ''),
  );
}

export function isLocalEndpoint(endpointUrl) {
  try {
    const { hostname } = new URL(endpointUrl);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

export function createStorageClient(s3Module, fileValues) {
  return new s3Module.S3Client({
    endpoint: effectiveValue(fileValues, 'AWS_ENDPOINT_URL'),
    region: effectiveValue(fileValues, 'AWS_DEFAULT_REGION'),
    credentials: {
      accessKeyId: effectiveValue(fileValues, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: effectiveValue(fileValues, 'AWS_SECRET_ACCESS_KEY'),
    },
    forcePathStyle:
      effectiveValue(fileValues, 'AWS_S3_FORCE_PATH_STYLE') === 'true',
    maxAttempts: 1,
  });
}

// One HeadBucket with a hard timeout. Returns { exists, reason }.
export async function probeBucket(s3Module, client, bucketName, endpointUrl) {
  try {
    await client.send(new s3Module.HeadBucketCommand({ Bucket: bucketName }), {
      abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
    return { exists: true };
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (
      status === 404 ||
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchBucket'
    ) {
      return {
        exists: false,
        isReachable: true,
        reason: `bucket "${bucketName}" does not exist at ${endpointUrl}`,
      };
    }
    if (status === 403) {
      return {
        exists: false,
        isReachable: true,
        reason: `${endpointUrl} refused the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY pair for bucket "${bucketName}"`,
      };
    }
    if (status === 301) {
      return {
        exists: false,
        isReachable: true,
        reason: `bucket "${bucketName}" lives in another region than AWS_DEFAULT_REGION`,
      };
    }
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return {
        exists: false,
        isReachable: false,
        reason: `${endpointUrl} did not answer within ${STORAGE_TIMEOUT_MS / 1000}s`,
      };
    }
    const causeCode = error?.code ?? error?.cause?.code;
    if (causeCode === 'ECONNREFUSED') {
      return {
        exists: false,
        isReachable: false,
        reason: `nothing is listening at ${endpointUrl}`,
      };
    }
    if (causeCode === 'ENOTFOUND') {
      return {
        exists: false,
        isReachable: false,
        reason: `the storage host in ${endpointUrl} does not resolve`,
      };
    }
    return {
      exists: false,
      isReachable: false,
      reason: `${error?.name ?? 'error'}: ${error?.message ?? error} (at ${endpointUrl})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Output

export function createPainter(stream = process.stdout) {
  const hasColor = Boolean(stream.isTTY) && !('NO_COLOR' in process.env);
  const paint = (code) => (text) =>
    hasColor ? `\u001b[${code}m${text}\u001b[0m` : text;
  return {
    green: paint('32'),
    yellow: paint('33'),
    red: paint('31'),
    cyan: paint('36'),
    dim: paint('2'),
    bold: paint('1'),
  };
}

// ---------------------------------------------------------------------------
// The doctor

// Info only: which compose services exist and whether they run.
function reportComposeStack(report) {
  const composeState = readComposeServices();
  if (!composeState.isKnown) {
    report('info', `compose stack state unknown: ${composeState.reason}`);
    return;
  }
  if (composeState.services.length === 0) {
    report(
      'info',
      'the compose stack is not up (`docker compose up` starts the API, Postgres and MinIO)',
    );
    return;
  }
  const summary = composeState.services
    .map(
      (container) =>
        `${container.service} ${container.state}${container.health ? ` (${container.health})` : ''}`,
    )
    .join(', ');
  const isEveryServiceRunning = composeState.services.every(
    (container) => container.state === 'running',
  );
  report(
    'info',
    `${isEveryServiceRunning ? 'compose stack is up' : 'compose stack is partly up'}: ${summary}`,
  );
}

export async function runDoctor() {
  const painter = createPainter();
  const statusLabels = {
    ok: painter.green('ok  '),
    info: painter.cyan('info'),
    warn: painter.yellow('warn'),
    fail: painter.red('fail'),
  };
  let failureCount = 0;
  let warningCount = 0;
  const report = (status, message, fix) => {
    if (status === 'fail') failureCount += 1;
    if (status === 'warn') warningCount += 1;
    console.log(`  ${statusLabels[status]}  ${message}`);
    if (fix) console.log(`        ${painter.dim(`fix: ${fix}`)}`);
  };
  const section = (title) => console.log(`\n${painter.bold(title)}`);

  // Inside the compose api container, setup re-runs on every start and .env
  // lives on the host, so fixes name compose commands there.
  const isContainer = isInsideContainer();
  const fixFor = (hostFix, containerFix) =>
    isContainer ? containerFix : hostFix;
  const restartApiFix =
    '`docker compose restart api` (setup re-runs on every start)';
  const saveEnvOnHostFix =
    'run `pnpm dev:setup` on your machine (it offers to fix .env), then `docker compose restart api`';

  console.log(
    painter.bold(
      `QueerPulse backend doctor (read-only${isContainer ? ', inside the compose api container' : ''})`,
    ),
  );

  // Toolchain -----------------------------------------------------------------
  section('Toolchain');
  const nodeVersion = checkNodeVersion();
  if (nodeVersion.isSupported) {
    report('ok', `Node ${nodeVersion.found} (needs >= ${nodeVersion.needed})`);
  } else {
    report(
      'fail',
      `Node ${nodeVersion.found} is older than the required ${nodeVersion.needed}`,
      fixFor(
        'install Node 22 LTS (`nvm install` reads .nvmrc)',
        'rebuild the image: `docker compose build api`',
      ),
    );
  }

  const pnpmVersion = checkPnpmVersion();
  if (pnpmVersion.isSupported) {
    report(
      'ok',
      `pnpm ${pnpmVersion.found} (repo pins pnpm@${pnpmVersion.pinned})`,
    );
  } else if (pnpmVersion.found === null) {
    report(
      'fail',
      'pnpm is not installed',
      fixFor(
        'run `corepack enable` (ships with Node), then re-run',
        'rebuild the image: `docker compose build api`',
      ),
    );
  } else {
    report(
      'fail',
      `pnpm ${pnpmVersion.found} found, this repo needs pnpm ${REQUIRED_PNPM_MAJOR} (pins pnpm@${pnpmVersion.pinned})`,
      fixFor(
        'run `corepack enable` so pnpm follows package.json packageManager',
        'rebuild the image: `docker compose build api`',
      ),
    );
  }

  const modulesManifest = join(PROJECT_ROOT, 'node_modules', '.modules.yaml');
  const installedLockfile = join(
    PROJECT_ROOT,
    'node_modules',
    '.pnpm',
    'lock.yaml',
  );
  const projectLockfile = join(PROJECT_ROOT, 'pnpm-lock.yaml');
  if (!existsSync(modulesManifest)) {
    report(
      'fail',
      'node_modules is missing',
      fixFor('run `pnpm install`', restartApiFix),
    );
  } else if (
    existsSync(installedLockfile) &&
    existsSync(projectLockfile) &&
    readFileSync(installedLockfile, 'utf8') !==
      readFileSync(projectLockfile, 'utf8')
  ) {
    report(
      'warn',
      'node_modules is out of date with pnpm-lock.yaml',
      fixFor('run `pnpm install`', restartApiFix),
    );
  } else {
    report('ok', 'node_modules installed and matches pnpm-lock.yaml');
  }

  if (isContainer) {
    report(
      'info',
      'running inside the compose api container (QP_IN_CONTAINER=1), so the Docker checks are skipped',
    );
  } else {
    const docker = detectDocker();
    if (docker.isDaemonRunning) {
      report('info', `Docker running (compose ${docker.composeVersion})`);
      reportComposeStack(report);
    } else {
      report(
        'info',
        `Docker unavailable: ${docker.reason}. Fine when Postgres runs natively; local uploads need MinIO from docker compose`,
      );
    }
  }

  // Configuration -------------------------------------------------------------
  section('Configuration');
  const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : null;
  const fileValues = envText === null ? {} : parseEnvText(envText);
  if (envText === null && isContainer) {
    report(
      'warn',
      '.env is missing, so only the compose environment configures this container',
      `${restartApiFix} writes one with fresh local secrets`,
    );
  } else if (envText === null) {
    report(
      'fail',
      '.env is missing',
      'run `pnpm dev:setup` (it writes .env with fresh local secrets)',
    );
  } else {
    report('ok', '.env present');
    const exampleText = existsSync(ENV_EXAMPLE_PATH)
      ? readFileSync(ENV_EXAMPLE_PATH, 'utf8')
      : '';
    const acknowledgedKeys = new Set([
      ...listAssignedKeys(envText),
      ...listCommentedKeys(envText),
    ]);
    const missingKeys = [...new Set(listAssignedKeys(exampleText))].filter(
      (key) => !acknowledgedKeys.has(key) && process.env[key] === undefined,
    );
    const missingBootKeys = missingKeys.filter((key) =>
      BOOT_REQUIRED_KEYS.includes(key),
    );
    const missingOptionalKeys = missingKeys.filter(
      (key) => !BOOT_REQUIRED_KEYS.includes(key),
    );
    if (missingBootKeys.length > 0) {
      report(
        'fail',
        `.env lacks ${missingBootKeys.join(', ')}; the API refuses to boot without ${missingBootKeys.length === 1 ? 'it' : 'them'}`,
        fixFor(
          'run `pnpm dev:setup` (it offers to add them), or copy those lines from .env.example',
          saveEnvOnHostFix,
        ),
      );
    }
    if (missingOptionalKeys.length > 0) {
      report(
        'warn',
        `.env lacks ${missingOptionalKeys.length} key(s) .env.example sets: ${missingOptionalKeys.join(', ')}`,
        fixFor(
          'run `pnpm dev:setup --update-env` (it offers each one), or add them commented out to opt out on purpose',
          saveEnvOnHostFix,
        ),
      );
    }
    if (missingKeys.length === 0) {
      report('ok', 'every key .env.example sets is present in .env');
    }
  }

  const accessSecret = effectiveValue(fileValues, 'JWT_ACCESS_SECRET') ?? '';
  const refreshSecret = effectiveValue(fileValues, 'JWT_REFRESH_SECRET') ?? '';
  if (
    accessSecret.length < MINIMUM_JWT_SECRET_LENGTH ||
    refreshSecret.length < MINIMUM_JWT_SECRET_LENGTH
  ) {
    report(
      'fail',
      `JWT secrets must be at least ${MINIMUM_JWT_SECRET_LENGTH} characters (access: ${accessSecret.length}, refresh: ${refreshSecret.length})`,
      fixFor(
        'run `pnpm dev:setup` (it offers fresh secrets), or set both to the output of `openssl rand -base64 48`',
        'setup in this container uses temporary secrets until you run `pnpm dev:setup` on your machine, then `docker compose restart api`',
      ),
    );
  } else if (accessSecret === refreshSecret) {
    report(
      'fail',
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical; boot refuses that',
      fixFor(
        'run `pnpm dev:setup` (it offers a fresh JWT_REFRESH_SECRET), or set it to its own `openssl rand -base64 48` value',
        saveEnvOnHostFix,
      ),
    );
  } else {
    report('ok', 'JWT secrets are long enough and distinct');
  }

  const rawFrontendUrl = effectiveValue(fileValues, 'FRONTEND_URL') ?? '';
  const invalidFrontendOrigins = findInvalidFrontendOrigins(rawFrontendUrl);
  const frontendOrigins = rawFrontendUrl
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (invalidFrontendOrigins.length > 0) {
    report(
      'fail',
      `FRONTEND_URL holds entries that are not exact origins, so boot refuses it: ${invalidFrontendOrigins.join(', ')}`,
      fixFor(
        'run `pnpm dev:setup` (it offers a corrected value), or use scheme + host + port only, comma-separated',
        saveEnvOnHostFix,
      ),
    );
  } else if (frontendOrigins.includes(FRONTEND_DEV_ORIGIN)) {
    report('ok', `FRONTEND_URL allows ${FRONTEND_DEV_ORIGIN}`);
  } else {
    report(
      'warn',
      `FRONTEND_URL does not include ${FRONTEND_DEV_ORIGIN}, so the local frontend hits CORS errors`,
      `add ${FRONTEND_DEV_ORIGIN} to FRONTEND_URL (comma-separated, no trailing slash)`,
    );
  }

  const hasResend = Boolean(effectiveValue(fileValues, 'RESEND_API_KEY'));
  if (effectiveValue(fileValues, 'EMAIL_CODE_DEV_LOG') === 'true') {
    report('ok', 'EMAIL_CODE_DEV_LOG=true: sign-in codes print in the API log');
  } else if (hasResend) {
    report('ok', 'email sign-in codes go out through Resend');
  } else {
    report(
      'warn',
      'EMAIL_CODE_DEV_LOG is off: no way to sign in locally without Google OAuth keys',
      fixFor(
        'run `pnpm dev:setup` (it offers to add EMAIL_CODE_DEV_LOG=true), then restart the API',
        saveEnvOnHostFix,
      ),
    );
  }

  const googleClientId = effectiveValue(fileValues, 'GOOGLE_CLIENT_ID') ?? '';
  const googleClientSecret =
    effectiveValue(fileValues, 'GOOGLE_CLIENT_SECRET') ?? '';
  if (
    GOOGLE_PLACEHOLDERS.has(googleClientId) ||
    GOOGLE_PLACEHOLDERS.has(googleClientSecret) ||
    !googleClientId
  ) {
    report(
      'info',
      'Google OAuth keys are placeholders: Google sign-in is off locally, use email codes',
    );
  } else {
    report('ok', 'Google OAuth keys set');
  }

  if (existsSync(ENV_TEST_PATH)) {
    report('ok', '.env.test present');
  } else {
    report(
      'warn',
      '.env.test is missing, so `pnpm test:e2e` has no throwaway database',
      fixFor(
        'run `pnpm dev:setup`, or copy .env.test.example to .env.test',
        restartApiFix,
      ),
    );
  }

  // Database ------------------------------------------------------------------
  section('Database');
  const databaseUrl = effectiveValue(fileValues, 'DATABASE_URL');
  const pg = await loadPg();
  if (!databaseUrl) {
    report(
      'fail',
      'DATABASE_URL is not set',
      fixFor(
        'run `pnpm dev:setup`, or set DATABASE_URL in .env',
        saveEnvOnHostFix,
      ),
    );
  } else if (!pg) {
    report(
      'fail',
      'the `pg` package is not installed, so the database cannot be checked',
      fixFor('run `pnpm install`', restartApiFix),
    );
  } else {
    let target = null;
    const databaseUrlProblem = describeDatabaseUrlProblem(databaseUrl);
    if (databaseUrlProblem) {
      report(
        'fail',
        `DATABASE_URL is malformed: ${databaseUrlProblem}`,
        fixFor(
          'run `pnpm dev:setup` (it offers a working value), or use postgres://user:password@host:port/database',
          saveEnvOnHostFix,
        ),
      );
    } else {
      target = describeDatabaseUrl(databaseUrl);
    }
    if (target) {
      if (
        process.env.DATABASE_URL !== undefined &&
        process.env.DATABASE_URL !== fileValues.DATABASE_URL
      ) {
        report(
          'info',
          isContainer
            ? 'DATABASE_URL comes from the compose environment and overrides .env'
            : 'DATABASE_URL comes from your shell and overrides .env',
        );
      }
      await checkDatabase({ pg, databaseUrl, target, fileValues, report });
    }
  }

  // Services ------------------------------------------------------------------
  section('Services');
  await checkStorage({ fileValues, report });

  const apiPort = effectiveValue(fileValues, 'PORT') || '3000';
  const healthUrl = `http://localhost:${apiPort}/health/live`;
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.ok) {
      report('ok', `API answers at ${healthUrl}`);
    } else {
      report(
        'warn',
        `API at ${healthUrl} answered HTTP ${response.status}`,
        fixFor(
          'read the `pnpm start:dev` log',
          'read `docker compose logs -f api`',
        ),
      );
    }
  } catch (error) {
    const isTimeout =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    report(
      'info',
      isTimeout
        ? `API on port ${apiPort} did not answer within ${API_TIMEOUT_MS / 1000}s`
        : isContainer
          ? `API is not answering on port ${apiPort} yet (setup runs first; \`docker compose logs -f api\` shows progress)`
          : `API is not running on port ${apiPort} (start it with \`pnpm start:dev\` or \`docker compose up\` when you need it)`,
    );
  }

  const summaryParts = [
    failureCount > 0
      ? painter.red(`${failureCount} failing`)
      : painter.green('0 failing'),
    warningCount > 0
      ? painter.yellow(`${warningCount} warning(s)`)
      : '0 warnings',
  ];
  console.log(`\n${summaryParts.join(', ')}`);
  return failureCount === 0 ? 0 : 1;
}

async function checkDatabase({ pg, databaseUrl, target, fileValues, report }) {
  const address = `${target.host}:${target.port}`;
  const testName = testDatabaseName(target.database);
  let client = null;
  try {
    client = await connectPostgres(pg, databaseUrl, fileValues);
    report('ok', `database "${target.database}" reachable on ${address}`);
  } catch (error) {
    const explanation = explainPostgresError(error, target);
    report(
      'fail',
      `database check failed: ${explanation.reason}`,
      explanation.fix,
    );
    if (error?.code === '3D000') {
      await checkTestDatabaseThroughMaintenance({
        pg,
        databaseUrl,
        target,
        testName,
        fileValues,
        report,
      });
    }
    return;
  }

  try {
    const migrationState = await findPendingMigrations(client);
    if (migrationState.pendingNames.length === 0) {
      report('ok', `all ${migrationState.carriedCount} migrations applied`);
    } else {
      const preview = migrationState.pendingNames.slice(0, 3).join(', ');
      const remainder =
        migrationState.pendingNames.length > 3
          ? ` and ${migrationState.pendingNames.length - 3} more`
          : '';
      report(
        'warn',
        `${migrationState.pendingNames.length} pending migration(s): ${preview}${remainder}`,
        containerAwareFix(
          'run `pnpm run migration:run` (the API also applies them at boot)',
          restartApiFixText,
        ),
      );
    }
    if (migrationState.unknownAppliedNames.length > 0) {
      report(
        'info',
        `${migrationState.unknownAppliedNames.length} applied migration(s) this checkout does not carry (applied from another branch?)`,
      );
    }

    if (await tableExists(client, 'users')) {
      const adminRow = await client.query(
        'SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1',
        [DEV_ADMIN_EMAIL],
      );
      if (adminRow.rowCount > 0) {
        report('ok', `seeded dev admin ${DEV_ADMIN_EMAIL} exists`);
      } else {
        const userCount = await client.query(
          'SELECT count(*)::int AS total FROM users',
        );
        report(
          'warn',
          `no ${DEV_ADMIN_EMAIL} account (${userCount.rows[0].total} users in the database)`,
          containerAwareFix(
            'run `pnpm run seed` (idempotent: it skips rows that already exist)',
            `${restartApiFixText}, or \`docker compose exec api pnpm run seed\``,
          ),
        );
      }
    } else {
      report(
        'warn',
        'the users table does not exist yet',
        containerAwareFix(
          'run `pnpm run migration:run`, then `pnpm run seed`',
          restartApiFixText,
        ),
      );
    }

    if (await databaseExists(client, testName)) {
      report('ok', `test database "${testName}" exists`);
    } else {
      report(
        'warn',
        `test database "${testName}" does not exist, so \`pnpm test:e2e\` cannot run`,
        containerAwareFix('run `pnpm dev:setup`', restartApiFixText),
      );
    }
  } catch (error) {
    const explanation = explainPostgresError(error, target);
    report(
      'fail',
      `database query failed: ${explanation.reason}`,
      explanation.fix,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkTestDatabaseThroughMaintenance({
  pg,
  databaseUrl,
  target,
  testName,
  fileValues,
  report,
}) {
  let client = null;
  try {
    client = await connectPostgres(
      pg,
      withDatabaseName(databaseUrl, 'postgres'),
      fileValues,
    );
    if (await databaseExists(client, testName)) {
      report('ok', `test database "${testName}" exists`);
    } else {
      report(
        'warn',
        `test database "${testName}" does not exist`,
        containerAwareFix('run `pnpm dev:setup`', restartApiFixText),
      );
    }
  } catch (error) {
    const explanation = explainPostgresError(error, {
      ...target,
      database: 'postgres',
    });
    report(
      'warn',
      `test database not checked: ${explanation.reason}`,
      explanation.fix,
    );
  } finally {
    await client?.end().catch(() => {});
  }
}

async function checkStorage({ fileValues, report }) {
  const setKeys = STORAGE_KEYS.filter((key) => effectiveValue(fileValues, key));
  if (setKeys.length === 0) {
    report(
      'warn',
      'object storage is not configured: uploads off (avatars, photos, audio)',
      containerAwareFix(
        'run `pnpm dev:setup` with Docker running (it offers the local MinIO block)',
        'check the AWS_* entries of the api service in docker-compose.yml',
      ),
    );
    return;
  }
  if (setKeys.length < STORAGE_KEYS.length) {
    const missingKeys = STORAGE_KEYS.filter((key) => !setKeys.includes(key));
    report(
      'warn',
      `object storage half configured, ${missingKeys.join(', ')} unset: uploads off`,
      'set all five AWS_* keys or comment all five out',
    );
    return;
  }
  if (isPlaceholderStorage(fileValues)) {
    report(
      'warn',
      'AWS_* keys still hold the .env.example placeholders: uploads off',
      containerAwareFix(
        'run `pnpm dev:setup` with Docker running (it offers to replace them with the local MinIO block)',
        'check the AWS_* entries of the api service in docker-compose.yml',
      ),
    );
    return;
  }
  const endpointUrl = effectiveValue(fileValues, 'AWS_ENDPOINT_URL');
  const bucketName = effectiveValue(fileValues, 'AWS_S3_BUCKET_NAME');
  if (
    isLocalEndpoint(endpointUrl) &&
    effectiveValue(fileValues, 'AWS_S3_FORCE_PATH_STYLE') !== 'true'
  ) {
    report(
      'warn',
      `storage points at local ${endpointUrl} without AWS_S3_FORCE_PATH_STYLE=true, which MinIO needs`,
      'add AWS_S3_FORCE_PATH_STYLE=true to .env',
    );
  }
  const s3Module = await loadS3();
  if (!s3Module) {
    report(
      'fail',
      'the `@aws-sdk/client-s3` package is not installed',
      containerAwareFix('run `pnpm install`', restartApiFixText),
    );
    return;
  }
  const client = createStorageClient(s3Module, fileValues);
  try {
    const probe = await probeBucket(s3Module, client, bucketName, endpointUrl);
    if (probe.exists) {
      report(
        'ok',
        `storage bucket "${bucketName}" reachable at ${endpointUrl}`,
      );
    } else {
      const fix = probe.isReachable
        ? containerAwareFix(
            'run `pnpm dev:setup` (it creates the local bucket) or fix the AWS_* keys',
            `${restartApiFixText} (it creates the local bucket)`,
          )
        : isLocalEndpoint(endpointUrl) || isInsideContainer()
          ? 'start MinIO with `docker compose up -d --wait minio`'
          : 'check AWS_ENDPOINT_URL in .env';
      report('warn', `storage unusable, uploads off: ${probe.reason}`, fix);
    }
  } finally {
    client.destroy();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  runDoctor()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(`dev-doctor crashed: ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
