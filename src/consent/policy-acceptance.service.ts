import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsersService } from '../users/users.service';
import {
  PolicyAcceptance,
  PolicyAcceptanceSource,
} from './entities/policy-acceptance.entity';
import {
  CURRENT_GUIDELINES_VERSION,
  CURRENT_TERMS_VERSION,
} from './policy-versions';

/** The wire shape of a recorded acceptance (`POST /consent/policy-acceptance`). */
export interface PolicyAcceptanceDTO {
  termsVersion: string;
  guidelinesVersion: string;
  previousTermsVersion: string | null;
  previousGuidelinesVersion: string | null;
  acceptedAt: string;
}

@Injectable()
export class PolicyAcceptanceService {
  constructor(
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Record that `userId` has agreed to the policy revisions CURRENTLY in effect.
   *
   * Two writes, in ONE transaction:
   *   1. the member's `users` row moves forward, which is what the gate reads
   *      and therefore what stops re-prompting them;
   *   2. an append-only `policy_acceptance` row preserves the dated before/after
   *      pair, which is what makes the agreement evidence rather than a cell.
   *
   * They commit together because the failure mode of splitting them is silent
   * and permanent: if the stamp lands and the ledger row does not, the member
   * shows as having agreed to a revision that no evidence row records, and the
   * gate never re-prompts them, so nothing ever surfaces the discrepancy. The
   * reverse split is just as bad in an audit. Either both land or neither does,
   * and the member is re-prompted on their next request.
   *
   * The versions are read from the SERVER's constants and never from a request
   * body. A member cannot be asked to agree to a revision the platform is not
   * actually serving, and a client cannot stamp itself up to date by posting a
   * version string it made up. The frontend still displays the versions it read
   * from `/auth/me`, so the two agree in every non-adversarial case; if a bump
   * lands between the render and the click, the member is simply recorded
   * against the newer one and the sheet does not re-open.
   *
   * Idempotent in effect: a second call from a member who is already current
   * re-stamps the same versions and appends a second row whose previous/new
   * pair are equal. Harmless, honest, and throttled at the controller.
   */
  async accept(
    userId: string,
    source: PolicyAcceptanceSource = PolicyAcceptanceSource.Reacceptance,
  ): Promise<PolicyAcceptanceDTO> {
    const stamp = await this.dataSource.transaction(async (manager) => {
      const recorded = await this.usersService.recordPolicyAcceptance(
        userId,
        {
          termsVersion: CURRENT_TERMS_VERSION,
          guidelinesVersion: CURRENT_GUIDELINES_VERSION,
        },
        manager,
      );

      await manager.save(
        manager.create(PolicyAcceptance, {
          userId,
          termsVersion: recorded.termsVersion,
          guidelinesVersion: recorded.guidelinesVersion,
          previousTermsVersion: recorded.previousTermsVersion,
          previousGuidelinesVersion: recorded.previousGuidelinesVersion,
          source,
        }),
      );

      return recorded;
    });

    return {
      termsVersion: stamp.termsVersion,
      guidelinesVersion: stamp.guidelinesVersion,
      previousTermsVersion: stamp.previousTermsVersion,
      previousGuidelinesVersion: stamp.previousGuidelinesVersion,
      acceptedAt: stamp.acceptedAt.toISOString(),
    };
  }
}
