import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionLedgerEntry } from './entities/recognition-ledger-entry.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import {
  buildPerks,
  buildRecognition,
  computeLevel,
  PerksDTO,
  RecognitionDTO,
} from './recognition-response';
import {
  BADGE_CATALOG,
  DEFAULT_INVITE_MONTHLY_QUOTA,
  SEASONAL_BADGE_CATALOG,
  levelName,
  perkByKey,
} from './recognition.catalog';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { ProfilesService } from '../profiles/profiles.service';

/**
 * `POST /me/recognition/perks/:key/claim`. Carries the claim itself plus the
 * rebuilt perks block, so the perks page can re-bucket the card into "Already
 * claimed" from the response it already has instead of racing a refetch.
 */
export interface PerkClaimDTO {
  key: string;
  state: 'claimed';
  claimedAt: string;
  perks: PerksDTO;
}

/** `PATCH /me/recognition/badges/:key/visibility`. */
export interface BadgeVisibilityDTO {
  key: string;
  hiddenFromProfile: boolean;
}

@Injectable()
export class RecognitionService {
  constructor(
    @InjectRepository(RecognitionStat)
    private readonly stats: Repository<RecognitionStat>,
    @InjectRepository(RecognitionAward)
    private readonly awards: Repository<RecognitionAward>,
    @InjectRepository(RecognitionPerkClaim)
    private readonly perkClaims: Repository<RecognitionPerkClaim>,
    @InjectRepository(RecognitionLedgerEntry)
    private readonly ledgerEntries: Repository<RecognitionLedgerEntry>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly awarding: RecognitionAwardingService,
    private readonly profilesService: ProfilesService,
    private readonly config: ConfigService,
  ) {}

  /** The monthly invite allowance this deployment enforces before any
   *  recognition bonus. Read from the same config key `InvitesService` reads,
   *  so the perk copy can never advertise a number the enforcement path would
   *  not produce. */
  private baseInviteQuota(): number {
    return this.config.get<number>(
      'app.inviteMonthlyQuota',
      DEFAULT_INVITE_MONTHLY_QUOTA,
    );
  }

