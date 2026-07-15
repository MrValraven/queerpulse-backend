import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { buildRecognition, RecognitionDTO } from './recognition-response';

@Injectable()
export class RecognitionService {
  constructor(
    @InjectRepository(RecognitionStat)
    private readonly stats: Repository<RecognitionStat>,
    @InjectRepository(RecognitionAward)
    private readonly awards: Repository<RecognitionAward>,
    @InjectRepository(RecognitionPerkClaim)
    private readonly perkClaims: Repository<RecognitionPerkClaim>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

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
    const [stat, earned, claimed] = await Promise.all([
      this.stats.findOne({ where: { userId } }),
      this.awards.find({ where: { userId } }),
      includePerks
        ? this.perkClaims.find({ where: { userId } })
        : Promise.resolve([]),
    ]);
    const dto = buildRecognition(
      stat?.xp ?? 0,
      earned.map((a) => ({ badgeKey: a.badgeKey, context: a.context })),
      claimed.map((c) => ({ perkKey: c.perkKey, claimedAt: c.claimedAt })),
    );
    if (!includePerks) {
      dto.perks = { availableCount: 0, groups: [], ladder: [] };
    }
    return dto;
  }

  /**
   * Another member's recognition (`GET /profiles/:slug/recognition`).
   * Resolves `slug` -> `userId`, then delegates with `includePerks = false`
   * so perk state is never leaked to a non-owner (I9).
   */
  async getBySlug(slug: string): Promise<RecognitionDTO> {
    const profile = await this.profiles.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return this.getForUser(profile.userId, false);
  }
}
