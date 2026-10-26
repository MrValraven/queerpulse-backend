// One-command local setup for the QueerPulse backend:
//
//   pnpm dev:setup              # or: node scripts/dev-setup.mjs
//   pnpm dev:setup --dry-run    # print every action, change nothing
//   node scripts/dev-setup.mjs --container   # the compose `api` service
//
// Idempotent: safe to re-run on a machine that already works. It only creates
// databases and buckets that are missing, runs migrations that are pending,
// and seeds only a database without users or without the dev admin.
//
// An existing .env changes only with consent: on a terminal, setup lists what
// is missing or invalid and asks about each item (after a timestamped backup);
// without a terminal it prints the lines to add, unless `--update-env --yes`.
// In --container mode it never writes an existing .env; values it lacks are
// generated in memory for that run.
//
// It imports Node built-ins only at the top level because it runs before
// `pnpm install`; `pg` and `@aws-sdk/client-s3` are loaded after the install
// step (through the helpers in dev-doctor.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOOT_REQUIRED_KEYS,
  DEV_ADMIN_EMAIL,
  ENV_EXAMPLE_PATH,
  ENV_PATH,
  ENV_TEST_EXAMPLE_PATH,
  ENV_TEST_PATH,
  FRONTEND_DEV_ORIGIN,
  LOCAL_MINIO_BUCKET,
  LOCAL_MINIO_PASSWORD,
  LOCAL_MINIO_USER,
  MINIMUM_JWT_SECRET_LENGTH,
  PROJECT_ROOT,
  STORAGE_KEYS,
  checkNodeVersion,
  checkPnpmVersion,
  connectPostgres,
  createPainter,
  createPrompter,
  createStorageClient,
  databaseExists,
  describeDatabaseUrl,
  describeDatabaseUrlProblem,
  detectDocker,
  effectiveValue,
  explainPostgresError,
  findInvalidFrontendOrigins,
  findPendingMigrations,
  formatEnvValue,
  isInsideContainer,
  isInteractiveTerminal,
  isLocalEndpoint,
  isPlaceholderStorage,
  isPortListening,
  listAssignedKeys,
  listCommentedKeys,
  listMigrationNames,
  loadPg,
  loadS3,
  parseEnvText,
  probeBucket,
  runQuietly,
  tableExists,
  testDatabaseName,
  withDatabaseName,
  writeEnvFileEdits,
} from './dev-doctor.mjs';

const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_MINIO_PORT = 9000;
const DEFAULT_MINIO_CONSOLE_PORT = 9001;
const CONTAINER_WAIT_SECONDS = 60;

const HELP_TEXT = `Usage: pnpm dev:setup [options]
       node scripts/dev-setup.mjs [options]

Sets up a local QueerPulse backend: checks Node and pnpm, installs
dependencies, starts Postgres and MinIO with docker compose (when Docker runs),
writes .env and .env.test when they are missing, creates the dev and _test
databases, runs migrations on both, seeds the dev database when it has no users
or no ${DEV_ADMIN_EMAIL}, creates the local bucket, then runs the doctor.

Safe to re-run. When an existing .env lacks keys or holds values the API
rejects, setup asks about each one on a terminal (Enter accepts, s skips, a
accepts all remaining, or type your own value) and backs .env up to
.env.backup-YYYYMMDD-HHMMSS before the first change. Without a terminal it
prints the lines to add instead.

Options:
  --dry-run       print every action it would take and change nothing
  --skip-docker   do not start or inspect docker compose services
  --skip-seed     never run the seed
  --update-env    review .env even when only optional keys are missing; with
                  --yes it accepts every proposal without asking (works without
                  a terminal too)
  --yes           with --update-env, accept every proposal
  --container     the compose \`api\` service mode: no Docker step, never
                  writes an existing .env (missing values live in memory for
                  that run), and ends by running \`pnpm start:dev\`
  -h, --help      show this help

Environment:
  QP_POSTGRES_PORT, QP_MINIO_PORT, QP_MINIO_CONSOLE_PORT
                  host ports for the compose services (default 5432, 9000, 9001)`;

// ---------------------------------------------------------------------------
// Arguments

const KNOWN_FLAGS = new Set([
  '--dry-run',
  '--skip-docker',
  '--skip-seed',
  '--update-env',
  '--yes',
  '--container',
  '--help',
  '-h',
]);
const argumentList = process.argv.slice(2);
const unknownFlags = argumentList.filter(
  (argument) => !KNOWN_FLAGS.has(argument),
);
if (unknownFlags.length > 0) {
  console.error(
    `Unknown option ${unknownFlags.join(', ')}. Run with --help for the options.`,
  );
  process.exit(2);
}
if (argumentList.includes('--help') || argumentList.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}
const isDryRun = argumentList.includes('--dry-run');
const shouldSkipDocker = argumentList.includes('--skip-docker');
const shouldSkipSeed = argumentList.includes('--skip-seed');
const shouldUpdateEnv = argumentList.includes('--update-env');
const shouldAcceptAll = argumentList.includes('--yes');
const isContainerMode = argumentList.includes('--container');

// Values this run needs that .env lacks or holds invalid, generated in memory
// by --container mode. Every child process (migrations, seed, the API) gets
// them on top of process.env; .env itself is never written.
const inMemoryEnvironment = {};

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

// Both modes run nine steps: --container skips Docker and ends by starting the
// API in place of the doctor.
const TOTAL_STEPS = 9;
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

class SetupError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

// The environment every child process gets: process.env wins over .env (the
// children load .env through dotenv, which never overwrites a set variable),
// and --container's in-memory values fill what both lack.
function childEnvironment(extraEnvironment = {}) {
  return {
    ...process.env,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ...inMemoryEnvironment,
    ...extraEnvironment,
  };
}

function runCommand(command, args, extraEnvironment = {}) {
  console.log(painter.dim(`        $ ${[command, ...args].join(' ')}`));
  return spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: childEnvironment(extraEnvironment),
  });
}

// Runs a command with inherited stdio. Fails with the exact command and exit
// code when it does not succeed.
function runVisibly(command, args, extraEnvironment = {}) {
  const commandLine = [command, ...args].join(' ');
  const result = runCommand(command, args, extraEnvironment);
  if (result.error?.code === 'ENOENT') {
    throw new SetupError(
      `\`${command}\` is not installed or not on PATH`,
      `install ${command}, then re-run`,
    );
  }
  if (result.status !== 0) {
    const reason = result.signal
      ? `was killed by ${result.signal}`
      : `exited with code ${result.status}`;
    throw new SetupError(
      `\`${commandLine}\` ${reason}`,
      'read its output above, fix the cause, then re-run `pnpm dev:setup`',
    );
  }
}

// ---------------------------------------------------------------------------
// Local secrets and .env editing

function padBuffer(buffer, length) {
  return buffer.length >= length
    ? buffer
    : Buffer.concat([Buffer.alloc(length - buffer.length), buffer]);
}

// Raw values. formatEnvValue() stores a PEM on one double-quoted line with
// `\n` escapes, which dotenv expands, so createPrivateKey() in
// card-token.service.ts gets real newlines.
function generateLocalSecrets() {
  const accessSecret = randomBytes(48).toString('base64');
  let refreshSecret = randomBytes(48).toString('base64');
  while (refreshSecret === accessSecret)
    refreshSecret = randomBytes(48).toString('base64');

  const cardKeyPair = generateKeyPairSync('ed25519');

  // web-push expects the P-256 public key as the 65-byte uncompressed point
  // and the private key as the raw 32-byte scalar, both base64url (the format
  // `npx web-push generate-vapid-keys` prints). Padding guards the rare key
  // whose leading byte is zero.
  const vapidCurve = createECDH('prime256v1');
  vapidCurve.generateKeys();

  return {
    JWT_ACCESS_SECRET: accessSecret,
    JWT_REFRESH_SECRET: refreshSecret,
    BAN_EVASION_PEPPER: randomBytes(32).toString('hex'),
    CARD_SIGNING_PRIVATE_KEY: cardKeyPair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .trim(),
    CARD_SIGNING_PUBLIC_KEY: cardKeyPair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .trim(),
    VAPID_PUBLIC_KEY: padBuffer(vapidCurve.getPublicKey(), 65).toString(
      'base64url',
    ),
    VAPID_PRIVATE_KEY: padBuffer(vapidCurve.getPrivateKey(), 32).toString(
      'base64url',
    ),
  };
}

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// For a NEW .env built from .env.example only: sets KEY=value on its existing
// line, uncommenting a `# KEY=` line when that is the only one, or appends it
// at the end. An existing .env goes through writeEnvFileEdits() instead.
function setEnvLine(text, key, rawValue) {
  const value = formatEnvValue(rawValue);
  const keyPattern = escapeForPattern(key);
  const assignedLine = new RegExp(`^${keyPattern}=.*$`, 'm');
  if (assignedLine.test(text))
    return text.replace(assignedLine, () => `${key}=${value}`);
  const commentedLine = new RegExp(`^#\\s*${keyPattern}=.*$`, 'm');
  if (commentedLine.test(text))
    return text.replace(commentedLine, () => `${key}=${value}`);
  return `${text.replace(/\n*$/, '\n')}${key}=${value}\n`;
}

