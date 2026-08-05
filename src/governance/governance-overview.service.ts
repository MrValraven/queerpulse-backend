import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  GovernanceOverviewResponseDTO,
  GovernancePublishResponseDTO,
  toGovernanceOverviewResponse,
} from './governance-overview-response';
import {
  GOVERNANCE_OVERVIEW_ID,
  GovernanceOverview,
} from './entities/governance-overview.entity';

@Injectable()
export class GovernanceOverviewService {
  constructor(
    @InjectRepository(GovernanceOverview)
    private readonly overview: Repository<GovernanceOverview>,
  ) {}

  // The Governance page's non-financial structure (health snapshot, moderation
  // steps, advisory council, principles, decision log). A singleton row keyed
  // on `GOVERNANCE_OVERVIEW_ID` — the lookup carries a `where`, so it never
  // hits the bare-`findOne` "you must provide selection conditions" error.
  async getOverview(): Promise<GovernanceOverviewResponseDTO> {
    const overview = await this.overview.findOne({
      where: { id: GOVERNANCE_OVERVIEW_ID },
    });

    if (!overview) {
      throw new NotFoundException('Governance overview not found');
    }
    return toGovernanceOverviewResponse(overview);
  }

  // POST /governance/admin/publish (P3-7) — mark the current singleton snapshot
  // as published *now*, so the public `GET /governance/overview` can surface a
  // "last published" line. Idempotent in intent (re-publishing simply advances
  // the timestamp to the latest deliberate act); mirrors the seeded-singleton
  // model — there is exactly one row to stamp.
  async publish(): Promise<GovernancePublishResponseDTO> {
    const overview = await this.overview.findOne({
      where: { id: GOVERNANCE_OVERVIEW_ID },
    });
    if (!overview) {
      throw new NotFoundException('Governance overview not found');
    }
    overview.publishedAt = new Date();
    await this.overview.save(overview);
    return { publishedAt: overview.publishedAt.toISOString() };
  }
}
