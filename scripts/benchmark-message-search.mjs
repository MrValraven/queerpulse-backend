// ENG-252 benchmark: is a leading-wildcard ILIKE search over one member's
// message history still cheap enough to skip a new index?
//
// `MessagesService.searchMessages` (src/messaging/messages.service.ts) is a
// deliberate ILIKE-only MVP (see that method's own doc comment): the
// participation scope is an `EXISTS` against `conversation_participants`
// (ENG-252's non-row-multiplying rewrite, so `.take()` compiles to a plain
// `SELECT ... LIMIT`), and the text match itself is a bare
// `m.body ILIKE '%term%'` with NO new index. The comment says a member's own
// DM corpus is small enough that a scan of it is cheap, and flags
// `pg_trgm`/`tsvector` as the upgrade IF per-member volume ever grows. Nobody
// had put a number on "ever grows". This script does.
//
// WHAT IT DOES
//  1. Seeds a synthetic inbox for ONE throwaway "searcher" user: a
//     configurable number of DM conversations, a configurable number of
//     messages per conversation, and a configurable body length; tune these
//     to model your largest real member's actual inbox. It also seeds a
//     configurable amount of unrelated "noise" traffic (other throwaway
//     users' own DMs) so the `messages` table isn't 100% the searcher's own
//     rows, which is what a real multi-tenant table looks like.
//  2. Runs the EXACT SQL `searchMessages` issues (participation `EXISTS`,
//     `clearedAt`/`leftAt` guards, the moderation/hide `NOT EXISTS`es, the
//     block filter, `ORDER BY created_at DESC, id DESC LIMIT`), reproduced by
//     hand from `messages.service.ts`. Read that method again before
//     touching this file, since a drift here makes the benchmark meaningless.
//  3. For 4 term shapes (common / rare / very short / accent-bearing), prints
//     `EXPLAIN (ANALYZE, BUFFERS)` plus a median wall-clock time over a few
//     runs.
//  4. By default, ALSO builds a real (but temporary) `pg_trgm` GIN index on
//     `messages.body`, re-runs the same 4 queries, and drops the index again,
//     giving a true before/after measured on the same data. `pg_trgm` is
//     already an installed extension in this database (see `search-text.ts`'s
//     use of it elsewhere), so this adds no new extension and ships no
//     migration; the index never outlives this process. Skip this half with
//     `--no-trigram-comparison` for a faster run.
//  5. Prints a verdict line extrapolating the measured per-row ILIKE cost to
//     the table size at which it would cross a 100ms budget.
//  6. Deletes every row it created (conversations cascade to their messages
//     and participants; the throwaway users are deleted last) in a `finally`,
//     so a crash mid-run still cleans up. Drops the scratch index in the same
//     `finally`.
//
// SAFETY
// Refuses to run unless the target host is obviously local (`localhost`,
// `127.0.0.1`, `::1`) and `NODE_ENV` is not `production`. This script issues
// real INSERT/DELETE/CREATE INDEX/DROP INDEX statements, so it must never be
// capable of touching a real database.
//
// USAGE
//   node scripts/benchmark-message-search.mjs [options]
//
//   --conversations=<n>              DM conversations for the searcher (default 40)
//   --messagesPerConversation=<n>    messages per searcher conversation (default 150)
//   --bodyLength=<n>                 approx characters per message body (default 120)
//   --noiseConversations=<n>         unrelated conversations padding the table (default 300)
//   --noiseMessagesPerConversation=<n>  messages per noise conversation (default 40)
//   --limit=<n>                      search page size, mirrors DEFAULT_SEARCH_LIMIT (default 20)
//   --runsPerQuery=<n>               wall-clock timing samples per term shape (default 5)
//   --no-trigram-comparison          skip the temporary GIN index A/B
//   --databaseUrl=<url>              overrides DATABASE_URL (still must be local)
//
// READING THE OUTPUT
//   - "Seq Scan on messages" with a large `rows=` and a big `actual time=` on
//     the *second* number means Postgres read the whole table to answer the
//     ILIKE, regardless of how few rows matched.
//   - "Bitmap Index Scan" naming the scratch trigram index means Postgres
//     used it instead of scanning every row. Compare its `actual time=`
//     against the no-index run for the same term.
//   - The very-short-term case is expected to stay a Seq Scan even WITH the
//     trigram index: pg_trgm cannot answer a pattern shorter than 3
//     characters from the index at all (see the verdict line for why).
//   - "median wall-clock" is a plain (non-EXPLAIN) execution timed from Node,
//     the number closest to what a real request pays; EXPLAIN ANALYZE's own
//     "Execution Time:" carries a bit of instrumentation overhead on top.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    conversations: 40,
    messagesPerConversation: 150,
    bodyLength: 120,
    noiseConversations: 300,
    noiseMessagesPerConversation: 40,
    limit: 20, // mirrors DEFAULT_SEARCH_LIMIT in src/messaging/messaging.constants.ts
    runsPerQuery: 5,
    trigramComparison: true,
    databaseUrl: undefined,
  };
  for (const rawArgument of argv) {
    if (rawArgument === '--no-trigram-comparison') {
      options.trigramComparison = false;
      continue;
    }
    const match = /^--([A-Za-z]+)=(.+)$/.exec(rawArgument);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'databaseUrl') {
      options.databaseUrl = value;
    } else if (key in options) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid value for --${key}: ${value}`);
      }
      options[key] = parsed;
    } else {
      throw new Error(`Unknown option --${key}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Safety: refuse anything that isn't obviously local
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function assertLocalDatabase(databaseUrl) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[benchmark-message-search] Refusing to run with NODE_ENV=production, ' +
        'regardless of the target host. This script seeds and deletes rows.',
    );
  }
  if (!databaseUrl) {
    throw new Error(
      '[benchmark-message-search] No DATABASE_URL set and no --databaseUrl given. ' +
        'Point it at a local database, e.g. postgres://queerpulse:queerpulse@localhost:5432/queerpulse',
    );
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      `[benchmark-message-search] DATABASE_URL is not a valid URL: ${databaseUrl}`,
    );
  }
  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `[benchmark-message-search] Refusing to run against host "${parsed.hostname}". ` +
        'This script INSERTs, CREATE INDEXes and DELETEs real rows; it only runs ' +
        `against ${[...LOCAL_HOSTNAMES].join(', ')}. Pass --databaseUrl pointing at a ` +
        'local database if that is what you meant.',
    );
  }
  if (process.env.DATABASE_SSL === 'true') {
    throw new Error(
      '[benchmark-message-search] Refusing to run with DATABASE_SSL=true. ' +
        'That is a production/staging signal.',
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Search-term vocabulary, chosen so counts are known ahead of time
// ---------------------------------------------------------------------------

// `escapeLikeTerm`'s exact behaviour (src/common/like-escape.ts), duplicated
// here because this script runs standalone with no ts-node/tsconfig-paths,
// the same convention scripts/migration-preflight.mjs already follows for
// its own small duplicated constants.
function escapeLikeTerm(term) {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const COMMON_WORD = 'community'; // injected into ~15% of every message body, target AND noise
const RARE_WORD = 'zzqribra'; // injected into exactly ONE message, in the searcher's own inbox only
const SHORT_WORD = 'ok'; // injected into ~25% of every message body, target AND noise
const ACCENT_WORD = 'café'; // injected into ~10% of the searcher's OWN messages only

const LOREM_WORDS = [
  'thread',
  'group',
  'photo',
  'reply',
  'meetup',
  'schedule',
  'invite',
  'welcome',
  'profile',
  'update',
  'pinned',
  'archive',
  'draft',
  'mention',
  'reaction',
  'sticker',
  'forward',
  'block',
  'mute',
  'search',
];

function pseudoRandom(seed) {
  // Deterministic across a run (no external dependency), only ever used to
  // pick filler words and injection points, nothing security-sensitive.
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function buildBody(random, approximateLength, extraWords) {
  const words = [...extraWords];
  while (words.join(' ').length < approximateLength) {
    words.push(LOREM_WORDS[Math.floor(random() * LOREM_WORDS.length)]);
  }
  // Shuffle so injected terms don't always land in the same position.
  for (let index = words.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [words[index], words[swapIndex]] = [words[swapIndex], words[index]];
  }
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function newUuid() {
  return randomUUID();
}

async function batchInsert(client, tableName, columns, rows, batchSize = 500) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const valuesSql = [];
    const params = [];
    for (const [rowIndex, row] of batch.entries()) {
      const placeholders = columns.map((_, columnIndex) => {
        params.push(row[columnIndex]);
        return `$${params.length}`;
      });
      valuesSql.push(`(${placeholders.join(', ')})`);
    }
    await client.query(
      `INSERT INTO "${tableName}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES ${valuesSql.join(', ')}`,
      params,
    );
  }
}

async function seedUser(client, label) {
  const id = newUuid();
  await client.query(
    `INSERT INTO "users" ("id", "google_id", "email") VALUES ($1, $2, $3)`,
    [id, `bench-${label}-${id}`, `bench-${label}-${id}@benchmark.local`],
  );
  return id;
}

async function seedConversation(client) {
  const id = newUuid();
  await client.query(
    `INSERT INTO "conversations" ("id", "kind") VALUES ($1, 'direct')`,
    [id],
  );
  return id;
}

async function seedParticipants(client, conversationId, userIds) {
  await batchInsert(
    client,
    'conversation_participants',
    ['id', 'conversation_id', 'user_id'],
    userIds.map((userId) => [newUuid(), conversationId, userId]),
  );
}

/**
 * Seeds one conversation's worth of messages, alternating sender between the
 * two participants, spaced one minute apart working backward from `endTime`.
 * Injects `COMMON_WORD`/`SHORT_WORD` at their fixed frequencies into every
 * body; `injectRareWordAtIndex`/`shouldInjectAccentWord` let the caller place
 * the rare/accent terms deterministically only in the searcher's own inbox.
 */
function buildMessageRows({
  random,
  conversationId,
  senderIds,
  count,
  bodyLength,
  endTime,
  injectRareWordAtIndex,
  shouldInjectAccentWord,
}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const extraWords = [];
    if (random() < 0.15) extraWords.push(COMMON_WORD);
    if (random() < 0.25) extraWords.push(SHORT_WORD);
    if (index === injectRareWordAtIndex) extraWords.push(RARE_WORD);
    if (shouldInjectAccentWord && random() < 0.1) extraWords.push(ACCENT_WORD);
    const body = buildBody(random, bodyLength, extraWords);
    const createdAt = new Date(endTime.getTime() - (count - index) * 60_000);
    const senderId = senderIds[index % senderIds.length];
    rows.push([newUuid(), conversationId, senderId, body, createdAt]);
  }
  return rows;
}

async function seedMessages(client, rows) {
  await batchInsert(
    client,
    'messages',
    ['id', 'conversation_id', 'sender_id', 'body', 'created_at'],
    rows,
  );
}

async function seedInbox(client, options) {
  console.log('Seeding searcher inbox and noise traffic...');
  const random = pseudoRandom(20260916);
  const now = new Date();

  const searcherUserId = await seedUser(client, 'searcher');
  const counterpartUserId = await seedUser(client, 'counterpart');
  const noiseUserA = await seedUser(client, 'noise-a');
  const noiseUserB = await seedUser(client, 'noise-b');
  const createdUserIds = [
    searcherUserId,
    counterpartUserId,
    noiseUserA,
    noiseUserB,
  ];
  const createdConversationIds = [];

  // The searcher's own conversations: this is the "model your largest real
  // member" knob (--conversations / --messagesPerConversation / --bodyLength).
  let rareWordConversationIndex = Math.floor(
    random() * options.conversations,
  );
  let totalSearcherMessages = 0;
  for (
    let conversationIndex = 0;
    conversationIndex < options.conversations;
    conversationIndex += 1
  ) {
    const conversationId = await seedConversation(client);
    createdConversationIds.push(conversationId);
    await seedParticipants(client, conversationId, [
      searcherUserId,
      counterpartUserId,
    ]);
    const isRareWordConversation =
      conversationIndex === rareWordConversationIndex;
    const rareWordMessageIndex = isRareWordConversation
      ? Math.floor(random() * options.messagesPerConversation)
      : -1;
    const rows = buildMessageRows({
      random,
      conversationId,
      senderIds: [searcherUserId, counterpartUserId],
      count: options.messagesPerConversation,
      bodyLength: options.bodyLength,
      endTime: now,
      injectRareWordAtIndex: rareWordMessageIndex,
      shouldInjectAccentWord: true,
    });
    await seedMessages(client, rows);
    totalSearcherMessages += rows.length;
  }

  // Unrelated noise traffic: other members' own DMs, never visible to the
  // searcher, so they can never appear as a hit, while still inflating the
  // total `messages` row count, which is what actually happens in production
  // and is what decides whether Postgres can narrow via the participation
  // EXISTS before running ILIKE, versus running ILIKE over everything first.
  // COMMON_WORD/SHORT_WORD are injected here too, since a common word is
  // common platform-wide, across every member's traffic equally.
  // RARE_WORD/ACCENT_WORD are withheld here so their counts stay exact and
  // attributable to the searcher's own inbox.
  for (
    let conversationIndex = 0;
    conversationIndex < options.noiseConversations;
    conversationIndex += 1
  ) {
    const conversationId = await seedConversation(client);
    createdConversationIds.push(conversationId);
    await seedParticipants(client, conversationId, [noiseUserA, noiseUserB]);
    const rows = buildMessageRows({
      random,
      conversationId,
      senderIds: [noiseUserA, noiseUserB],
      count: options.noiseMessagesPerConversation,
      bodyLength: options.bodyLength,
      endTime: now,
      injectRareWordAtIndex: -1,
      shouldInjectAccentWord: false,
    });
    await seedMessages(client, rows);
  }

  console.log(
    `Seeded ${options.conversations} searcher conversations (${totalSearcherMessages} messages) ` +
      `and ${options.noiseConversations} noise conversations ` +
      `(${options.noiseConversations * options.noiseMessagesPerConversation} messages).`,
  );

  return {
    searcherUserId,
    createdUserIds,
    createdConversationIds,
    totalSearcherMessages,
  };
}

async function cleanupSeed(client, seed) {
  if (!seed) return;
  console.log('Cleaning up seeded data...');
  if (seed.createdConversationIds.length) {
    // Cascades to messages, conversation_participants, conversation_pinned_messages,
    // group_invites via their FKs (see FK_messages_conversation_id ON DELETE
    // CASCADE, FK_conversation_participants_conversation_id ON DELETE CASCADE).
    await client.query(`DELETE FROM "conversations" WHERE "id" = ANY($1::uuid[])`, [
      seed.createdConversationIds,
    ]);
  }
  if (seed.createdUserIds.length) {
    await client.query(`DELETE FROM "users" WHERE "id" = ANY($1::uuid[])`, [
      seed.createdUserIds,
    ]);
  }
  console.log('Cleanup done.');
}

// ---------------------------------------------------------------------------
// The actual query, reproduced by hand from
// MessagesService.searchMessages (src/messaging/messages.service.ts).
// Keep this in sync with that method; a drift here makes every number below
// meaningless.
// ---------------------------------------------------------------------------

const MESSAGE_SUBJECT_TYPE = 'message'; // src/messaging/message-visibility-predicates.ts

function buildSearchSql() {
  return `
    SELECT "m".*
    FROM "messages" "m"
    WHERE "m"."deleted_at" IS NULL
      AND "m"."body" ILIKE $1
      AND EXISTS (
        SELECT 1 FROM "conversation_participants" "p"
        WHERE "p"."conversation_id" = "m"."conversation_id"
          AND "p"."user_id" = $2
          AND ("p"."cleared_at" IS NULL OR "m"."created_at" > "p"."cleared_at")
          AND ("p"."left_at" IS NULL OR "m"."created_at" <= "p"."left_at")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cm"
        WHERE "cm"."subject_type" = $3
          AND "cm"."subject_id" = "m"."id"::text
          AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM "message_hides" "mh"
        WHERE "mh"."message_id" = "m"."id" AND "mh"."user_id" = $2
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM "conversations" "sbfc"
          WHERE "sbfc"."id" = "m"."conversation_id" AND "sbfc"."kind" = 'group'
        )
        OR NOT EXISTS (
          SELECT 1 FROM "blocks" "__block_filter"
          WHERE ("__block_filter"."blocker_id" = $2 AND "__block_filter"."blocked_id" = "m"."sender_id")
             OR ("__block_filter"."blocked_id" = $2 AND "__block_filter"."blocker_id" = "m"."sender_id")
        )
      )
    ORDER BY "m"."created_at" DESC, "m"."id" DESC
    LIMIT $4
  `;
}

function likePattern(term) {
  return `%${escapeLikeTerm(term)}%`;
}

async function runExplain(client, sql, params) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    params,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function medianWallClockMs(client, sql, params, runs) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    const startedAt = process.hrtime.bigint();
    await client.query(sql, params);
    const endedAt = process.hrtime.bigint();
    samples.push(Number(endedAt - startedAt) / 1_000_000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function extractExecutionTimeMs(explainText) {
  const match = /Execution Time: ([0-9.]+) ms/.exec(explainText);
  return match ? Number(match[1]) : null;
}

/**
 * Which physical access path the plan used to read `messages` itself. Checked
 * in specificity order: a literal `Seq Scan on messages` (the whole-table
 * scan the docstring worries about) beats a trigram bitmap scan (only
 * possible once the scratch GIN index exists) beats the ordinary
 * per-conversation index scan the participation `EXISTS` already drives.
 */
function describeMessagesScanStrategy(explainText) {
  if (/Seq Scan on "?messages"?\s+m\b/.test(explainText)) {
    return 'Seq Scan on the whole messages table';
  }
  if (
    explainText.includes('bench_trgm') &&
    /(Bitmap Heap Scan|Bitmap Index Scan) on messages m/.test(explainText)
  ) {
    return 'trigram-index bitmap scan';
  }
  if (/(Index( Only)? Scan|Bitmap Heap Scan) .*on "?messages"?\s+m\b/.test(explainText)) {
    return 'per-conversation index scan (via conversation_id)';
  }
  return 'unrecognized scan shape, see EXPLAIN output above';
}

const TERM_SHAPES = [
  { label: 'common term', term: COMMON_WORD },
  { label: 'rare term', term: RARE_WORD },
  { label: 'very short term', term: SHORT_WORD },
  // Deliberately searching the UNACCENTED spelling against bodies seeded with
  // the ACCENTED spelling (café): `messages.service.ts`'s ILIKE is
  // case-insensitive only (unlike
  // `MessageAnnotationsService.listStarredMessages`, which runs every
  // comparison through `foldedHaystack`/`foldedSearchTerm` for accent
  // folding too). This is a functional gap, flagged in the verdict below.
  { label: 'accent-bearing term (unaccented query)', term: 'cafe' },
];

async function benchmarkTermShapes(client, { searcherUserId, limit, runsPerQuery, label }) {
  const sql = buildSearchSql();
  const results = [];
  console.log(`\n--- ${label} ---`);
  for (const shape of TERM_SHAPES) {
    const params = [
      likePattern(shape.term),
      searcherUserId,
      MESSAGE_SUBJECT_TYPE,
      limit,
    ];
    const explainText = await runExplain(client, sql, params);
    const medianMs = await medianWallClockMs(client, sql, params, runsPerQuery);
    const { rows: hitRows } = await client.query(sql, params);
    console.log(`\n[${shape.label}] term=${JSON.stringify(shape.term)}`);
    console.log(explainText);
    console.log(
      `median wall-clock over ${runsPerQuery} runs: ${medianMs.toFixed(2)} ms | hits returned: ${hitRows.length}`,
    );
    results.push({
      shapeLabel: shape.label,
      medianMs,
      executionTimeMs: extractExecutionTimeMs(explainText),
      scanStrategy: describeMessagesScanStrategy(explainText),
      hits: hitRows.length,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl =
    options.databaseUrl ??
    process.env.DATABASE_URL ??
    'postgres://queerpulse:queerpulse@localhost:5432/queerpulse';
  assertLocalDatabase(databaseUrl);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  let seed = null;
  let scratchIndexBuilt = false;
  const scratchIndexName = `bench_trgm_body_${Date.now()}`;

  try {
    const { rows: beforeCount } = await client.query(
      'SELECT count(*)::bigint AS total FROM "messages"',
    );
    console.log(
      `messages table has ${beforeCount[0].total} rows before seeding.`,
    );

    await client.query('BEGIN');
    seed = await seedInbox(client, options);
    await client.query('COMMIT');

    await client.query('ANALYZE "messages"');
    await client.query('ANALYZE "conversation_participants"');

    const { rows: afterCount } = await client.query(
      'SELECT count(*)::bigint AS total FROM "messages"',
    );
    const totalMessages = Number(afterCount[0].total);
    console.log(`messages table has ${totalMessages} rows after seeding.`);

    const baseline = await benchmarkTermShapes(client, {
      searcherUserId: seed.searcherUserId,
      limit: options.limit,
      runsPerQuery: options.runsPerQuery,
      label: 'BASELINE (no trigram index)',
    });

    let withIndex = null;
    if (options.trigramComparison) {
      console.log(
        `\nBuilding a temporary GIN trigram index (${scratchIndexName})...`,
      );
      await client.query(
        `CREATE INDEX CONCURRENTLY "${scratchIndexName}" ON "messages" USING gin ("body" gin_trgm_ops)`,
      );
      scratchIndexBuilt = true;
      await client.query('ANALYZE "messages"');

      withIndex = await benchmarkTermShapes(client, {
        searcherUserId: seed.searcherUserId,
        limit: options.limit,
        runsPerQuery: options.runsPerQuery,
        label: 'WITH scratch pg_trgm GIN index (dropped at exit)',
      });
    }

    console.log('\n=== VERDICT ===');
    console.log(
      `Scale tested: searcher inbox = ${options.conversations} conversations x ` +
        `${options.messagesPerConversation} messages = ${seed.totalSearcherMessages} messages; ` +
        `whole "messages" table = ${totalMessages} rows.`,
    );
    for (const baselineResult of baseline) {
      const withIndexResult = withIndex?.find(
        (result) => result.shapeLabel === baselineResult.shapeLabel,
      );
      let speedupText = 'with-index comparison skipped';
      if (withIndexResult) {
        const ratio =
          baselineResult.medianMs / Math.max(withIndexResult.medianMs, 0.001);
        const direction = ratio >= 1 ? 'faster' : 'slower';
        const magnitude = ratio >= 1 ? ratio : 1 / ratio;
        speedupText =
          `with-index median ${withIndexResult.medianMs.toFixed(2)} ms, ` +
          `${magnitude.toFixed(1)}x ${direction} than baseline (scan: ${withIndexResult.scanStrategy})`;
      }
      console.log(
        `  ${baselineResult.shapeLabel}: baseline median ${baselineResult.medianMs.toFixed(2)} ms ` +
          `(scan: ${baselineResult.scanStrategy}); ${speedupText}`,
      );
    }

    const commonBaseline = baseline.find(
      (result) => result.shapeLabel === 'common term',
    );
    if (
      commonBaseline &&
      commonBaseline.scanStrategy !== 'Seq Scan on the whole messages table'
    ) {
      console.log(
        `\nAt this scale the baseline plan for "${commonBaseline.shapeLabel}" stayed a ` +
          `${commonBaseline.scanStrategy}. That confirms the searchMessages docstring's own ` +
          'reasoning: the participation EXISTS already bounds the ILIKE filter to the searcher\'s ' +
          'own conversations via IDX_messages_conversation_id, so cost tracks the SEARCHER\'S OWN ' +
          `message volume (${seed.totalSearcherMessages} messages here), largely independent of ` +
          'total platform size. Treat the table-size extrapolation below as a worst-case bound for ' +
          'the day the planner switches strategies, separate from what this run actually measured.',
      );
    }
    if (commonBaseline && totalMessages > 0) {
      // Denominator is the KNOWN whole-table row count (from `count(*)` above)
      // rather than a value scraped out of the EXPLAIN text: a Seq Scan
      // node's own `rows=` counts rows RETURNED after its filter runs, which
      // answers a different question than "how many rows did Postgres examine".
      const msPerRow = commonBaseline.medianMs / totalMessages;
      const budgetMs = 100; // a debounced search-as-you-type latency budget
      const rowsAtBudget = Math.round(budgetMs / msPerRow);
      console.log(
        `\nAt this scale, the baseline common-term query costs roughly ${(msPerRow * 1000).toFixed(3)} ` +
          `microseconds per row in the whole "messages" table. Extrapolating linearly, a ${budgetMs}ms ` +
          `search budget is crossed around a ${rowsAtBudget}-row table (this run seeded ${totalMessages} rows). ` +
          'Linear extrapolation is optimistic (a Seq Scan on a table that no longer fits in shared_buffers ' +
          'gets WORSE than linear, and this number only holds if Postgres is actually reading the whole table ' +
          'per query (check the EXPLAIN output above for "Seq Scan on messages" to confirm), so treat this as ' +
          'an upper bound on how much table you have left.',
      );
    }
    console.log(
      '\nThe very-short-term case is expected to stay a Seq Scan even with the trigram index present: ' +
        'pg_trgm cannot extract a usable trigram from a pattern shorter than 3 characters, so a 2-character ' +
        'query gets no help from a trigram index at any scale. Only a longer minimum query length or a ' +
        'different index type would change that case.',
    );
    console.log(
      '\nThe accent-bearing case is a functional gap independent of speed: searching the unaccented spelling ' +
        'never finds the accented body, because this ILIKE (unlike MessageAnnotationsService.listStarredMessages\'s ' +
        'foldedHaystack/foldedSearchTerm) does no accent folding. Worth folding into the same future migration ' +
        'that adds trigram/tsvector support, alongside that work rather than as its own separate index today.',
    );
  } finally {
    if (scratchIndexBuilt) {
      try {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${scratchIndexName}"`);
      } catch (error) {
        console.warn(
          `Failed to drop scratch index ${scratchIndexName}: ${String(error)}`,
        );
      }
    }
    try {
      await cleanupSeed(client, seed);
    } catch (error) {
      console.error(
        `Cleanup failed. Inspect the database by hand for leftover rows tagged bench-*: ${String(error)}`,
      );
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
