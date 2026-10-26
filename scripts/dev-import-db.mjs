// Copies an existing Postgres database (Postgres.app, Homebrew, any server
// this machine reaches) into the docker compose `postgres` service, once:
//
//   pnpm dev:import-db                    # source: DATABASE_URL from .env
//   pnpm dev:import-db --from postgres://user:password@localhost:5432/queerpulse
//   pnpm dev:import-db --dry-run          # plan only, nothing changes
//
// The dump runs in a throwaway `postgres:<source major>` container, so no
// local pg_dump is needed, and lands in .local/db-dumps/. The restore feeds it
// to psql inside the compose postgres container, in one transaction. The
// source database is only read.
//
// Node built-ins at the top level; `pg` is imported lazily through
// dev-doctor.mjs.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  ENV_PATH,
  PROJECT_ROOT,
  connectPostgres,
  createPainter,
  createPrompter,
  describeDatabaseUrl,
  describeDatabaseUrlProblem,
  detectDocker,
  effectiveValue,
  explainPostgresError,
  formatTimestamp,
  isInsideContainer,
  isInteractiveTerminal,
  isPortListening,
  loadPg,
  parseEnvText,
  readComposeServices,
  runQuietly,
  writeEnvFileEdits,
} from './dev-doctor.mjs';

const COMPOSE_SERVICE = 'postgres';
const TARGET_DATABASE = 'queerpulse';
const TARGET_USER = 'queerpulse';
const DEFAULT_POSTGRES_PORT = 5432;
const DUMP_DIRECTORY = join(PROJECT_ROOT, '.local', 'db-dumps');
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PSQL_TIMEOUT_MS = 30_000;

const HELP_TEXT = `Usage: pnpm dev:import-db [options]
       node scripts/dev-import-db.mjs [options]

Copies an existing Postgres database into the docker compose \`postgres\`
service, so \`docker compose up\` starts with your data. Needs Docker; no local
pg_dump or psql.

  1. reads the source (version, size, tables)
  2. starts the compose postgres; when the source already holds its host port,
     offers to move the container to a free one (QP_POSTGRES_PORT in .env)
  3. dumps the source with pg_dump in a postgres:<source major> container to
     .local/db-dumps/<db>-<YYYYMMDD-HHMMSS>.sql
  4. restores it into "${TARGET_DATABASE}" with psql inside the container, in one
     transaction, dropping the few lines PostgreSQL 16 rejects
  5. counts tables and users, then prints the next steps

Options:
  --from <url>    source database URL (default: DATABASE_URL from .env)
  --replace       drop and recreate "${TARGET_DATABASE}" in the container when it already
                  has tables (asks first on a terminal; without one, add --yes)
  --yes           accept the prompts (port move, --replace) without asking
  --dry-run       print the plan; connects read-only, runs no container and
                  writes nothing
  -h, --help      show this help`;

// ---------------------------------------------------------------------------
// Output

const painter = createPainter();
const statusLabels = {
  ok: painter.green('ok  '),
  plan: painter.cyan('plan'),
  skip: painter.dim('skip'),
  warn: painter.yellow('warn'),
  fail: painter.red('fail'),
  info: painter.cyan('info'),
};
const TOTAL_STEPS = 6;
let currentStepNumber = 0;

function printStep(title) {
  currentStepNumber += 1;
  console.log(
    `\n${painter.bold(`[${currentStepNumber}/${TOTAL_STEPS}] ${title}`)}`,
  );
}

function printStatus(status, message) {
  console.log(`  ${statusLabels[status]}  ${message}`);
}

function printIndented(lines) {
  for (const line of lines) console.log(`        ${line}`);
}

class ImportError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

function formatBytes(byteCount) {
  if (byteCount >= 1024 ** 3) return `${(byteCount / 1024 ** 3).toFixed(1)} GB`;
  if (byteCount >= 1024 ** 2) return `${(byteCount / 1024 ** 2).toFixed(1)} MB`;
  if (byteCount >= 1024) return `${(byteCount / 1024).toFixed(1)} KB`;
  return `${byteCount} B`;
}

// The URL with its password removed, safe to print.
function redactUrl(databaseUrl) {
  const parsedUrl = new URL(databaseUrl);
  if (parsedUrl.password) parsedUrl.password = '';
  return parsedUrl.toString();
}

function displayPath(path) {
  return relative(process.cwd(), path) || path;
}

// ---------------------------------------------------------------------------
// The dump filter (pure, exported for tests)

