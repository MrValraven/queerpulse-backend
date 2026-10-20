import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FeatureKey } from '../launchedFeatures';
import {
  canViewerUseFeature,
  earlyAccessFeaturesForUser,
  usersWithFeatureAccess,
} from './early-access-reads';
import { FeatureEarlyAccessGrant } from './entities/feature-early-access-grant.entity';

/**
 * Per-member feature access for injected callers (guards, the session
 * payload, gateways). Each method delegates to `early-access-reads.ts`, which
 * answers launched and non-early-access features from the registry alone.
 */
@Injectable()
export class FeatureAccessService {
  constructor(
    @InjectRepository(FeatureEarlyAccessGrant)
    private readonly grants: Repository<FeatureEarlyAccessGrant>,
  ) {}

  canUseFeature(
    featureKey: FeatureKey,
    userId: string | null,
  ): Promise<boolean> {
    return canViewerUseFeature(this.grants.manager, featureKey, userId);
  }

  usersWithAccess(
    featureKey: FeatureKey,
    userIds: string[],
  ): Promise<string[]> {
    return usersWithFeatureAccess(this.grants.manager, featureKey, userIds);
  }

  earlyAccessFeaturesFor(userId: string): Promise<FeatureKey[]> {
    return earlyAccessFeaturesForUser(this.grants.manager, userId);
  }
}
