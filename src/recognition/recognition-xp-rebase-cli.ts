import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import { badgeBonusXp, scoreSignals } from './recognition.scoring';
import { computeLevel } from './recognition-response';
import { INVITE_QUOTA_PERKS } from './recognition.catalog';

/**
 * One-time rebase of stored XP onto the post-PRD-05 scoring rules.
 *
 * WHY THIS EXISTS. PRD-05 closed the solo XP farm in `recognition.scoring.ts`:
 * every rule and badge now declares `needsSecondParty`, and `soloXpCeiling()`
 * is asserted below the level-4 door. That fixes what a member can earn from
 * here on, and it does NOTHING about XP already banked, because
 * `RecognitionAwardingService.recompute` upserts through
 * `GREATEST(recognition_stats.xp, EXCLUDED.xp)` for anyone in good standing.
 * The floor is deliberate and worth keeping (deleting your own work must never
 * cost you points), but it also means a total banked under the old rules is
 * permanent. A member who reached level 4 or 5 alone keeps the level, and
 * keeps the extra monthly invitations that level buys, on an invite-gated
 * platform where invitations are the membrane.
 *
 * WHY A CLI RATHER THAN A MIGRATION. This app applies migrations automatically
 * at boot (`apply-pending-migrations.ts`) and again in Railway's
 * `preDeployCommand`. A migration here would silently rewrite member standing
 * on the next deploy, with no chance to look at the blast radius first, and no
 * practical way back: the pre-rebase totals exist nowhere else once the floor
 * has been lowered. Changing what someone has earned is a judgement call that
 * belongs to a person, so this reports by default and only writes when asked.
 *
 * USAGE
 *   pnpm recognition:rebase           # read-only report, writes nothing
 *   pnpm recognition:rebase --apply   # performs the correction
 *
 * WHAT `--apply` GUARANTEES
 *   - It only ever LOWERS a total. A member whose recomputed score is higher
 *     is left alone entirely: growth is the normal recompute path's job, and
 *     raising a score here would hand out levels nobody has been told about.
 *   - Every change writes a signed `RecognitionLedgerEntry` carrying
 *     `reason: 'xp_rebase_prd05'`, so the member's own history explains the
 *     drop rather than the number simply changing under them. This is the
 *     correction path the entity's `xp` column has always been signed for.
 *   - Each member is corrected under the same
 *     `pg_advisory_xact_lock(hashtextextended(userId, 0))` that `recompute`
 *     takes, so a live recompute racing this cannot interleave and leave the
 *     ledger disagreeing with the stat.
 */

const APPLY_FLAG = '--apply';
const REBASE_REASON = 'xp_rebase_prd05';

interface MemberRebaseRow {
  userId: string;
  storedXp: number;
  recomputedXp: number;
  levelBefore: number;
  levelAfter: number;
  /** Invite-quota perks this member has CLAIMED but would no longer qualify for. */
  forfeitedQuotaPerkKeys: string[];
}

/**
 * Recompute one member's XP exactly the way `recompute` does, minus the write
 * and minus the floor: `scoreSignals(signals) + badgeBonusXp(heldKeys)`.
 *
 * `heldKeys` is the member's ALREADY-AWARDED badges. Badges are never revoked
 * here even when the new rules would not re-award them, so a member keeps the
 * badge; PRD-05's change is that a solo badge now carries no XP, which
 * `badgeBonusXp` reflects on its own.
 */
async function recomputeWithoutFloor(
  awarding: RecognitionAwardingService,
  dataSource: DataSource,
  userId: string,
): Promise<number> {
  const signals = await awarding.gatherSignalsForUser(userId);
  const awards = await dataSource
    .getRepository(RecognitionAward)
    .find({ where: { userId } });
  const heldKeys = new Set(awards.map((award) => award.badgeKey));
  return scoreSignals(signals) + badgeBonusXp(heldKeys);
}