// pg_dump 17.6+ and 18 open a plain dump with `\restrict <key>` and close it
// with `\unrestrict <key>`; psql builds from before that security release do
// not know these meta-commands.
const RESTRICT_LINE_PATTERN = /^\\(?:un)?restrict\s+\S+\s*$/;
// PostgreSQL 17 added transaction_timeout; a 16 server rejects the SET.
const TRANSACTION_TIMEOUT_PATTERN = /^SET\s+transaction_timeout\s*=/i;
const COPY_START_PATTERN = /^COPY\s.+\sFROM\s+stdin;\s*$/i;

// Returns a per-line function for a plain-format dump. A line the target
// rejects becomes a SQL comment, so the line count (and every line number psql
// reports) stays the same as in the original dump. Rows inside COPY ... FROM
// stdin blocks are never touched.
export function createDumpLineFilter({ targetMajor, isRestrictSupported }) {
  let isInsideCopyData = false;
  return (line) => {
    if (isInsideCopyData) {
      if (line === '\\.') isInsideCopyData = false;
      return { line, strippedReason: null };
    }
    if (COPY_START_PATTERN.test(line)) {
      isInsideCopyData = true;
      return { line, strippedReason: null };
    }
    if (!isRestrictSupported && RESTRICT_LINE_PATTERN.test(line)) {
      return {
        line: '-- dev:import-db removed a psql restrict meta-command this psql does not know',
        strippedReason: 'psql restrict meta-command (pg_dump 17.6+ / 18)',
      };
    }
    if (targetMajor < 17 && TRANSACTION_TIMEOUT_PATTERN.test(line)) {
      return {
        line: `-- dev:import-db removed (PostgreSQL ${targetMajor} has no such setting): ${line}`,
        strippedReason: 'SET transaction_timeout (PostgreSQL 17+)',
      };
    }
    return { line, strippedReason: null };
  };
}

// The statement that ends on `lineNumber` (1-based): walks back to the line
// after the previous statement end, a blank line or a comment.
export function extractStatementAt(lines, lineNumber, maximumLines = 12) {
  const endIndex = Math.min(lineNumber, lines.length) - 1;
  if (endIndex < 0) return [];
  let startIndex = endIndex;
  while (startIndex > 0 && endIndex - startIndex < maximumLines - 1) {
    const previousLine = lines[startIndex - 1];
    if (
      previousLine.trim() === '' ||
      previousLine.trimEnd().endsWith(';') ||
      previousLine.startsWith('--')
    ) {
      break;
    }
    startIndex -= 1;
  }
  return lines.slice(startIndex, endIndex + 1);
}

// The first `psql:<stdin>:N: ERROR: ...` line of a psql error stream.
export function parsePsqlError(errorText) {
  const match = /psql:[^:\n]*:(\d+):\s*ERROR:\s*(.*)/.exec(errorText);
  if (!match) return null;
  return { lineNumber: Number(match[1]), message: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Docker helpers

function runPsql(database, sql) {
  const result = runQuietly(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      COMPOSE_SERVICE,
      'psql',
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      TARGET_USER,
      '-d',
      database,
      '-c',
      sql,
    ],
    PSQL_TIMEOUT_MS,
  );
  if (!result.isSuccess) {
    throw new ImportError(
      `psql in the compose postgres failed on \`${sql}\`: ${result.errorOutput.split('\n')[0] || (result.hasTimedOut ? `no answer within ${PSQL_TIMEOUT_MS / 1000}s` : 'it printed nothing')}`,
      'check `docker compose logs postgres`',
    );
  }
  return result.output;
}

// True when the target's psql accepts \restrict / \unrestrict.
function probeRestrictSupport() {
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      COMPOSE_SERVICE,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      TARGET_USER,
      '-d',
      'postgres',
    ],
    {
      cwd: PROJECT_ROOT,
      input: '\\restrict devimportprobe\n\\unrestrict devimportprobe\n',
      encoding: 'utf8',
      timeout: PSQL_TIMEOUT_MS,
    },
  );
  return !result.error && result.status === 0;
}

function readPublishedPort() {
  const result = runQuietly(
    'docker',
    ['compose', 'port', COMPOSE_SERVICE, '5432'],
    5_000,
  );
  if (!result.isSuccess) return null;
  const match = /:(\d+)\s*$/.exec(result.output.split('\n')[0] ?? '');
  return match ? Number(match[1]) : null;
}

function runDockerVisibly(args, extraEnvironment = {}) {
  console.log(painter.dim(`        $ docker ${args.join(' ')}`));
  const result = spawnSync('docker', args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.status !== 0) {
    throw new ImportError(
      `\`docker ${args.join(' ')}\` ${result.signal ? `was killed by ${result.signal}` : `exited with code ${result.status}`}`,
      'read its output above',
    );
  }
}