function commentEnvLine(text, key) {
  return text.replace(
    new RegExp(`^${escapeForPattern(key)}=(.*)$`, 'm'),
    (_line, value) => `# ${key}=${value}`,
  );
}

function localMinioValues(minioPort) {
  return {
    AWS_ENDPOINT_URL: `http://localhost:${minioPort}`,
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_S3_BUCKET_NAME: LOCAL_MINIO_BUCKET,
    AWS_ACCESS_KEY_ID: LOCAL_MINIO_USER,
    AWS_SECRET_ACCESS_KEY: LOCAL_MINIO_PASSWORD,
    AWS_S3_FORCE_PATH_STYLE: 'true',
  };
}

function withPort(databaseUrl, port) {
  const parsedUrl = new URL(databaseUrl);
  parsedUrl.port = String(port);
  return parsedUrl.toString();
}

function readPortSetting(fileValues, key, fallback) {
  const rawValue = effectiveValue(fileValues, key);
  const port = Number(rawValue);
  return rawValue && Number.isInteger(port) && port > 0 ? port : fallback;
}

// ---------------------------------------------------------------------------
// Steps

function checkToolchain() {
  printStep('Node and pnpm');
  const nodeVersion = checkNodeVersion();
  if (!nodeVersion.isSupported) {
    throw new SetupError(
      `Node ${nodeVersion.found} found, this repo needs Node >= ${nodeVersion.needed}`,
      'install Node 22 LTS (`nvm install` reads .nvmrc), then re-run',
    );
  }
  printStatus('ok', `Node ${nodeVersion.found}`);
  const pnpmVersion = checkPnpmVersion();
  if (pnpmVersion.found === null) {
    throw new SetupError(
      'pnpm is not installed',
      `run \`corepack enable\` (ships with Node) so pnpm@${pnpmVersion.pinned} is used, then re-run`,
    );
  }
  if (!pnpmVersion.isSupported) {
    throw new SetupError(
      `pnpm ${pnpmVersion.found} found, this repo needs pnpm 9 (package.json pins pnpm@${pnpmVersion.pinned})`,
      'run `corepack enable` so pnpm follows packageManager, then re-run',
    );
  }
  printStatus('ok', `pnpm ${pnpmVersion.found}`);
}

// In the container, node_modules is a named volume and stdin is no terminal.
// pnpm aborts when it needs to confirm purging a modules directory another
// pnpm built, so that confirmation is turned off.
const CONTAINER_INSTALL_FLAGS = ['--config.confirm-modules-purge=false'];

function installDependencies() {
  printStep('Dependencies');
  if (isDryRun) {
    const hasNodeModules = existsSync(
      join(PROJECT_ROOT, 'node_modules', '.modules.yaml'),
    );
    printStatus(
      'plan',
      `would run \`pnpm install${isContainerMode ? ' --frozen-lockfile' : ''}\` (node_modules ${hasNodeModules ? 'present, so this is a quick check' : 'missing'})`,
    );
    return;
  }
  if (!isContainerMode) {
    runVisibly('pnpm', ['install']);
    printStatus('ok', 'dependencies installed');
    return;
  }
  const frozenResult = runCommand('pnpm', [
    'install',
    '--frozen-lockfile',
    ...CONTAINER_INSTALL_FLAGS,
  ]);
  if (frozenResult.status === 0) {
    printStatus(
      'ok',
      'dependencies installed with `pnpm install --frozen-lockfile`',
    );
    return;
  }
  printStatus(
    'warn',
    `\`pnpm install --frozen-lockfile\` ${frozenResult.signal ? `was killed by ${frozenResult.signal}` : `exited with code ${frozenResult.status}`} (usually pnpm-lock.yaml out of date with package.json); falling back to a plain \`pnpm install\``,
  );
  runVisibly('pnpm', ['install', ...CONTAINER_INSTALL_FLAGS]);
  printStatus(
    'ok',
    'dependencies installed with a plain `pnpm install`, which may have rewritten pnpm-lock.yaml in your checkout (check `git status`)',
  );
}

async function startDockerServices(fileValues) {
  printStep('Docker services (Postgres, MinIO)');
  if (isContainerMode) {
    printStatus(
      'skip',
      'running inside the compose api container; compose already started postgres and minio',
    );
    return {
      postgresPort: readPortSetting(
        fileValues,
        'QP_POSTGRES_PORT',
        DEFAULT_POSTGRES_PORT,
      ),
      minioPort: readPortSetting(
        fileValues,
        'QP_MINIO_PORT',
        DEFAULT_MINIO_PORT,
      ),
      minioConsolePort: readPortSetting(
        fileValues,
        'QP_MINIO_CONSOLE_PORT',
        DEFAULT_MINIO_CONSOLE_PORT,
      ),
      isMinioUp: true,
      isMinioPlanned: false,
    };
  }
  const postgresPort = readPortSetting(
    fileValues,
    'QP_POSTGRES_PORT',
    DEFAULT_POSTGRES_PORT,
  );
  const minioPort = readPortSetting(
    fileValues,
    'QP_MINIO_PORT',
    DEFAULT_MINIO_PORT,
  );
  const minioConsolePort = readPortSetting(
    fileValues,
    'QP_MINIO_CONSOLE_PORT',
    DEFAULT_MINIO_CONSOLE_PORT,
  );
  const state = {
    postgresPort,
    minioPort,
    minioConsolePort,
    isMinioUp: false,
    isMinioPlanned: false,
  };

  const explainNoDocker = (reason) => {
    printStatus('warn', `${reason}, so no containers start`);
    printIndented([
      'uploads stay off without MinIO (the API boots fine; upload requests fail)',
      `Postgres must then run natively on localhost:${DEFAULT_POSTGRES_PORT}: Postgres.app (https://postgresapp.com) or \`brew install postgresql@16\``,
    ]);
    state.postgresPort = DEFAULT_POSTGRES_PORT;
  };

  if (shouldSkipDocker) {
    explainNoDocker('--skip-docker given');
    return state;
  }
  const docker = detectDocker();
  if (!docker.isDaemonRunning) {
    explainNoDocker(`Docker unavailable: ${docker.reason}`);
    return state;
  }
  printStatus('ok', `Docker running (compose ${docker.composeVersion})`);

  const definedServices = runQuietly('docker', [
    'compose',
    'config',
    '--services',
  ]).output.split('\n');
  const runningServices = runQuietly('docker', [
    'compose',
    'ps',
    '--status',
    'running',
    '--services',
  ]).output.split('\n');
  const servicesToStart = [];

  if (!definedServices.includes('postgres')) {
    printStatus(
      'warn',
      'docker-compose.yml defines no `postgres` service; using whatever listens on the Postgres port',
    );
  } else if (runningServices.includes('postgres')) {
    servicesToStart.push('postgres');
    printStatus(
      'ok',
      `compose postgres already running on localhost:${postgresPort}`,
    );
  } else if (await isPortListening(postgresPort)) {
    printStatus(
      'info',
      `something else already listens on localhost:${postgresPort} (Postgres.app?); using that server and skipping the compose postgres`,
    );
    printIndented([
      `to use the container instead, give it a free port: QP_POSTGRES_PORT=5433 pnpm dev:setup`,
      '(with an existing .env, also add QP_POSTGRES_PORT=5433 there and point DATABASE_URL at port 5433)',
    ]);
  } else {
    servicesToStart.push('postgres');
  }

  if (!definedServices.includes('minio')) {
    printStatus(
      'warn',
      'docker-compose.yml defines no `minio` service, so uploads stay off',
    );
  } else if (runningServices.includes('minio')) {
    servicesToStart.push('minio');
    state.isMinioUp = true;
    printStatus(
      'ok',
      `compose minio already running on localhost:${minioPort}`,
    );
  } else if (await isPortListening(minioPort)) {
    printStatus(
      'warn',
      `something else already listens on localhost:${minioPort}, so the compose minio is skipped and uploads stay off`,
    );
    printIndented([
      `free that port or pick another: QP_MINIO_PORT=9100 QP_MINIO_CONSOLE_PORT=9101 pnpm dev:setup`,
    ]);
  } else {
    servicesToStart.push('minio');
  }

  if (servicesToStart.length === 0) return state;
  const composeArguments = [
    'compose',
    'up',
    '-d',
    '--wait',
    ...servicesToStart,
  ];
  if (isDryRun) {
    printStatus('plan', `would run \`docker ${composeArguments.join(' ')}\``);
    state.isMinioPlanned = servicesToStart.includes('minio');
    return state;
  }
  runVisibly('docker', composeArguments, {
    QP_POSTGRES_PORT: String(postgresPort),
    QP_MINIO_PORT: String(minioPort),
    QP_MINIO_CONSOLE_PORT: String(minioConsolePort),
  });
  state.isMinioUp = servicesToStart.includes('minio');
  printStatus('ok', `${servicesToStart.join(' and ')} up and healthy`);
  return state;
}