async function buildReport(
  awarding: RecognitionAwardingService,
  dataSource: DataSource,
): Promise<MemberRebaseRow[]> {
  const stats = await dataSource
    .getRepository(RecognitionStat)
    .find({ order: { xp: 'DESC' } });
  const claims = await dataSource.getRepository(RecognitionPerkClaim).find();
  const claimsByUser = new Map<string, string[]>();
  for (const claim of claims) {
    const list = claimsByUser.get(claim.userId) ?? [];
    list.push(claim.perkKey);
    claimsByUser.set(claim.userId, list);
  }

  const rows: MemberRebaseRow[] = [];
  for (const stat of stats) {
    const recomputedXp = await recomputeWithoutFloor(
      awarding,
      dataSource,
      stat.userId,
    );
    if (recomputedXp >= stat.xp) continue;

    const levelBefore = computeLevel(stat.xp).level;
    const levelAfter = computeLevel(recomputedXp).level;
    const claimedKeys = new Set(claimsByUser.get(stat.userId) ?? []);
    const forfeitedQuotaPerkKeys = INVITE_QUOTA_PERKS.filter(
      (perk) =>
        claimedKeys.has(perk.key) &&
        levelBefore >= perk.unlockLevel &&
        levelAfter < perk.unlockLevel,
    ).map((perk) => perk.key);

    rows.push({
      userId: stat.userId,
      storedXp: stat.xp,
      recomputedXp,
      levelBefore,
      levelAfter,
      forfeitedQuotaPerkKeys,
    });
  }
  return rows;
}

function printReport(rows: MemberRebaseRow[], isApplying: boolean): void {
  const heading = isApplying
    ? 'Applying XP rebase (PRD-05)'
    : 'XP rebase report (PRD-05) — READ ONLY, nothing written';
  console.log(`\n${heading}\n${'='.repeat(heading.length)}\n`);

  if (rows.length === 0) {
    console.log(
      'No member is holding XP above what the current rules award. Nothing to do.\n',
    );
    return;
  }

  const losingALevel = rows.filter((row) => row.levelAfter < row.levelBefore);
  const losingInvites = rows.filter(
    (row) => row.forfeitedQuotaPerkKeys.length > 0,
  );
  const totalDelta = rows.reduce(
    (sum, row) => sum + (row.storedXp - row.recomputedXp),
    0,
  );

  for (const row of rows) {
    const delta = row.storedXp - row.recomputedXp;
    const level =
      row.levelAfter < row.levelBefore
        ? `  level ${row.levelBefore} -> ${row.levelAfter}`
        : `  level ${row.levelBefore} (unchanged)`;
    const invites =
      row.forfeitedQuotaPerkKeys.length > 0
        ? `  FORFEITS CLAIMED INVITE PERK: ${row.forfeitedQuotaPerkKeys.join(', ')}`
        : '';
    console.log(
      `${row.userId}  ${row.storedXp} -> ${row.recomputedXp}  (-${delta})${level}${invites}`,
    );
  }

  console.log(
    [
      '',
      `Members affected:              ${rows.length}`,
      `Members dropping a level:      ${losingALevel.length}`,
      `Members losing invite quota:   ${losingInvites.length}`,
      `Total XP removed:              ${totalDelta}`,
      '',
    ].join('\n'),
  );

  if (!isApplying) {
    console.log(
      `Nothing was written. Re-run with ${APPLY_FLAG} to perform the correction.\n`,
    );
  }
}

async function applyRebase(
  dataSource: DataSource,
  rows: MemberRebaseRow[],
): Promise<void> {
  for (const row of rows) {
    await dataSource.transaction(async (manager) => {
      // The same lock `recompute` takes, so a concurrent recompute for this
      // member serializes behind us instead of interleaving.
      await manager.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [row.userId],
      );

      // Re-read under the lock. A recompute that landed between the report and
      // now may have moved the total, and correcting against a stale figure
      // would write a delta that does not match what the member actually held.
      const [current] = await manager.query<{ xp: number | string }[]>(
        `SELECT xp FROM recognition_stats WHERE user_id = $1 FOR UPDATE`,
        [row.userId],
      );
      const storedNow = current ? Number(current.xp) : 0;
      if (storedNow <= row.recomputedXp) return;

      await manager.query(
        `UPDATE recognition_stats SET xp = $2, updated_at = now() WHERE user_id = $1`,
        [row.userId, row.recomputedXp],
      );
      await manager.getRepository(RecognitionLedgerEntry).insert({
        userId: row.userId,
        description:
          'Recognition rebalanced: points now come from activity a second person was part of',
        xp: row.recomputedXp - storedNow,
        reason: REBASE_REASON,
      });
    });
  }
  console.log(`Applied. ${rows.length} member(s) corrected.\n`);
}

async function main(): Promise<void> {
  const isApplying = process.argv.includes(APPLY_FLAG);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    // `strict: false` searches the whole container: `RecognitionModule` does
    // not export `RecognitionAwardingService`, and widening its public surface
    // for a maintenance CLI would be the wrong trade.
    const awarding = app.get(RecognitionAwardingService, { strict: false });
    const dataSource = app.get(DataSource, { strict: false });
    const rows = await buildReport(awarding, dataSource);
    printReport(rows, isApplying);
    if (isApplying && rows.length > 0) {
      await applyRebase(dataSource, rows);
    }
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