// ---------------------------------------------------------------------------
// Steps

async function readSource(options, envValues) {
  printStep('Source database');
  const sourceUrl =
    options.fromUrl ?? effectiveValue(envValues, 'DATABASE_URL');
  if (!sourceUrl) {
    throw new ImportError(
      'no source database: .env has no DATABASE_URL and --from was not given',
      'pass --from postgres://user:password@localhost:5432/queerpulse',
    );
  }
  const urlProblem = describeDatabaseUrlProblem(sourceUrl);
  if (urlProblem) {
    throw new ImportError(
      `the source URL is malformed: ${urlProblem}`,
      'pass --from postgres://user:password@host:port/database',
    );
  }
  const target = describeDatabaseUrl(sourceUrl);
  const pg = await loadPg();
  if (!pg) {
    throw new ImportError(
      'the `pg` package is not installed, so the source cannot be read',
      'run `pnpm install`, then re-run',
    );
  }
  let client;
  try {
    client = await connectPostgres(pg, sourceUrl, envValues);
  } catch (error) {
    const explanation = explainPostgresError(error, target);
    throw new ImportError(
      `cannot read the source: ${explanation.reason}`,
      explanation.fix,
    );
  }
  try {
    const overview = (
      await client.query(
        `SELECT current_setting('server_version_num')::int AS version_number,
                current_setting('server_version') AS version_text,
                current_database() AS database_name,
                pg_database_size(current_database())::bigint AS size_bytes,
                extract(epoch FROM pg_postmaster_start_time())::text AS started_at`,
      )
    ).rows[0];
    const tableCount = (
      await client.query(
        `SELECT count(*)::int AS total FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_type = 'BASE TABLE'`,
      )
    ).rows[0].total;
    const hasUsersTable =
      (await client.query("SELECT to_regclass('public.users') AS relation"))
        .rows[0].relation !== null;
    const userCount = hasUsersTable
      ? (await client.query('SELECT count(*)::int AS total FROM users')).rows[0]
          .total
      : null;
    const extensionNames = (
      await client.query('SELECT extname FROM pg_extension ORDER BY extname')
    ).rows.map((row) => row.extname);
    const source = {
      url: sourceUrl,
      host: target.host,
      port: target.port,
      databaseName: overview.database_name,
      versionText: overview.version_text,
      major: Math.floor(overview.version_number / 10_000),
      sizeBytes: Number(overview.size_bytes),
      startedAt: overview.started_at,
      tableCount,
      userCount,
      extensionNames,
    };
    printStatus(
      'ok',
      `"${source.databaseName}" on ${source.host}:${source.port}: PostgreSQL ${source.versionText}, ${formatBytes(source.sizeBytes)}, ${tableCount} tables${userCount === null ? '' : `, ${userCount} users`}`,
    );
    printIndented([`extensions: ${extensionNames.join(', ') || 'none'}`]);
    return source;
  } finally {
    await client.end().catch(() => {});
  }
}

function checkDocker(options) {
  printStep('Docker');
  const docker = detectDocker();
  if (!docker.isDaemonRunning) {
    if (options.isDryRun) {
      printStatus(
        'warn',
        `Docker unavailable: ${docker.reason}; a real run stops here`,
      );
      printIndented([
        'fix: install and start Docker Desktop, OrbStack or colima',
      ]);
      return { isAvailable: false };
    }
    throw new ImportError(
      `Docker unavailable: ${docker.reason}`,
      'install and start Docker Desktop, OrbStack or colima, then re-run',
    );
  }
  printStatus('ok', `Docker running (compose ${docker.composeVersion})`);
  const definedServices = runQuietly('docker', [
    'compose',
    'config',
    '--services',
  ]).output.split('\n');
  if (!definedServices.includes(COMPOSE_SERVICE)) {
    throw new ImportError(
      `docker-compose.yml defines no \`${COMPOSE_SERVICE}\` service`,
      'run this from the queerpulse-backend checkout',
    );
  }
  return { isAvailable: true };
}