async function writeEnvFiles(dockerState) {
  printStep('Environment files');
  const isMinioAvailable = dockerState.isMinioUp || dockerState.isMinioPlanned;
  let envValues;

  if (!existsSync(ENV_PATH)) {
    const exampleText = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    const secrets = generateLocalSecrets();
    let envText = exampleText;
    for (const [key, value] of Object.entries(secrets))
      envText = setEnvLine(envText, key, value);
    envText = setEnvLine(envText, 'EMAIL_CODE_DEV_LOG', 'true');
    const exampleDatabaseUrl = parseEnvText(exampleText).DATABASE_URL;
    if (exampleDatabaseUrl) {
      envText = setEnvLine(
        envText,
        'DATABASE_URL',
        withPort(exampleDatabaseUrl, dockerState.postgresPort),
      );
    }
    if (isMinioAvailable) {
      for (const [key, value] of Object.entries(
        localMinioValues(dockerState.minioPort),
      )) {
        envText = setEnvLine(envText, key, value);
      }
    } else {
      // The example's AWS_* lines are placeholders for the production bucket.
      // Commented out, storage is cleanly off instead of failing per request
      // against an endpoint those fake keys can never open.
      for (const key of STORAGE_KEYS) envText = commentEnvLine(envText, key);
    }
    // A moved host port has to live in .env, where docker compose reads it.
    const portKeys = [];
    for (const [key, port, defaultPort] of [
      ['QP_POSTGRES_PORT', dockerState.postgresPort, DEFAULT_POSTGRES_PORT],
      ['QP_MINIO_PORT', dockerState.minioPort, DEFAULT_MINIO_PORT],
      [
        'QP_MINIO_CONSOLE_PORT',
        dockerState.minioConsolePort,
        DEFAULT_MINIO_CONSOLE_PORT,
      ],
    ]) {
      if (port !== defaultPort) {
        envText = setEnvLine(envText, key, String(port));
        portKeys.push(key);
      }
    }
    const filledKeys = [
      ...Object.keys(secrets),
      'EMAIL_CODE_DEV_LOG',
      'DATABASE_URL',
      ...(isMinioAvailable
        ? Object.keys(localMinioValues(dockerState.minioPort))
        : []),
      ...portKeys,
    ];
    if (isDryRun) {
      printStatus(
        'plan',
        `would create .env from .env.example, filling ${filledKeys.join(', ')}`,
      );
      if (!isMinioAvailable)
        printIndented([
          'and would comment out the AWS_* placeholders (uploads off without MinIO)',
        ]);
    } else {
      writeFileSync(ENV_PATH, envText, { mode: 0o600 });
      printStatus(
        'ok',
        `created .env with fresh local secrets (${filledKeys.length} keys filled)`,
      );
      if (!isMinioAvailable)
        printIndented([
          'AWS_* placeholders are commented out: uploads stay off until MinIO runs',
        ]);
    }
    if (isContainerMode) {
      printIndented([
        'its DATABASE_URL and AWS_ENDPOINT_URL use localhost, for an API run on your machine; inside this container the compose environment points them at postgres and minio',
      ]);
    }
    envValues = parseEnvText(envText);
  } else {
    const envText = readFileSync(ENV_PATH, 'utf8');
    envValues = await reviewExistingEnv(
      envText,
      parseEnvText(envText),
      dockerState,
      isMinioAvailable,
    );
  }

  if (!existsSync(ENV_TEST_PATH)) {
    const testExampleText = readFileSync(ENV_TEST_EXAMPLE_PATH, 'utf8');
    // .env.test serves e2e runs on the host, so in the container it takes the
    // file's localhost URL.
    const devDatabaseUrl = isContainerMode
      ? envValues.DATABASE_URL
      : effectiveValue(envValues, 'DATABASE_URL');
    let testEnvText = testExampleText;
    if (devDatabaseUrl && !describeDatabaseUrlProblem(devDatabaseUrl)) {
      const testUrl = withDatabaseName(
        devDatabaseUrl,
        testDatabaseName(describeDatabaseUrl(devDatabaseUrl).database),
      );
      testEnvText = setEnvLine(testEnvText, 'DATABASE_URL', testUrl);
    }
    if (isDryRun) {
      printStatus(
        'plan',
        'would create .env.test from .env.test.example, pointing DATABASE_URL at the _test database',
      );
    } else {
      writeFileSync(ENV_TEST_PATH, testEnvText, { mode: 0o600 });
      printStatus(
        'ok',
        'created .env.test (DATABASE_URL points at the _test database)',
      );
    }
  } else {
    printStatus('ok', '.env.test exists, leaving it untouched');
  }
  return envValues;
}

// ---------------------------------------------------------------------------
// Reviewing an existing .env

const VAPID_SUBJECT_DEFAULT = 'mailto:hello@queerpulse.example';
const MINIO_PASSWORD_DISPLAY = '<MinIO root password from docker-compose.yml>';
const GENERATED_DISPLAY = '<generated>';

// What a key does and what is off without it, one line in the review. Keys
// marked isHarmlessWhenMissing have a built-in default that suits local work.
const KEY_DESCRIPTIONS = {
  NODE_ENV: {
    purpose: 'picks development, test or production behaviour',
    withoutIt: 'the API refuses to boot',
  },
  PORT: {
    purpose: 'the port the API listens on',
    withoutIt: 'the API listens on 3000',
    isHarmlessWhenMissing: true,
  },
  DATABASE_URL: {
    purpose: 'where the API and the migration CLI find Postgres',
    withoutIt: 'the API refuses to boot',
  },
  FRONTEND_URL: {
    purpose:
      'the browser origins CORS allows; the first one is also where Google sign-in lands',
    withoutIt: `only ${FRONTEND_DEV_ORIGIN} may call the API`,
  },
  API_URL: {
    purpose: "this API's public origin, used to build image URLs",
    withoutIt: 'image URLs assume http://localhost:3000',
    isHarmlessWhenMissing: true,
  },
  JWT_ACCESS_SECRET: {
    purpose: 'signs the short-lived access token',
    withoutIt: 'the API refuses to boot',
  },
  JWT_REFRESH_SECRET: {
    purpose: 'signs the refresh token, with a value of its own',
    withoutIt: 'the API refuses to boot',
  },
  JWT_ACCESS_TTL: {
    purpose: 'how long an access token lives',
    withoutIt: 'the built-in lifetime applies',
    isHarmlessWhenMissing: true,
  },
  JWT_REFRESH_TTL: {
    purpose: 'how long a refresh token lives',
    withoutIt: 'the built-in lifetime applies',
    isHarmlessWhenMissing: true,
  },
  GOOGLE_CLIENT_ID: {
    purpose:
      'the Google OAuth client id (the placeholder keeps Google sign-in off locally)',
    withoutIt: 'the API refuses to boot',
  },
  GOOGLE_CLIENT_SECRET: {
    purpose:
      'the Google OAuth client secret (the placeholder keeps Google sign-in off locally)',
    withoutIt: 'the API refuses to boot',
  },
  GOOGLE_CALLBACK_URL: {
    purpose: 'where Google sends a signed-in browser back to',
    withoutIt: 'the API refuses to boot',
  },
  COOKIE_DOMAIN: {
    purpose: 'the cookie Domain attribute; empty suits localhost',
    withoutIt: 'cookies stay host-only, which is what local work wants',
    isHarmlessWhenMissing: true,
  },
};

