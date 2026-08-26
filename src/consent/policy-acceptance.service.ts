import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    @InjectRepository(PolicyAcceptance)
    private readonly acceptances: Repository<PolicyAcceptance>,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Record that `userId` has agreed to the policy revisions CURRENTLY in effect.
   *
   * Two writes, in this order and deliberately not in a transaction:
   *   1. the member's `users` row moves forward, which is what the gate reads
   *      and therefore what stops re-prompting them;
   *   2. an append-only `policy_acceptance` row preserves the dated before/after
   *      pair, which is what makes the agreement evidence rather than a cell.
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
    const stamp = await this.usersService.recordPolicyAcceptance(userId, {
      termsVersion: CURRENT_TERMS_VERSION,
      guidelinesVersion: CURRENT_GUIDELINES_VERSION,
    });

    await this.acceptances.save(
      this.acceptances.create({
        userId,
        termsVersion: stamp.termsVersion,
        guidelinesVersion: stamp.guidelinesVersion,
        previousTermsVersion: stamp.previousTermsVersion,
        previousGuidelinesVersion: stamp.previousGuidelinesVersion,
        source,
      }),
    );

    return {
      termsVersion: stamp.termsVersion,
      guidelinesVersion: stamp.guidelinesVersion,
      previousTermsVersion: stamp.previousTermsVersion,
      previousGuidelinesVersion: stamp.previousGuidelinesVersion,
      acceptedAt: stamp.acceptedAt.toISOString(),
    };
  }
}