// Asks (or, with --yes, accepts) moving the compose postgres to a free host
// port, written to .env as QP_POSTGRES_PORT. Returns the port to publish.
async function resolvePortConflict({
  options,
  envValues,
  desiredPort,
  source,
}) {
  let freePort = null;
  for (
    let candidate = desiredPort + 1;
    candidate <= desiredPort + 10;
    candidate += 1
  ) {
    if (!(await isPortListening(candidate))) {
      freePort = candidate;
      break;
    }
  }
  const holder =
    LOOPBACK_HOSTS.has(source.host) && source.port === desiredPort
      ? 'the source server'
      : 'another program';
  printStatus(
    'warn',
    `localhost:${desiredPort} is taken by ${holder}, so the compose postgres cannot publish it`,
  );
  if (freePort === null) {
    throw new ImportError(
      `ports ${desiredPort + 1} to ${desiredPort + 10} are taken too`,
      'free a port, then put QP_POSTGRES_PORT=<port> in .env and re-run',
    );
  }
  if (!existsSync(ENV_PATH)) {
    throw new ImportError(
      'there is no .env to keep the moved port in',
      `run \`QP_POSTGRES_PORT=${freePort} pnpm dev:setup\` first (it writes .env), or export QP_POSTGRES_PORT=${freePort} in your shell, then re-run`,
    );
  }
  const fileDatabaseUrl = envValues.DATABASE_URL;
  let databaseUrlProposal = null;
  if (fileDatabaseUrl && !describeDatabaseUrlProblem(fileDatabaseUrl)) {
    const fileTarget = describeDatabaseUrl(fileDatabaseUrl);
    if (
      LOOPBACK_HOSTS.has(fileTarget.host) &&
      fileTarget.port === desiredPort
    ) {
      const movedUrl = new URL(fileDatabaseUrl);
      movedUrl.port = String(freePort);
      databaseUrlProposal = movedUrl.toString();
    }
  }
  const portEdit = { key: 'QP_POSTGRES_PORT', value: String(freePort) };
  const databaseUrlNote = `native runs (\`pnpm start:dev\` on your machine) read DATABASE_URL, which still points at port ${desiredPort}; inside \`docker compose up\` the api reaches postgres:5432 whatever the host port`;

  if (options.isDryRun) {
    printStatus(
      'plan',
      `would offer to write QP_POSTGRES_PORT=${freePort} into .env (after a backup), so compose publishes port ${freePort}`,
    );
    if (databaseUrlProposal) {
      printIndented([
        databaseUrlNote,
        `and would offer to point DATABASE_URL in .env at port ${freePort} too`,
      ]);
    }
    return freePort;
  }

  const edits = [];
  if (options.shouldAssumeYes) {
    edits.push(portEdit);
    printStatus(
      'info',
      `--yes: moving the compose postgres to port ${freePort}`,
    );
    if (databaseUrlProposal) {
      printIndented([
        databaseUrlNote,
        `DATABASE_URL is left alone; point it at port ${freePort} yourself when native runs should use the container`,
      ]);
    }
  } else if (isInteractiveTerminal()) {
    const prompter = createPrompter();
    try {
      const shouldMovePort = await prompter.confirm(
        `  Write QP_POSTGRES_PORT=${freePort} into .env (backed up first) so the container publishes port ${freePort}?`,
      );
      if (shouldMovePort === null) {
        throw new ImportError(
          'the port question was cancelled; nothing was written',
          're-run when ready',
        );
      }
      if (!shouldMovePort) {
        throw new ImportError(
          `the compose postgres needs a free host port and ${desiredPort} is taken`,
          `quit the server on port ${desiredPort}, or accept QP_POSTGRES_PORT=${freePort}`,
        );
      }
      edits.push(portEdit);
      if (databaseUrlProposal) {
        console.log(`  ${databaseUrlNote}.`);
        const shouldMoveDatabaseUrl = await prompter.confirm(
          `  Point DATABASE_URL in .env at port ${freePort} too, so native runs use the container?`,
        );
        if (shouldMoveDatabaseUrl === null) {
          throw new ImportError(
            'the DATABASE_URL question was cancelled; nothing was written',
            're-run when ready',
          );
        }
        if (shouldMoveDatabaseUrl) {
          edits.push({ key: 'DATABASE_URL', value: databaseUrlProposal });
        }
      }
    } finally {
      prompter.close();
    }
  } else {
    throw new ImportError(
      `localhost:${desiredPort} is taken and there is no terminal to ask about moving the container`,
      `re-run on a terminal, pass --yes, or add QP_POSTGRES_PORT=${freePort} to .env yourself`,
    );
  }
  const result = writeEnvFileEdits(ENV_PATH, edits, 'pnpm dev:import-db');
  printStatus('ok', `backed up .env to ${basename(result.backupPath)}`);
  printStatus(
    'ok',
    `updated .env: ${[...result.replacedKeys.map((key) => `replaced ${key}`), ...result.appendedKeys.map((key) => `added ${key}`)].join(', ')}`,
  );
  return freePort;
}