const SEVERITY_ORDER = [
  'required',
  'invalid',
  'recommended',
  'missing',
  'optional',
];
const SEVERITY_TAGS = {
  required: 'boot needs it',
  invalid: 'invalid value',
  recommended: 'recommended',
  missing: 'in .env.example',
  optional: 'optional',
};

// Items --container mode fills in memory: without them the API cannot boot.
function isBlockingItem(item) {
  return item.severity === 'required' || item.severity === 'invalid';
}

function describeItem(description) {
  return `${description.purpose}; without it, ${description.withoutIt}`;
}

// Lists what an existing .env lacks or holds wrong, each with proposed values.
// Judged on the values the API will see (process.env wins over .env), so a
// key compose or the shell already sets is never proposed. Never proposes to
// change a value that works.
export function collectEnvIssues({
  envText,
  envValues,
  exampleText,
  secrets,
  isMinioAvailable,
  minioPort,
  postgresPort,
}) {
  const items = [];
  const notes = [];
  const exampleValues = parseEnvText(exampleText);
  const acknowledgedKeys = new Set([
    ...listAssignedKeys(envText),
    ...listCommentedKeys(envText),
  ]);
  const valueOf = (key) => effectiveValue(envValues, key);
  const isBlank = (key) => !valueOf(key);
  const coveredKeys = new Set();
  const generatedProposal = (key) => ({
    key,
    value: secrets[key],
    display: GENERATED_DISPLAY,
  });
  const plainProposal = (key, value) => ({
    key,
    value,
    display: formatEnvValue(value) ?? value,
  });
  const exampleDatabaseUrl = withPort(
    exampleValues.DATABASE_URL ??
      'postgres://queerpulse:queerpulse@localhost:5432/queerpulse',
    postgresPort,
  );
  const validateDatabaseUrl = (candidate) =>
    describeDatabaseUrlProblem(candidate);
  const validateFrontendUrl = (candidate) => {
    const badOrigins = findInvalidFrontendOrigins(candidate);
    return badOrigins.length > 0
      ? `these entries are not exact origins: ${badOrigins.join(', ')}`
      : null;
  };

  // JWT secrets: boot needs both, 32+ characters each, and different.
  const jwtKeys = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
  for (const key of jwtKeys) {
    coveredKeys.add(key);
    const otherKey = jwtKeys.find((candidateKey) => candidateKey !== key);
    const value = valueOf(key);
    let severity = null;
    let summary = null;
    if (value === undefined) {
      severity = 'required';
      summary = describeItem(KEY_DESCRIPTIONS[key]);
    } else if (value.length < MINIMUM_JWT_SECRET_LENGTH) {
      severity = 'invalid';
      summary = `${KEY_DESCRIPTIONS[key].purpose}; it holds ${value.length} characters, under the ${MINIMUM_JWT_SECRET_LENGTH} boot requires, so the API refuses to start`;
    } else if (key === 'JWT_REFRESH_SECRET' && value === valueOf(otherKey)) {
      severity = 'invalid';
      summary = `${KEY_DESCRIPTIONS[key].purpose}; it equals JWT_ACCESS_SECRET, which boot refuses`;
    }
    if (!severity) continue;
    items.push({
      label: key,
      severity,
      summary,
      proposals: [generatedProposal(key)],
      allowsCustomValue: true,
      validate: (candidate, plannedValues) => {
        if (candidate.length < MINIMUM_JWT_SECRET_LENGTH) {
          return `it has ${candidate.length} characters and boot needs at least ${MINIMUM_JWT_SECRET_LENGTH}`;
        }
        if (candidate === plannedValues[otherKey]) {
          return `it equals ${otherKey}, and the two must differ`;
        }
        return null;
      },
    });
  }

  // DATABASE_URL and FRONTEND_URL: set but malformed.
  const databaseUrl = valueOf('DATABASE_URL');
  if (databaseUrl) {
    coveredKeys.add('DATABASE_URL');
    const problem = describeDatabaseUrlProblem(databaseUrl);
    if (problem) {
      items.push({
        label: 'DATABASE_URL',
        severity: 'invalid',
        summary: `${KEY_DESCRIPTIONS.DATABASE_URL.purpose}; the current value is malformed (${problem}), so the API cannot connect`,
        proposals: [plainProposal('DATABASE_URL', exampleDatabaseUrl)],
        allowsCustomValue: true,
        validate: validateDatabaseUrl,
      });
    }
  }
  const frontendUrl = valueOf('FRONTEND_URL');
  if (frontendUrl !== undefined) {
    coveredKeys.add('FRONTEND_URL');
    const badOrigins = findInvalidFrontendOrigins(frontendUrl);
    if (badOrigins.length > 0) {
      const goodOrigins = frontendUrl
        .split(',')
        .map((entry) => entry.trim().replace(/\/+$/, ''))
        .filter((entry) => entry && !badOrigins.includes(entry));
      items.push({
        label: 'FRONTEND_URL',
        severity: 'invalid',
        summary: `${KEY_DESCRIPTIONS.FRONTEND_URL.purpose}; ${badOrigins.join(', ')} ${badOrigins.length === 1 ? 'is not an exact origin' : 'are not exact origins'} (scheme + host + port only), so boot refuses it`,
        proposals: [
          plainProposal(
            'FRONTEND_URL',
            goodOrigins.length > 0
              ? goodOrigins.join(',')
              : FRONTEND_DEV_ORIGIN,
          ),
        ],
        allowsCustomValue: true,
        validate: validateFrontendUrl,
      });
    }
  }

  // Email sign-in codes: the only local sign-in without Google keys.
  coveredKeys.add('EMAIL_CODE_DEV_LOG');
  if (isBlank('EMAIL_CODE_DEV_LOG') && isBlank('RESEND_API_KEY')) {
    items.push({
      label: 'EMAIL_CODE_DEV_LOG',
      severity: 'recommended',
      summary:
        'writes each email sign-in code to the API log, so local sign-in needs no email service; without it, there is no way to sign in locally without Google OAuth keys',
      proposals: [plainProposal('EMAIL_CODE_DEV_LOG', 'true')],
      allowsCustomValue: true,
    });
  }

  // Storage: the local MinIO block, or the path-style flag MinIO needs.
  for (const key of [...STORAGE_KEYS, 'AWS_S3_FORCE_PATH_STYLE']) {
    coveredKeys.add(key);
  }
  const isStoragePlaceholder = isPlaceholderStorage(envValues);
  const isStorageConfigured =
    STORAGE_KEYS.every((key) => !isBlank(key)) && !isStoragePlaceholder;
  const endpointUrl = valueOf('AWS_ENDPOINT_URL');
  if (isMinioAvailable && !isStorageConfigured) {
    items.push({
      label: 'local MinIO block (AWS_*)',
      severity: 'recommended',
      summary: isStoragePlaceholder
        ? 'points uploads at the local MinIO from docker compose; the AWS_* keys still hold the .env.example placeholders, so every upload fails'
        : 'points uploads at the local MinIO from docker compose; without it, uploads (avatars, photos, audio) are off',
      proposals: Object.entries(localMinioValues(minioPort)).map(
        ([key, value]) =>
          key === 'AWS_SECRET_ACCESS_KEY'
            ? { key, value, display: MINIO_PASSWORD_DISPLAY }
            : plainProposal(key, value),
      ),
      allowsCustomValue: false,
    });
  } else if (
    isStorageConfigured &&
    isLocalEndpoint(endpointUrl) &&
    valueOf('AWS_S3_FORCE_PATH_STYLE') !== 'true'
  ) {
    items.push({
      label: 'AWS_S3_FORCE_PATH_STYLE',
      severity: 'recommended',
      summary: `turns on the path-style bucket URLs MinIO serves; without it, uploads to ${endpointUrl} fail`,
      proposals: [plainProposal('AWS_S3_FORCE_PATH_STYLE', 'true')],
      allowsCustomValue: false,
    });
  } else if (!isStorageConfigured) {
    notes.push(
      'uploads stay off: no local MinIO runs, so setup proposes no AWS_* values (start Docker and re-run to get the MinIO block)',
    );
  }

  // Optional local keys, each group generated together.
  const optionalGroups = [
    {
      label: 'membership card signing keys',
      keys: ['CARD_SIGNING_PRIVATE_KEY', 'CARD_SIGNING_PUBLIC_KEY'],
      summary:
        'an Ed25519 key pair that signs membership card codes; without it, card codes are off',
    },
    {
      label: 'Web Push (VAPID) keys',
      keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
      summary:
        'a P-256 key pair that signs Web Push messages; without it, push notifications are off',
    },
    {
      label: 'BAN_EVASION_PEPPER',
      keys: ['BAN_EVASION_PEPPER'],
      summary:
        'the pepper for ban-evasion identifier hashes (set it once and keep it); without it, those identifier signals are off',
    },
  ];
  coveredKeys.add('VAPID_SUBJECT');
  for (const group of optionalGroups) {
    for (const key of group.keys) coveredKeys.add(key);
    const blankKeys = group.keys.filter(isBlank);
    if (blankKeys.length === 0) continue;
    if (blankKeys.length < group.keys.length) {
      notes.push(
        `${group.keys.join(' and ')} are only partly set; they work as a set, so set all of them or none (setup leaves them alone)`,
      );
      continue;
    }
    const proposals = group.keys.map(generatedProposal);
    if (group.keys.includes('VAPID_PUBLIC_KEY') && isBlank('VAPID_SUBJECT')) {
      proposals.push(plainProposal('VAPID_SUBJECT', VAPID_SUBJECT_DEFAULT));
    }
    items.push({
      label: group.label,
      severity: 'optional',
      summary: group.summary,
      proposals,
      allowsCustomValue: false,
    });
  }

  // Every other key .env.example sets that .env lacks. A commented-out line
  // counts as a deliberate opt-out, except for keys boot cannot do without.
  for (const key of new Set(listAssignedKeys(exampleText))) {
    if (coveredKeys.has(key)) continue;
    const isBootRequired = BOOT_REQUIRED_KEYS.includes(key);
    const isPresent = isBootRequired
      ? !isBlank(key)
      : acknowledgedKeys.has(key) || process.env[key] !== undefined;
    if (isPresent) continue;
    const description = KEY_DESCRIPTIONS[key] ?? {
      purpose: 'a setting .env.example lists (its comment there explains it)',
      withoutIt: 'its built-in default applies',
      isHarmlessWhenMissing: true,
    };
    items.push({
      label: key,
      severity: isBootRequired
        ? 'required'
        : description.isHarmlessWhenMissing
          ? 'optional'
          : 'missing',
      summary: describeItem(description),
      proposals: [
        plainProposal(
          key,
          key === 'DATABASE_URL'
            ? exampleDatabaseUrl
            : (exampleValues[key] ?? ''),
        ),
      ],
      allowsCustomValue: true,
      validate:
        key === 'DATABASE_URL'
          ? validateDatabaseUrl
          : key === 'FRONTEND_URL'
            ? validateFrontendUrl
            : undefined,
    });
  }

  items.sort(
    (firstItem, secondItem) =>
      SEVERITY_ORDER.indexOf(firstItem.severity) -
      SEVERITY_ORDER.indexOf(secondItem.severity),
  );
  return { items, notes };
}

