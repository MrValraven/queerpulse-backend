import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  type FeatureKey,
  earlyAccessFeatureKeys,
  isFeatureKey,
  isInEarlyAccess,
} from '../launchedFeatures';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  EARLY_ACCESS_AUDIT_ACTIONS,
  EARLY_ACCESS_ROSTER_LIMIT,
} from './early-access.constants';
import {
  type EarlyAccessFeaturesResponse,
  type EarlyAccessGrantResponse,
  type EarlyAccessRosterProfile,
  type EarlyAccessRosterResponse,
  type MemberEarlyAccessResponse,
  toEarlyAccessGrantResponse,
  toEarlyAccessRosterRow,
} from './early-access-response';
import { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';

/** $1 feature keys. One row per key holding at least one grant. */
export const EARLY_ACCESS_GRANT_COUNTS_SQL = `
  SELECT "feature_key", COUNT(*)::int AS "grant_count"
  FROM "feature_early_access_grants"
  WHERE "feature_key" = ANY($1::varchar[])
  GROUP BY "feature_key"
`;

/**
 * Admin early-access grants: the member drawer's toggles and the roster page.
 * One row per (member, feature); the row is the grant. Grant and revoke are
 * idempotent, and each writes its `mod_audit_logs` row (member as
 * `targetUserId`, feature key as `note`) in the same transaction as the change
 * it records, only when something changed. Only features currently in early
 * access (`isInEarlyAccess`) are addressable; any other key answers 404.
 */
@Injectable()
export class EarlyAccessAdminService {
  constructor(
    @InjectRepository(FeatureEarlyAccessGrant)
    private readonly grants: Repository<FeatureEarlyAccessGrant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly modAudit: ModAuditService,
  ) {}

  assertFeatureInEarlyAccess(featureKeyParam: string): FeatureKey {
    if (!isFeatureKey(featureKeyParam) || !isInEarlyAccess(featureKeyParam)) {
      throw new NotFoundException('Early access feature not found.');
    }
    return featureKeyParam;
  }

  async assertMemberExists(memberId: string): Promise<void> {
    const doesMemberExist = await this.users.exists({
      where: { id: memberId },
    });
    if (!doesMemberExist) {
      throw new NotFoundException('Member not found');
    }
  }

  async listForMember(memberId: string): Promise<MemberEarlyAccessResponse> {
    await this.assertMemberExists(memberId);
    const featureKeys = earlyAccessFeatureKeys();
    const memberGrants = featureKeys.length
      ? await this.grants.find({
          where: { userId: memberId, featureKey: In(featureKeys) },
        })
      : [];
    const granterNames = await this.modAudit.namesForUserIds(
      memberGrants.flatMap((grant) =>
        grant.grantedById ? [grant.grantedById] : [],
      ),
    );
    const grantsByFeatureKey = new Map(
      memberGrants.map((grant) => [grant.featureKey, grant]),
    );
    return {
      features: featureKeys.map((featureKey) => {
        const grant = grantsByFeatureKey.get(featureKey);
        return {
          featureKey,
          grant: grant
            ? toEarlyAccessGrantResponse(
                grant,
                this.modAudit.resolveActorName(grant.grantedById, granterNames),
              )
            : null,
        };
      }),
    };
  }

  async grant(
    actorId: string,
    memberId: string,
    featureKeyParam: string,
  ): Promise<EarlyAccessGrantResponse> {
    const featureKey = this.assertFeatureInEarlyAccess(featureKeyParam);
    await this.assertMemberExists(memberId);
    await this.grants.manager.transaction(async (manager) => {
      const insertResult = await manager
        .createQueryBuilder()
        .insert()
        .into(FeatureEarlyAccessGrant)
        .values({ userId: memberId, featureKey, grantedById: actorId })
        .orIgnore()
        .returning(['id'])
        .execute();
      const isNewGrant = (insertResult.raw as unknown[]).length > 0;
      if (isNewGrant) {
        await this.modAudit.writeAuditLog(
          null,
          actorId,
          EARLY_ACCESS_AUDIT_ACTIONS.granted,
          undefined,
          featureKey,
          undefined,
          manager,
          memberId,
        );
      }
    });
    const grant = await this.grants.findOne({
      where: { userId: memberId, featureKey },
    });
    if (!grant) {
      throw new NotFoundException('Member not found');
    }
    return toEarlyAccessGrantResponse(
      grant,
      await this.modAudit.nameForUserId(grant.grantedById),
    );
  }

  async revoke(
    actorId: string,
    memberId: string,
    featureKeyParam: string,
  ): Promise<void> {
    const featureKey = this.assertFeatureInEarlyAccess(featureKeyParam);
    await this.assertMemberExists(memberId);
    await this.grants.manager.transaction(async (manager) => {
      const deleteResult = await manager.delete(FeatureEarlyAccessGrant, {
        userId: memberId,
        featureKey,
      });
      if ((deleteResult.affected ?? 0) > 0) {
        await this.modAudit.writeAuditLog(
          null,
          actorId,
          EARLY_ACCESS_AUDIT_ACTIONS.revoked,
          undefined,
          featureKey,
          undefined,
          manager,
          memberId,
        );
      }
    });
  }

  async listFeatures(): Promise<EarlyAccessFeaturesResponse> {
    const featureKeys = earlyAccessFeatureKeys();
    const countRows: { feature_key: string; grant_count: number }[] =
      featureKeys.length
        ? await this.grants.manager.query(EARLY_ACCESS_GRANT_COUNTS_SQL, [
            featureKeys,
          ])
        : [];
    const grantCountsByFeatureKey = new Map(
      countRows.map((countRow) => [
        countRow.feature_key,
        Number(countRow.grant_count),
      ]),
    );
    return {
      features: featureKeys.map((featureKey) => ({
        featureKey,
        grantCount: grantCountsByFeatureKey.get(featureKey) ?? 0,
      })),
    };
  }

  async roster(featureKeyParam: string): Promise<EarlyAccessRosterResponse> {
    const featureKey = this.assertFeatureInEarlyAccess(featureKeyParam);
    const [featureGrants, total] = await this.grants.findAndCount({
      where: { featureKey },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: EARLY_ACCESS_ROSTER_LIMIT,
    });
    const memberIds = featureGrants.map((grant) => grant.userId);
    const [memberProfiles, granterNames] = await Promise.all([
      memberIds.length
        ? this.profiles.find({
            where: { userId: In(memberIds) },
            select: {
              userId: true,
              slug: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              photoVisible: true,
            },
          })
        : Promise.resolve([]),
      this.modAudit.namesForUserIds(
        featureGrants.flatMap((grant) =>
          grant.grantedById ? [grant.grantedById] : [],
        ),
      ),
    ]);
    const profilesByUserId = new Map<string, EarlyAccessRosterProfile>(
      memberProfiles.map((memberProfile) => [
        memberProfile.userId,
        memberProfile,
      ]),
    );
    return {
      featureKey,
      total,
      limit: EARLY_ACCESS_ROSTER_LIMIT,
      items: featureGrants.map((grant) =>
        toEarlyAccessRosterRow(
          grant,
          profilesByUserId.get(grant.userId) ?? null,
          this.modAudit.resolveActorName(grant.grantedById, granterNames),
        ),
      ),
    };
  }
}