async function prepareTarget({
  options,
  envValues,
  source,
  isDockerAvailable,
}) {
  printStep('Target (compose postgres)');
  const targetState = {
    port: null,
    major: 16,
    tableCount: 0,
    hasDatabase: false,
    isRestrictSupported: false,
  };
  if (!isDockerAvailable) {
    printStatus(
      'plan',
      `would start the compose postgres (\`docker compose up -d --wait ${COMPOSE_SERVICE}\`) and restore into "${TARGET_DATABASE}"`,
    );
    const desiredPort = Number(
      effectiveValue(envValues, 'QP_POSTGRES_PORT') || DEFAULT_POSTGRES_PORT,
    );
    if (await isPortListening(desiredPort)) {
      await resolvePortConflict({ options, envValues, desiredPort, source });
    }
    return targetState;
  }

  const composeState = readComposeServices();
  const runningServices = composeState.isKnown
    ? composeState.services
        .filter((container) => container.state === 'running')
        .map((container) => container.service)
    : [];
  if (runningServices.includes('api')) {
    throw new ImportError(
      'the compose api service is running, and its start-up migrations would race the restore',
      'run `docker compose stop api`, re-run this, then `docker compose up`',
    );
  }

  let publishPort = null;
  if (runningServices.includes(COMPOSE_SERVICE)) {
    targetState.port = readPublishedPort();
    printStatus(
      'ok',
      `compose postgres is running${targetState.port ? ` on localhost:${targetState.port}` : ''}`,
    );
  } else {
    const desiredPort = Number(
      effectiveValue(envValues, 'QP_POSTGRES_PORT') || DEFAULT_POSTGRES_PORT,
    );
    publishPort = (await isPortListening(desiredPort))
      ? await resolvePortConflict({ options, envValues, desiredPort, source })
      : desiredPort;
    if (options.isDryRun) {
      printStatus(
        'plan',
        `would run \`docker compose up -d --wait ${COMPOSE_SERVICE}\` (host port ${publishPort})`,
      );
      return targetState;
    }
    runDockerVisibly(['compose', 'up', '-d', '--wait', COMPOSE_SERVICE], {
      QP_POSTGRES_PORT: String(publishPort),
    });
    targetState.port = readPublishedPort() ?? publishPort;
    printStatus(
      'ok',
      `compose postgres is up on localhost:${targetState.port}`,
    );
  }

  // The source must not be the container itself. A matching port alone can
  // mislead on macOS, where a server bound to 127.0.0.1 shadows a container
  // published on 0.0.0.0, so a match is confirmed by start time and version.
  const isSourceLocal =
    LOOPBACK_HOSTS.has(source.host) || source.host === 'host.docker.internal';
  if (isSourceLocal && targetState.port === source.port) {
    const [startedAt, versionNumber] = runPsql(
      'postgres',
      "SELECT extract(epoch FROM pg_postmaster_start_time())::text || '|' || current_setting('server_version_num')",
    ).split('|');
    if (
      startedAt === source.startedAt &&
      Math.floor(Number(versionNumber) / 10_000) === source.major
    ) {
      throw new ImportError(
        `the source ${source.host}:${source.port} IS the compose postgres, so there is nothing to import`,
        'pass --from with the server you are moving away from (for Postgres.app, its port in Postgres.app > Server Settings)',
      );
    }
    printStatus(
      'info',
      `localhost:${source.port} reaches a different server than the compose postgres, which also publishes ${source.port}`,
    );
  }

  targetState.major = Math.floor(
    Number(runPsql('postgres', 'SHOW server_version_num')) / 10_000,
  );
  targetState.hasDatabase =
    runPsql(
      'postgres',
      `SELECT count(*) FROM pg_database WHERE datname = '${TARGET_DATABASE}'`,
    ) === '1';
  if (targetState.hasDatabase) {
    targetState.tableCount = Number(
      runPsql(
        TARGET_DATABASE,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'",
      ),
    );
  }
  targetState.isRestrictSupported = probeRestrictSupport();
  printStatus(
    'ok',
    `target "${TARGET_DATABASE}" on PostgreSQL ${targetState.major}: ${targetState.hasDatabase ? `${targetState.tableCount} tables` : 'does not exist yet'}; its psql ${targetState.isRestrictSupported ? 'knows' : 'lacks'} \\restrict`,
  );

  if (targetState.tableCount > 0) {
    if (!options.shouldReplace && options.isDryRun) {
      printStatus(
        'warn',
        `the compose database "${TARGET_DATABASE}" already has ${targetState.tableCount} tables, so a real run without --replace stops here`,
      );
      return targetState;
    }
    if (!options.shouldReplace) {
      throw new ImportError(
        `the compose database "${TARGET_DATABASE}" already has ${targetState.tableCount} tables`,
        'pass --replace to drop and recreate it with the import (nothing is dropped before the dump succeeds)',
      );
    }
    if (!options.isDryRun && !options.shouldAssumeYes) {
      if (!isInteractiveTerminal()) {
        throw new ImportError(
          `--replace would drop "${TARGET_DATABASE}" (${targetState.tableCount} tables) and there is no terminal to confirm it`,
          'add --yes to confirm without a terminal',
        );
      }
      const prompter = createPrompter();
      try {
        const isConfirmed = await prompter.confirm(
          `  Drop "${TARGET_DATABASE}" in the compose postgres (${targetState.tableCount} tables) and replace it with the import?`,
          false,
        );
        if (!isConfirmed) {
          throw new ImportError(
            `kept "${TARGET_DATABASE}" as it is; nothing was dumped or dropped`,
            're-run with --replace and answer y to replace it',
          );
        }
      } finally {
        prompter.close();
      }
    }
    printStatus(
      options.isDryRun ? 'plan' : 'info',
      `${options.isDryRun ? 'would drop' : 'will drop'} and recreate "${TARGET_DATABASE}" after the dump succeeds (--replace)`,
    );
  }
  return targetState;
}