// How this run treats the items: 'accept-all' (--update-env --yes), 'review'
// (terminal, and something beyond optional keys or --update-env), or 'print'.
function decideEnvAction(items) {
  if (shouldUpdateEnv && shouldAcceptAll) return 'accept-all';
  const hasAttentionItems = items.some((item) => item.severity !== 'optional');
  if (isInteractiveTerminal() && (hasAttentionItems || shouldUpdateEnv)) {
    return 'review';
  }
  return 'print';
}

function printItemHeading(item, position, total) {
  const counter = total > 1 ? `(${position}/${total}) ` : '';
  console.log(
    `\n  ${counter}${painter.bold(item.label)} ${painter.dim(`[${SEVERITY_TAGS[item.severity]}]`)}`,
  );
  console.log(`  ${item.summary}`);
  for (const proposal of item.proposals) {
    console.log(`  proposed: ${proposal.key}=${proposal.display}`);
  }
}

function printNotes(notes) {
  for (const note of notes) printStatus('info', note);
}

// The print-only path (no terminal, or the engineer declined the review):
// today's behaviour, lines to paste with freshly generated values.
function printEnvProposals(items) {
  for (const item of items) {
    printStatus(
      item.severity === 'optional' ? 'info' : 'warn',
      `${item.label}: ${item.summary}; paste into .env:`,
    );
    printIndented(
      item.proposals.map(
        (proposal) => `${proposal.key}=${formatEnvValue(proposal.value)}`,
      ),
    );
  }
}

// A typed value wrapped in one pair of matching quotes means the value inside.
function unwrapTypedValue(answer) {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(answer);
  return quoted ? quoted[2] : answer;
}

// Asks about each item. Resolves { edits } with the accepted values,
// { edits: null } when the engineer declines the review, or
// { isCancelled: true } on Ctrl+C / Ctrl+D (nothing is written then).
export async function reviewEnvItems(items, envValues) {
  const prompter = createPrompter();
  try {
    const shouldReview = await prompter.confirm(
      `\n  Your .env needs attention: ${items.length} item${items.length === 1 ? '' : 's'}. Review them now?`,
    );
    if (shouldReview === null) return { isCancelled: true };
    if (!shouldReview) return { edits: null };
    const plannedValues = {
      JWT_ACCESS_SECRET: effectiveValue(envValues, 'JWT_ACCESS_SECRET'),
      JWT_REFRESH_SECRET: effectiveValue(envValues, 'JWT_REFRESH_SECRET'),
    };
    const edits = [];
    const acceptProposals = (item) => {
      for (const proposal of item.proposals) {
        edits.push({ key: proposal.key, value: proposal.value });
        plannedValues[proposal.key] = proposal.value;
      }
    };
    let isAcceptingAll = false;
    for (const [itemIndex, item] of items.entries()) {
      printItemHeading(item, itemIndex + 1, items.length);
      if (isAcceptingAll) {
        acceptProposals(item);
        console.log(painter.dim('  accepted (a)'));
        continue;
      }
      const question = item.allowsCustomValue
        ? '  Enter accepts, s skips, a accepts all remaining, or type your own value: '
        : '  Enter accepts, s skips, a accepts all remaining: ';
      for (;;) {
        const answer = await prompter.ask(question);
        if (answer === null) return { isCancelled: true };
        if (answer === '') {
          acceptProposals(item);
          console.log(painter.dim('  accepted'));
          break;
        }
        if (/^s$/i.test(answer)) {
          console.log(painter.dim('  skipped'));
          break;
        }
        if (/^a$/i.test(answer)) {
          isAcceptingAll = true;
          acceptProposals(item);
          break;
        }
        if (!item.allowsCustomValue) {
          console.log(
            `  ${item.label} sets ${item.proposals.length} keys that only work together, so it takes Enter, s or a; edit .env by hand for other values.`,
          );
          continue;
        }
        const typedValue = unwrapTypedValue(answer);
        const problem =
          item.validate?.(typedValue, plannedValues) ??
          (formatEnvValue(typedValue) === null
            ? 'it mixes single and double quotes, which one .env line cannot hold'
            : null);
        if (problem) {
          console.log(`  That value does not work: ${problem}. Try again.`);
          continue;
        }
        const key = item.proposals[0].key;
        edits.push({ key, value: typedValue });
        plannedValues[key] = typedValue;
        console.log(painter.dim('  using your value'));
        break;
      }
    }
    return { edits };
  } finally {
    prompter.close();
  }
}