  /**
   * `GET /me/recognition` (own recognition, `includePerks = true`) and the
   * resolved target of `getBySlug` (another member's recognition,
   * `includePerks = false`).
   *
   * FE contract (`recognition.api.ts:86-88`): perks are "omitted for
   * non-owners" — another member's claimed-perk dates and available-perk
   * state are private (I9). When `includePerks` is false we skip the
   * perk-claims query entirely (no need to fetch data we're about to
   * discard) and return an empty `PerksDTO` rather than the real one.
   */
  async getForUser(
    userId: string,
    includePerks = true,
  ): Promise<RecognitionDTO> {
    const [stat, earned, claimed, signals, ledgerRows] = await Promise.all([
      this.stats.findOne({ where: { userId } }),
      this.awards.find({ where: { userId }, take: DEFAULT_LIST_LIMIT }),
      includePerks
        ? this.perkClaims.find({ where: { userId }, take: DEFAULT_LIST_LIMIT })
        : Promise.resolve([]),
      // The XP breakdown is owner-only, same as perks (I9) — skip the
      // signal-gathering queries entirely for another member's view.
      includePerks ? this.awarding.gatherSignalsForUser(userId) : null,
      // The XP ledger is owner-only too (same reasoning as xpBreakdown) —
      // skip the query for a non-owner view.
      includePerks
        ? this.ledgerEntries.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            take: DEFAULT_LIST_LIMIT,
          })
        : Promise.resolve([]),
    ]);
    const dto = buildRecognition(
      stat?.xp ?? 0,
      earned.map((award) => ({
        badgeKey: award.badgeKey,
        context: award.context,
        hiddenFromProfile: award.hiddenFromProfile,
      })),
      claimed.map((c) => ({ perkKey: c.perkKey, claimedAt: c.claimedAt })),
      signals,
      ledgerRows.map((row) => ({
        description: row.description,
        xp: row.xp,
        reason: row.reason,
        createdAt: row.createdAt,
      })),
      // `includePerks` is the owner/non-owner switch everywhere else in this
      // method, so it is the switch for hidden badges too: a hidden badge is
      // returned (flagged) to its owner and omitted from anyone else's read.
      { baseInviteQuota: this.baseInviteQuota(), isOwnerView: includePerks },
    );
    if (!includePerks) {
      dto.perks = { availableCount: 0, groups: [], ladder: [] };
    }
    return dto;
  }

  /**
   * Another member's recognition (`GET /profiles/:slug/recognition`).
   * Resolves `slug` -> `userId` through `ProfilesService.findBySlugOrThrow`,
   * which applies the same block / hidden-from / self-hide / moderator-takedown
   * gates the profile read uses (L10): a viewer who cannot see the profile
   * gets an identical 404 here instead of the member's badges/level. Then
   * delegates with `includePerks = false` so perk state is never leaked to a
   * non-owner (I9).
   */
  async getBySlug(
    slug: string,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<RecognitionDTO> {
    const profile = await this.profilesService.findBySlugOrThrow(
      slug,
      viewerUserId,
      viewerRole,
    );
    return this.getForUser(profile.userId, false);
  }

  /**
   * `POST /me/recognition/perks/:key/claim` (SUS-04). The perks page could
   * never write anything before this: the controller was GET-only, so
   * `recognition_perk_claims` was an unreachable table and the frontend had to
   * refuse to show a "claimed" state in live mode.
   *
   * Three properties matter here.
   *
   *   1. THE LEVEL IS COMPUTED HERE. It comes from this member's stored XP via
   *      `computeLevel`, never from anything the client sent, and a claim
   *      below `unlockLevel` is a 403 naming the level required.
   *   2. IT IS IDEMPOTENT AND CONCURRENCY-SAFE. The insert is
   *      `ON CONFLICT DO NOTHING` against
   *      `UQ_recognition_perk_claims_user_perk`, and the row is then read back
   *      unconditionally. Two simultaneous claims therefore produce one row and
   *      two identical successful responses, with no unique-violation escaping
   *      as a 500.
   *   3. IT GRANTS SOMETHING. `RecognitionEntitlementsService` reads these rows
   *      and `InvitesService.resolveMonthlyLimit` adds the resulting bonus to
   *      the member's monthly invite allowance.
   */
  async claimPerk(userId: string, perkKey: string): Promise<PerkClaimDTO> {
    const perk = perkByKey(perkKey);
    if (!perk) {
      throw new NotFoundException('No perk with that key');
    }

    const stat = await this.stats.findOne({ where: { userId } });
    const totalXp = stat?.xp ?? 0;
    const level = computeLevel(totalXp).level;
    if (level < perk.unlockLevel) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        // Typed, like `INVITE_QUOTA_EXCEEDED` in `invites.service.ts`, so the
        // frontend never has to regex an English sentence to tell this refusal
        // apart from a session problem.
        code: 'PERK_LEVEL_NOT_REACHED',
        message: `This perk unlocks at Level ${perk.unlockLevel} · ${levelName(
          perk.unlockLevel,
        )}.`,
      });
    }

    await this.perkClaims
      .createQueryBuilder()
      .insert()
      .into(RecognitionPerkClaim)
      .values({ userId, perkKey: perk.key })
      .orIgnore()
      .execute();

    // Read back rather than trusting the insert result: on the losing side of
    // a concurrent claim `orIgnore` inserts nothing and returns no identifier,
    // and the answer we owe the caller is the row that DOES exist.
    const claim = await this.perkClaims.findOne({
      where: { userId, perkKey: perk.key },
    });
    if (!claim) {
      // Only reachable if the row vanished between the insert and this read.
      throw new NotFoundException('Perk claim could not be read back');
    }

    const claims = await this.perkClaims.find({
      where: { userId },
      take: DEFAULT_LIST_LIMIT,
    });
    return {
      key: perk.key,
      state: 'claimed',
      claimedAt: claim.claimedAt.toISOString(),
      perks: buildPerks(
        level,
        totalXp,
        claims.map((row) => ({
          perkKey: row.perkKey,
          claimedAt: row.claimedAt,
        })),
        this.baseInviteQuota(),
      ),
    };
  }

  /**
   * `PATCH /me/recognition/badges/:key/visibility` (SUS-04): hide one earned
   * badge from how other members see this member, or show it again.
   *
   * Only a badge the caller has actually EARNED can be toggled — the update is
   * scoped to their own award row, so the key in the path can neither reach
   * another member's row nor create one.
   */
  async setBadgeVisibility(
    userId: string,
    badgeKey: string,
    hiddenFromProfile: boolean,
  ): Promise<BadgeVisibilityDTO> {
    const isKnownBadge =
      BADGE_CATALOG.some((def) => def.key === badgeKey) ||
      SEASONAL_BADGE_CATALOG.some((def) => def.key === badgeKey);
    if (!isKnownBadge) {
      throw new NotFoundException('No badge with that key');
    }
    const result = await this.awards.update(
      { userId, badgeKey },
      { hiddenFromProfile },
    );
    // `!affected` rather than `=== 0`: a driver that omits the count must not
    // be read as a silent success on a badge the caller never earned.
    if (!result.affected) {
      throw new NotFoundException('You have not earned that badge');
    }
    return { key: badgeKey, hiddenFromProfile };
  }
}