function dumpSource({ options, source, isDockerAvailable }) {
  printStep('Dump');
  const dockerUrl = new URL(source.url);
  if (LOOPBACK_HOSTS.has(dockerUrl.hostname)) {
    dockerUrl.hostname = 'host.docker.internal';
  }
  const password = decodeURIComponent(dockerUrl.password);
  dockerUrl.password = '';
  const image = `postgres:${source.major}`;
  const dumpArguments = [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    ...(password ? ['-e', 'PGPASSWORD'] : []),
    image,
    'pg_dump',
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    // pg_dump 18 can also dump planner statistics, which a 16 server rejects.
    ...(source.major >= 18 ? ['--no-statistics'] : []),
    '--dbname',
    dockerUrl.toString(),
  ];
  const safeName = source.databaseName.replace(/[^\w.-]+/g, '_');
  const dumpPath = join(DUMP_DIRECTORY, `${safeName}-${formatTimestamp()}.sql`);
  // The password reaches the container through the environment, never argv.
  const printedCommand = `docker ${dumpArguments.join(' ')} > ${displayPath(dumpPath)}`;
  if (LOOPBACK_HOSTS.has(source.host)) {
    printStatus(
      'info',
      'the dump connects from a container through host.docker.internal; Postgres.app may ask once whether to allow Docker, so allow it',
    );
  }
  if (options.isDryRun || !isDockerAvailable) {
    printStatus('plan', 'would run (password passed as PGPASSWORD):');
    printIndented([printedCommand]);
    return { dumpPath: null };
  }
  mkdirSync(DUMP_DIRECTORY, { recursive: true });
  console.log(painter.dim(`        $ ${printedCommand}`));
  const fileDescriptor = openSync(dumpPath, 'w', 0o600);
  let result;
  try {
    result = spawnSync('docker', dumpArguments, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', fileDescriptor, 'inherit'],
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    });
  } finally {
    closeSync(fileDescriptor);
  }
  if (result.status !== 0) {
    unlinkSync(dumpPath);
    throw new ImportError(
      `pg_dump in ${image} ${result.signal ? `was killed by ${result.signal}` : `exited with code ${result.status}`} (its error is above; the partial dump was deleted)`,
      `if it could not connect, the source must accept connections from Docker at host.docker.internal:${source.port}: Postgres.app with Docker Desktop or OrbStack does; on Linux, listen on the docker0 address and allow it in pg_hba.conf`,
    );
  }
  printStatus(
    'ok',
    `dumped to ${displayPath(dumpPath)} (${formatBytes(statSync(dumpPath).size)})`,
  );
  return { dumpPath };
}