function applyAcceptedEdits(edits, envValues) {
  if (edits.length === 0) {
    printStatus('skip', 'nothing accepted, so .env is unchanged');
    return envValues;
  }
  const result = writeEnvFileEdits(ENV_PATH, edits, 'pnpm dev:setup');
  printStatus('ok', `backed up .env to ${basename(result.backupPath)}`);
  const changeParts = [];
  if (result.replacedKeys.length > 0) {
    changeParts.push(`replaced ${result.replacedKeys.join(', ')}`);
  }
  if (result.appendedKeys.length > 0) {
    changeParts.push(`added ${result.appendedKeys.join(', ')}`);
  }
  printStatus('ok', `updated .env: ${changeParts.join('; ')}`);
  return parseEnvText(readFileSync(ENV_PATH, 'utf8'));
}

async function reviewExistingEnv(
  envText,
  envValues,
  dockerState,
  isMinioAvailable,
) {
  const { items, notes } = collectEnvIssues({
    envText,
    envValues,
    exampleText: existsSync(ENV_EXAMPLE_PATH)
      ? readFileSync(ENV_EXAMPLE_PATH, 'utf8')
      : '',
    secrets: generateLocalSecrets(),
    isMinioAvailable,
    minioPort: dockerState.minioPort,
    postgresPort: dockerState.postgresPort,
  });

  if (isContainerMode) {
    printStatus(
      'ok',
      '.env exists; this container reads it and never writes it',
    );
    const blockingItems = items.filter(isBlockingItem);
    if (blockingItems.length > 0) {
      const temporaryKeys = blockingItems.flatMap((item) =>
        item.proposals.map((proposal) => proposal.key),
      );
      for (const item of blockingItems) {
        for (const proposal of item.proposals) {
          inMemoryEnvironment[proposal.key] = proposal.value;
        }
      }
      printStatus(
        'warn',
        `.env lacks or holds invalid values for ${temporaryKeys.join(', ')}, so this run uses temporary values held in memory`,
      );
      const consequences = [];
      if (temporaryKeys.some((key) => key.startsWith('JWT_'))) {
        consequences.push(
          'temporary JWT secrets mean every session resets when this container restarts',
        );
      }
      printIndented([
        ...consequences,
        'run `pnpm dev:setup` on your machine to save them',
      ]);
    }
    const otherItems = items.filter((item) => !isBlockingItem(item));
    if (otherItems.length > 0) {
      printStatus(
        'info',
        `${otherItems.length} more .env item(s) worth a look: ${otherItems.map((item) => item.label).join(', ')}; \`pnpm dev:setup\` on your machine offers them`,
      );
    }
    printNotes(notes);
    return { ...envValues, ...inMemoryEnvironment };
  }

  if (items.length === 0) {
    printStatus('ok', '.env exists and has every key and value it needs');
    printNotes(notes);
    return envValues;
  }

  const action = decideEnvAction(items);
  if (isDryRun) {
    const actionDescription = {
      'accept-all': 'accepts every proposal (--update-env --yes)',
      review: 'asks about each one',
      print: 'prints the lines to add',
    }[action];
    printStatus(
      'plan',
      `.env needs attention: ${items.length} item(s); a real run ${actionDescription}`,
    );
    for (const item of items) {
      printIndented([
        `${item.label} [${SEVERITY_TAGS[item.severity]}]: ${item.summary}`,
        ...item.proposals.map(
          (proposal) => `  proposed: ${proposal.key}=${proposal.display}`,
        ),
      ]);
    }
    printNotes(notes);
    return envValues;
  }

  printStatus('ok', '.env exists');
  let updatedValues = envValues;
  if (action === 'accept-all') {
    updatedValues = applyAcceptedEdits(
      items.flatMap((item) =>
        item.proposals.map((proposal) => ({
          key: proposal.key,
          value: proposal.value,
        })),
      ),
      envValues,
    );
  } else if (action === 'review') {
    const reviewResult = await reviewEnvItems(items, envValues);
    console.log('');
    if (reviewResult.isCancelled) {
      throw new SetupError(
        'the .env review was cancelled before anything was written',
        'run `pnpm dev:setup` again when you are ready; .env is unchanged',
      );
    }
    if (reviewResult.edits === null) {
      printStatus(
        'skip',
        'review declined, so .env is unchanged; the lines to add:',
      );
      printEnvProposals(items);
    } else {
      updatedValues = applyAcceptedEdits(reviewResult.edits, envValues);
    }
  } else {
    printEnvProposals(items);
    if (isInteractiveTerminal()) {
      printIndented([
        'only optional keys are missing; `pnpm dev:setup --update-env` offers them one by one',
      ]);
    } else if (shouldUpdateEnv) {
      printIndented([
        'no terminal to ask on, so --update-env needs --yes to write .env',
      ]);
    }
  }
  printNotes(notes);
  return updatedValues;
}

// Resolves the DATABASE_URL the app and the migration CLI will use.
function resolveDatabaseUrl(envValues) {
  const databaseUrl = effectiveValue(envValues, 'DATABASE_URL');
  if (!databaseUrl) {
    throw new SetupError(
      'DATABASE_URL is not set in .env',
      'add DATABASE_URL=postgres://queerpulse:queerpulse@localhost:5432/queerpulse to .env',
    );
  }
  if (
    process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL !== envValues.DATABASE_URL
  ) {
    if (isContainerMode) {
      printStatus(
        'info',
        'DATABASE_URL comes from the compose environment and wins over .env',
      );
    } else {
      printStatus(
        'warn',
        'DATABASE_URL is exported in your shell and overrides .env; using the shell value',
      );
    }
  }
  const problem = describeDatabaseUrlProblem(databaseUrl);
  if (problem) {
    throw new SetupError(
      `DATABASE_URL is malformed: ${problem}`,
      'use postgres://user:password@host:port/database (on a terminal, `pnpm dev:setup` offers a working value)',
    );
  }
  return { databaseUrl, target: describeDatabaseUrl(databaseUrl) };
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

// Errors that mean "the server is still starting": compose reports postgres
// healthy a moment before it accepts every connection.
const TRANSIENT_POSTGRES_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  '57P03',
]);

// In the container, waits up to CONTAINER_WAIT_SECONDS for Postgres.
async function connectMaintenanceWithWait(pg, databaseUrl, envValues) {
  const deadline = Date.now() + CONTAINER_WAIT_SECONDS * 1000;
  let hasPrintedWait = false;
  for (;;) {
    try {
      return await connectMaintenance(pg, databaseUrl, envValues);
    } catch (error) {
      const isTransient =
        TRANSIENT_POSTGRES_CODES.has(error?.code) ||
        /timeout|starting up/i.test(`${error?.message ?? ''}`);
      if (
        !isContainerMode ||
        isDryRun ||
        !isTransient ||
        Date.now() > deadline
      ) {
        throw error;
      }
      if (!hasPrintedWait) {
        printStatus(
          'info',
          `waiting up to ${CONTAINER_WAIT_SECONDS}s for Postgres to accept connections`,
        );
        hasPrintedWait = true;
      }
      await sleep(1_000);
    }
  }
}

async function connectMaintenance(pg, databaseUrl, envValues) {
  try {
    return await connectPostgres(
      pg,
      withDatabaseName(databaseUrl, 'postgres'),
      envValues,
    );
  } catch (error) {
    if (error?.code !== '3D000') throw error;
    return await connectPostgres(
      pg,
      withDatabaseName(databaseUrl, 'template1'),
      envValues,
    );
  }
}

async function createDatabases(pg, envValues) {
  printStep('Databases');
  const { databaseUrl, target } = resolveDatabaseUrl(envValues);
  const testName = testDatabaseName(target.database);
  const address = `${target.host}:${target.port}`;
  const state = {
    databaseUrl,
    target,
    testUrl: withDatabaseName(databaseUrl, testName),
    testName,
    existing: new Set(),
    isServerReachable: false,
  };

  if (!pg) {
    printStatus(
      'plan',
      `would create "${target.database}" and "${testName}" on ${address} if missing (\`pg\` is not installed yet, so existence is not checked)`,
    );
    return state;
  }
  let client;
  try {
    client = await connectMaintenanceWithWait(pg, databaseUrl, envValues);
  } catch (error) {
    const explanation = explainPostgresError(error, {
      ...target,
      database: 'postgres',
    });
    if (isDryRun) {
      printStatus('warn', `cannot reach Postgres: ${explanation.reason}`);
      printIndented([`fix: ${explanation.fix}`, 'a real run stops here']);
      return state;
    }
    throw new SetupError(
      `cannot reach Postgres: ${explanation.reason}`,
      explanation.fix,
    );
  }
  state.isServerReachable = true;
  try {
    for (const databaseName of [target.database, testName]) {
      if (await databaseExists(client, databaseName)) {
        state.existing.add(databaseName);
        printStatus('ok', `database "${databaseName}" exists on ${address}`);
      } else if (isDryRun) {
        printStatus(
          'plan',
          `would CREATE DATABASE "${databaseName}" on ${address}`,
        );
      } else {
        await client.query(
          `CREATE DATABASE ${client.escapeIdentifier(databaseName)}`,
        );
        state.existing.add(databaseName);
        printStatus('ok', `created database "${databaseName}" on ${address}`);
      }
    }
  } catch (error) {
    const explanation = explainPostgresError(error, target);
    throw new SetupError(
      `could not create the databases: ${explanation.reason}`,
      explanation.fix,
    );
  } finally {
    await client.end().catch(() => {});
  }
  return state;
}