export async function writeRestoreFile(dumpPath, targetState) {
  const restorePath = dumpPath.replace(/\.sql$/, '.restore.sql');
  const filterLine = createDumpLineFilter({
    targetMajor: targetState.major,
    isRestrictSupported: targetState.isRestrictSupported,
  });
  const strippedCounts = new Map();
  const output = createWriteStream(restorePath, { mode: 0o600 });
  const lineReader = createInterface({
    input: createReadStream(dumpPath, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of lineReader) {
    const filtered = filterLine(line);
    if (filtered.strippedReason) {
      strippedCounts.set(
        filtered.strippedReason,
        (strippedCounts.get(filtered.strippedReason) ?? 0) + 1,
      );
    }
    if (!output.write(`${filtered.line}\n`)) {
      await new Promise((resolvePromise) =>
        output.once('drain', resolvePromise),
      );
    }
  }
  await new Promise((resolvePromise, rejectPromise) => {
    output.end((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
  return { restorePath, strippedCounts };
}

function runRestore(restorePath) {
  const restoreArguments = [
    'compose',
    'exec',
    '-T',
    COMPOSE_SERVICE,
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '--single-transaction',
    '-U',
    TARGET_USER,
    '-d',
    TARGET_DATABASE,
  ];
  console.log(
    painter.dim(
      `        $ docker ${restoreArguments.join(' ')} < ${displayPath(restorePath)}`,
    ),
  );
  return new Promise((resolvePromise) => {
    const input = openSync(restorePath, 'r');
    const child = spawn('docker', restoreArguments, {
      cwd: PROJECT_ROOT,
      stdio: [input, 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr.on('data', (chunk) => {
      errorText += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      closeSync(input);
      resolvePromise({
        exitCode: 1,
        errorText: `${errorText}${error.message}`,
      });
    });
    child.once('close', (exitCode) => {
      closeSync(input);
      resolvePromise({ exitCode: exitCode ?? 1, errorText });
    });
  });
}

async function restoreDump({ options, dumpPath, targetState, source }) {
  printStep('Restore');
  if (!dumpPath) {
    printStatus(
      'plan',
      `would rewrite the lines PostgreSQL ${targetState.major} rejects into comments (line numbers stay the same):`,
    );
    printIndented([
      source.major >= 17
        ? '`SET transaction_timeout = ...` (the source is PostgreSQL 17+)'
        : '`SET transaction_timeout = ...` if present (the source predates 17, so none expected)',
      '`\\restrict <key>` and `\\unrestrict <key>` if the target psql lacks them (checked against the container first)',
    ]);
    printStatus(
      'plan',
      `would ${options.shouldReplace ? 'drop and recreate' : 'create, if missing,'} "${TARGET_DATABASE}" through the maintenance database, then restore with \`docker compose exec -T ${COMPOSE_SERVICE} psql -v ON_ERROR_STOP=1 --single-transaction -U ${TARGET_USER} -d ${TARGET_DATABASE}\``,
    );
    return false;
  }
  const { restorePath, strippedCounts } = await writeRestoreFile(
    dumpPath,
    targetState,
  );
  if (strippedCounts.size === 0) {
    printStatus(
      'ok',
      `no line needed changing for PostgreSQL ${targetState.major}`,
    );
  } else {
    printStatus(
      'ok',
      `commented out ${[...strippedCounts].map(([reason, count]) => `${count} x ${reason}`).join(', ')} in ${displayPath(restorePath)}`,
    );
  }

  if (targetState.hasDatabase && targetState.tableCount > 0) {
    runPsql('postgres', `DROP DATABASE "${TARGET_DATABASE}" WITH (FORCE)`);
    printStatus('ok', `dropped "${TARGET_DATABASE}"`);
    targetState.hasDatabase = false;
  }
  if (!targetState.hasDatabase) {
    runPsql(
      'postgres',
      `CREATE DATABASE "${TARGET_DATABASE}" OWNER ${TARGET_USER}`,
    );
    printStatus('ok', `created an empty "${TARGET_DATABASE}"`);
  }

  const { exitCode, errorText } = await runRestore(restorePath);
  if (exitCode !== 0) {
    const psqlError = parsePsqlError(errorText);
    if (psqlError) {
      const statementLines = extractStatementAt(
        readFileSync(restorePath, 'utf8').split('\n'),
        psqlError.lineNumber,
      );
      printStatus(
        'fail',
        `the restore stopped at line ${psqlError.lineNumber} of ${displayPath(restorePath)} (same line in ${basename(dumpPath)}): ${psqlError.message}`,
      );
      printIndented([
        'statement:',
        ...statementLines.map((line) => `  ${line}`),
      ]);
    }
    throw new ImportError(
      psqlError
        ? `psql rejected the statement above, so the whole restore rolled back and "${TARGET_DATABASE}" is empty`
        : `psql exited with code ${exitCode} before naming a failing line (its output is above)`,
      `the dump stays at ${displayPath(dumpPath)}; fix the cause, then re-run \`pnpm dev:import-db\``,
    );
  }
  printStatus('ok', `restored into "${TARGET_DATABASE}"`);
  return true;
}

function verifyAndPrintNextSteps({ source, dumpPath, isRestored, options }) {
  printStep('Check and next steps');
  if (isRestored) {
    const tableCount = Number(
      runPsql(
        TARGET_DATABASE,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'",
      ),
    );
    const userCount = runPsql(
      TARGET_DATABASE,
      "SELECT CASE WHEN to_regclass('public.users') IS NULL THEN 'none' ELSE (SELECT count(*)::text FROM users) END",
    );
    const isMatch =
      tableCount === source.tableCount &&
      (source.userCount === null || String(source.userCount) === userCount);
    printStatus(
      isMatch ? 'ok' : 'warn',
      `the container now holds ${tableCount} tables and ${userCount === 'none' ? 'no users table' : `${userCount} users`} (source: ${source.tableCount} tables${source.userCount === null ? '' : `, ${source.userCount} users`})`,
    );
  } else {
    printStatus(
      'plan',
      'would count tables and users in the container and compare them with the source',
    );
  }
  console.log(
    `\n${painter.bold(options.isDryRun ? 'Next steps (after a real run)' : 'Next steps')}`,
  );
  const sourceName = LOOPBACK_HOSTS.has(source.host)
    ? `the server on localhost:${source.port} (Postgres.app?)`
    : `${source.host}:${source.port}`;
  for (const nextStep of [
    '`docker compose up` starts the API, Postgres and MinIO; on start the api runs any migrations newer than the import and seeds what is missing',
    `${sourceName} was only read: keep it running or quit it, the compose stack no longer needs it`,
    dumpPath
      ? `roll back: ${displayPath(dumpPath)} is a plain SQL copy of "${source.databaseName}"; \`psql -d <database> -f ${displayPath(dumpPath)}\` restores it into any empty database, and a .env.backup-* file holds any .env lines this changed`
      : 'roll back: the dump file in .local/db-dumps/ is a plain SQL copy of the source, restorable with `psql -f`',
  ]) {
    console.log(`  - ${nextStep}`);
  }
}

// ---------------------------------------------------------------------------

function parseArguments(argumentList) {
  const options = {
    fromUrl: null,
    shouldReplace: false,
    shouldAssumeYes: false,
    isDryRun: false,
    shouldShowHelp: false,
  };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--from') {
      const value = argumentList[index + 1];
      if (!value || value.startsWith('--')) {
        throw new ImportError(
          '--from needs a database URL after it',
          'pass --from postgres://user:password@host:port/database',
        );
      }
      options.fromUrl = value;
      index += 1;
    } else if (argument.startsWith('--from=')) {
      options.fromUrl = argument.slice('--from='.length);
    } else if (argument === '--replace') {
      options.shouldReplace = true;
    } else if (argument === '--yes') {
      options.shouldAssumeYes = true;
    } else if (argument === '--dry-run') {
      options.isDryRun = true;
    } else if (argument === '--help' || argument === '-h') {
      options.shouldShowHelp = true;
    } else {
      throw new ImportError(
        `unknown option ${argument}`,
        'run with --help for the options',
      );
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.shouldShowHelp) {
    console.log(HELP_TEXT);
    return 0;
  }
  console.log(
    painter.bold(
      `QueerPulse database import into docker compose${options.isDryRun ? ' (dry run: nothing will change)' : ''}`,
    ),
  );
  if (isInsideContainer()) {
    throw new ImportError(
      'this runs inside the compose api container, and the import needs Docker on your machine',
      'run `pnpm dev:import-db` in a terminal on your machine',
    );
  }
  const envValues = existsSync(ENV_PATH)
    ? parseEnvText(readFileSync(ENV_PATH, 'utf8'))
    : {};
  const source = await readSource(options, envValues);
  const { isAvailable: isDockerAvailable } = checkDocker(options);
  const targetState = await prepareTarget({
    options,
    envValues,
    source,
    isDockerAvailable,
  });
  const { dumpPath } = dumpSource({ options, source, isDockerAvailable });
  const isRestored = await restoreDump({
    options,
    dumpPath,
    targetState,
    source,
  });
  verifyAndPrintNextSteps({ source, dumpPath, isRestored, options });
  return 0;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntryPoint) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      if (error instanceof ImportError) {
        printStatus('fail', error.message);
        if (error.fix) printIndented([`fix: ${error.fix}`]);
      } else {
        console.error(`dev-import-db crashed: ${error?.stack ?? error}`);
      }
      process.exitCode = 1;
    });
}