async function describePendingMigrations(
  pg,
  databaseUrl,
  envValues,
  databaseName,
  databaseState,
) {
  if (!pg || !databaseState.existing.has(databaseName)) {
    return `fresh database, all ${listMigrationNames().length} migrations`;
  }
  const client = await connectPostgres(pg, databaseUrl, envValues);
  try {
    const { pendingNames } = await findPendingMigrations(client);
    return pendingNames.length === 0
      ? 'nothing pending, a no-op'
      : `${pendingNames.length} pending`;
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMigrations(pg, envValues, databaseState) {
  printStep('Migrations');
  const targets = [
    {
      label: 'dev',
      databaseName: databaseState.target.database,
      databaseUrl: databaseState.databaseUrl,
    },
    {
      label: 'test',
      databaseName: databaseState.testName,
      databaseUrl: databaseState.testUrl,
    },
  ];
  for (const migrationTarget of targets) {
    if (isDryRun) {
      if (!databaseState.isServerReachable && pg) {
        printStatus(
          'plan',
          `would run \`pnpm run migration:run\` on ${migrationTarget.label} database "${migrationTarget.databaseName}"`,
        );
        continue;
      }
      const pendingSummary = await describePendingMigrations(
        pg,
        migrationTarget.databaseUrl,
        envValues,
        migrationTarget.databaseName,
        databaseState,
      );
      printStatus(
        'plan',
        `would run \`pnpm run migration:run\` on ${migrationTarget.label} database "${migrationTarget.databaseName}" (${pendingSummary})`,
      );
      continue;
    }
    printStatus(
      'info',
      `migrating ${migrationTarget.label} database "${migrationTarget.databaseName}"`,
    );
    runVisibly('pnpm', ['run', 'migration:run'], {
      DATABASE_URL: migrationTarget.databaseUrl,
    });
    printStatus(
      'ok',
      `${migrationTarget.label} database "${migrationTarget.databaseName}" is up to date`,
    );
  }
}

// Seeds when the dev database has no users, or has no dev admin yet (an
// earlier seed predates it). The seed is idempotent, so the second case only
// adds what is missing. The test database is never seeded.
async function seedDevDatabase(pg, envValues, databaseState) {
  printStep('Seed');
  const { databaseUrl, target } = databaseState;
  if (shouldSkipSeed) {
    printStatus('skip', '--skip-seed given');
    return;
  }
  let seedReason = null;
  if (!pg || !databaseState.existing.has(target.database)) {
    seedReason = 'the database is new, so it has no users';
  } else {
    const client = await connectPostgres(pg, databaseUrl, envValues);
    try {
      if (!(await tableExists(client, 'users'))) {
        seedReason =
          'the users table is not created yet, so there are no users';
      } else {
        const userCount = (
          await client.query('SELECT count(*)::int AS total FROM users')
        ).rows[0].total;
        const hasAdmin =
          (
            await client.query(
              'SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1',
              [DEV_ADMIN_EMAIL],
            )
          ).rowCount > 0;
        if (userCount === 0) {
          seedReason = 'the database has no users';
        } else if (!hasAdmin) {
          seedReason = `${DEV_ADMIN_EMAIL} does not exist yet (${userCount} users present; the seed skips rows that already exist)`;
        } else {
          printStatus(
            'skip',
            `already seeded: ${userCount} users including ${DEV_ADMIN_EMAIL}`,
          );
          return;
        }
      }
    } finally {
      await client.end().catch(() => {});
    }
  }
  if (isDryRun) {
    printStatus(
      'plan',
      `would run \`pnpm run seed\` on "${target.database}" because ${seedReason}`,
    );
    return;
  }
  printStatus('info', `seeding "${target.database}" because ${seedReason}`);
  runVisibly('pnpm', ['run', 'seed'], { DATABASE_URL: databaseUrl });
  printStatus('ok', `seeded "${target.database}"`);
}

async function prepareBucket(envValues, dockerState) {
  printStep('MinIO bucket');
  const endpointUrl = effectiveValue(envValues, 'AWS_ENDPOINT_URL');
  if (isContainerMode) {
    if (!endpointUrl || isPlaceholderStorage(envValues)) {
      printStatus(
        'skip',
        'neither the compose environment nor .env sets a usable AWS_ENDPOINT_URL, so uploads stay off',
      );
      return;
    }
    let endpointHost;
    try {
      endpointHost = new URL(endpointUrl).hostname;
    } catch {
      throw new SetupError(
        `AWS_ENDPOINT_URL "${endpointUrl}" is not a URL`,
        'fix AWS_ENDPOINT_URL in the api service environment of docker-compose.yml',
      );
    }
    if (endpointHost !== 'minio' && !isLocalEndpoint(endpointUrl)) {
      printStatus(
        'skip',
        `AWS_ENDPOINT_URL points at ${endpointHost}, outside the compose stack; setup only creates buckets on the compose minio`,
      );
      return;
    }
  } else {
    const isMinioAvailable =
      dockerState.isMinioUp || dockerState.isMinioPlanned;
    if (!isMinioAvailable) {
      printStatus('skip', 'MinIO is not running, so uploads stay off');
      return;
    }
    const localEndpoint = `http://localhost:${dockerState.minioPort}`;
    const isPointingAtMinio =
      isLocalEndpoint(endpointUrl ?? '') &&
      Number(new URL(endpointUrl).port || 80) === dockerState.minioPort &&
      !isPlaceholderStorage(envValues);
    if (!isPointingAtMinio) {
      printStatus(
        'skip',
        `.env does not point AWS_ENDPOINT_URL at local MinIO (${localEndpoint}); accept the MinIO block in the .env review (\`pnpm dev:setup --update-env\`) to use it`,
      );
      return;
    }
  }
  const bucketCheckFix = isContainerMode
    ? 'check `docker compose ps minio` and the AWS_* entries of the api service in docker-compose.yml'
    : 'check `docker compose ps minio` and the AWS_* keys in .env';
  const bucketName = effectiveValue(envValues, 'AWS_S3_BUCKET_NAME');
  const s3Module = await loadS3();
  if (isDryRun && (!s3Module || !dockerState.isMinioUp)) {
    printStatus(
      'plan',
      `would create bucket "${bucketName}" at ${endpointUrl} if missing`,
    );
  } else if (!s3Module) {
    throw new SetupError(
      '`@aws-sdk/client-s3` is not installed',
      'run `pnpm install`, then re-run',
    );
  } else {
    const client = createStorageClient(s3Module, envValues);
    try {
      let probe = await probeBucket(s3Module, client, bucketName, endpointUrl);
      // In the container MinIO may still be starting; wait for it.
      const deadline = Date.now() + CONTAINER_WAIT_SECONDS * 1000;
      let hasPrintedWait = false;
      while (
        isContainerMode &&
        !isDryRun &&
        !probe.exists &&
        !probe.isReachable &&
        Date.now() < deadline
      ) {
        if (!hasPrintedWait) {
          printStatus(
            'info',
            `waiting up to ${CONTAINER_WAIT_SECONDS}s for MinIO at ${endpointUrl}`,
          );
          hasPrintedWait = true;
        }
        await sleep(1_000);
        probe = await probeBucket(s3Module, client, bucketName, endpointUrl);
      }
      if (probe.exists) {
        printStatus('ok', `bucket "${bucketName}" exists at ${endpointUrl}`);
      } else if (
        isDryRun &&
        (!probe.isReachable || !/does not exist/.test(probe.reason))
      ) {
        printStatus('warn', `MinIO bucket check failed: ${probe.reason}`);
        printIndented([`fix: ${bucketCheckFix}`, 'a real run stops here']);
        return;
      } else if (!probe.isReachable || !/does not exist/.test(probe.reason)) {
        throw new SetupError(
          `MinIO bucket check failed: ${probe.reason}`,
          bucketCheckFix,
        );
      } else if (isDryRun) {
        printStatus(
          'plan',
          `would create bucket "${bucketName}" at ${endpointUrl}`,
        );
      } else {
        await client.send(
          new s3Module.CreateBucketCommand({ Bucket: bucketName }),
          {
            abortSignal: AbortSignal.timeout(10_000),
          },
        );
        printStatus('ok', `created bucket "${bucketName}" at ${endpointUrl}`);
      }
    } finally {
      client.destroy();
    }
  }
  // Community MinIO answers browser CORS server-wide (MINIO_API_CORS_ALLOW_ORIGIN,
  // all origins by default), and per-bucket PutBucketCors is an AIStor feature,
  // so `pnpm storage:cors` stays a deploy step for the real bucket.
  printStatus(
    'ok',
    'browser uploads allowed: MinIO accepts every origin by default, so `pnpm storage:cors` is only needed for the Railway Bucket',
  );
}

function runDoctorAndPrintNextSteps(envValues, dockerState) {
  printStep('Doctor');
  const doctorResult = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, 'scripts', 'dev-doctor.mjs')],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    },
  );
  const apiPort = effectiveValue(envValues, 'PORT') || '3000';
  const hasFrontendCheckout = existsSync(
    join(PROJECT_ROOT, '..', 'queerpulse', 'package.json'),
  );
  console.log(
    `\n${painter.bold(isDryRun ? 'Next steps (after a real run)' : 'Next steps')}`,
  );
  const nextSteps = [
    '`pnpm start:dev` starts the API with hot reload',
    `API health: http://localhost:${apiPort}/health/live`,
    hasFrontendCheckout
      ? 'frontend: `cd ../queerpulse && pnpm dev`, then open http://localhost:5173'
      : 'frontend: clone the queerpulse repo next to this one, run `pnpm dev` there, open http://localhost:5173',
    `sign in with ${DEV_ADMIN_EMAIL} (or another seeded @example.com member) and read the code from the API log line "[dev] sign-in code for challenge <id>: <code>"`,
  ];
  if (dockerState.isMinioUp || dockerState.isMinioPlanned) {
    nextSteps.push(
      `MinIO console: http://localhost:${dockerState.minioConsolePort} (${LOCAL_MINIO_USER} / ${LOCAL_MINIO_PASSWORD})`,
    );
  }
  nextSteps.push(
    '`docker compose up` runs the whole stack (API included) in Docker instead; `pnpm dev:import-db` copies a native Postgres database into it once',
    '`pnpm dev:doctor` re-checks everything at any time',
  );
  for (const nextStep of nextSteps) console.log(`  - ${nextStep}`);
  if (doctorResult.status !== 0) {
    console.log(
      `\n${painter.red('The doctor reported failures above; fix them, then re-run `pnpm dev:setup`.')}`,
    );
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------

// --container: the last step hands over to the API. The child gets
// process.env plus the in-memory values; SIGINT and SIGTERM (Ctrl+C,
// `docker compose stop` / `down`) are forwarded so it shuts down cleanly, and
// a second signal kills it outright.
let apiChild = null;
let forwardedSignalCount = 0;

function handleContainerSignal(signal) {
  if (!apiChild) {
    console.log(`\n${signal} received during setup; stopping`);
    process.exit(128 + (osConstants.signals[signal] ?? 1));
  }
  forwardedSignalCount += 1;
  apiChild.kill(forwardedSignalCount > 1 ? 'SIGKILL' : signal);
}

function startApi() {
  printStep('Start the API');
  if (isDryRun) {
    printStatus(
      'plan',
      'would run `pnpm start:dev` with the compose environment plus any in-memory values',
    );
    return Promise.resolve(0);
  }
  const temporaryKeys = Object.keys(inMemoryEnvironment);
  // QP_API_DEBUG=true opens the inspector on 0.0.0.0 so the port compose
  // publishes (QP_API_DEBUG_PORT) reaches it; `start:debug` binds 127.0.0.1.
  const isDebugging = process.env.QP_API_DEBUG === 'true';
  const startArguments = isDebugging
    ? ['exec', 'nest', 'start', '--debug', '0.0.0.0:9229', '--watch']
    : ['start:dev'];
  printStatus(
    'info',
    `starting \`pnpm ${startArguments.join(' ')}\`${temporaryKeys.length > 0 ? ` with temporary values for ${temporaryKeys.join(', ')}` : ''}`,
  );
  console.log(painter.dim(`        $ pnpm ${startArguments.join(' ')}`));
  return new Promise((resolvePromise) => {
    apiChild = spawn('pnpm', startArguments, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: childEnvironment(),
    });
    apiChild.once('error', (error) => {
      printStatus(
        'fail',
        error.code === 'ENOENT'
          ? '`pnpm` is not on PATH inside the container, so the API cannot start'
          : `\`pnpm start:dev\` could not start: ${error.message}`,
      );
      resolvePromise(1);
    });
    apiChild.once('exit', (exitCode, signal) => {
      resolvePromise(
        exitCode ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1),
      );
    });
  });
}

async function main() {
  console.log(
    painter.bold(
      `QueerPulse backend setup${isContainerMode ? ' (compose api container)' : ''}${isDryRun ? ' (dry run: nothing will change)' : ''}`,
    ),
  );
  if (isContainerMode) {
    process.on('SIGINT', handleContainerSignal);
    process.on('SIGTERM', handleContainerSignal);
    if (!isInsideContainer()) {
      printStatus(
        'warn',
        'QP_IN_CONTAINER is not 1: --container is meant for the compose api service, where docker-compose.yml sets it',
      );
    }
  }
  checkToolchain();
  installDependencies();
  const existingEnvValues = existsSync(ENV_PATH)
    ? parseEnvText(readFileSync(ENV_PATH, 'utf8'))
    : {};
  const dockerState = await startDockerServices(existingEnvValues);
  const envValues = await writeEnvFiles(dockerState);
  const pg = await loadPg();
  if (!pg && !isDryRun) {
    throw new SetupError(
      'the `pg` package did not load after `pnpm install`',
      'run `pnpm install` and check its output',
    );
  }
  const databaseState = await createDatabases(pg, envValues);
  await runMigrations(pg, envValues, databaseState);
  await seedDevDatabase(pg, envValues, databaseState);
  await prepareBucket(envValues, dockerState);
  if (isContainerMode) return startApi();
  return runDoctorAndPrintNextSteps(envValues, dockerState);
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
      if (error instanceof SetupError) {
        printStatus('fail', error.message);
        if (error.fix) printIndented([`fix: ${error.fix}`]);
      } else {
        console.error(`dev-setup crashed: ${error?.stack ?? error}`);
      }
      process.exitCode = 1;
    });
}
