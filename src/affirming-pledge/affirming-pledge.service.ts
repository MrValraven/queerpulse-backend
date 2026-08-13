import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

/**
 * Machine-readable code the frontend keys the affirming-pledge prompt off.
 * Emitted in the 403 body from `requireAccepted` (mirrors
 * `VerificationService`'s `VERIFICATION_REQUIRED` seam), so any gated housing
 * mutation the client makes can catch it, open the pledge modal, and retry.
 */
export const AFFIRMING_PLEDGE_REQUIRED_CODE = 'AFFIRMING_PLEDGE_REQUIRED';

/**
 * The pledge revision in force. Bumping it does NOT re-prompt existing
 * acceptors today (we store only the acceptance timestamp, not a version) —
 * it is surfaced so the frontend copy and a future re-consent flow have a
 * single source of truth. Keep in lockstep with the frontend constant.
 */
export const CURRENT_AFFIRMING_PLEDGE_VERSION = '1.0';

/** The caller's affirming-pledge standing, hand-mapped to the wire shape. */
export interface AffirmingPledgeStatusDTO {
  accepted: boolean;
  acceptedAt: string | null;
  version: string;
}

/**
 * Owns the LGBTQ+ affirming housing pledge — the mandatory universal baseline
 * every housing write/contact surface gates on. This is NOT an identity filter:
 * it gates participation on accepting an enforceable community code of conduct
 * (legal), never on who a member is (illegal under EU fair-housing law).
 *
 * The acceptance is a member-level stamp on `users.affirming_pledge_accepted_at`
 * — accept once, applies everywhere. Reading/browsing is never gated; only the
 * WRITE + CONTACT actions call `requireAccepted`, exactly like the verification
 * step-up gates it sits alongside.
 */
@Injectable()
export class AffirmingPledgeService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  /** The caller's current pledge standing (folded into housing-context reads). */
  async getStatus(userId: string): Promise<AffirmingPledgeStatusDTO> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, affirmingPledgeAcceptedAt: true },
    });
    if (!user) {
      throw new NotFoundException('Member not found');
    }
    return this.toStatus(user.affirmingPledgeAcceptedAt);
  }

  /** True when the member has the pledge on record. */
  async hasAccepted(userId: string): Promise<boolean> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, affirmingPledgeAcceptedAt: true },
    });
    return Boolean(user?.affirmingPledgeAcceptedAt);
  }

  /**
   * Records acceptance. Idempotent and stamp-once: a member who has already
   * accepted keeps their original timestamp (re-accepting is a no-op), so the
   * record always reflects when they FIRST committed.
   */
  async accept(userId: string): Promise<AffirmingPledgeStatusDTO> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, affirmingPledgeAcceptedAt: true },
    });
    if (!user) {
      throw new NotFoundException('Member not found');
    }
    if (!user.affirmingPledgeAcceptedAt) {
      await this.users.update(
        { id: userId },
        { affirmingPledgeAcceptedAt: new Date() },
      );
      return this.toStatus(new Date());
    }
    return this.toStatus(user.affirmingPledgeAcceptedAt);
  }

  /**
   * Gate a housing write/contact action on the affirming pledge. Throws a typed
   * 403 (`code: AFFIRMING_PLEDGE_REQUIRED`) the frontend turns into the pledge
   * prompt, then retries the original action once accepted. A no-op for a member
   * who has already accepted.
   */
  async requireAccepted(userId: string): Promise<void> {
    const accepted = await this.hasAccepted(userId);
    if (!accepted) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message:
          'This needs the LGBTQ+ affirming housing pledge to be accepted first',
        code: AFFIRMING_PLEDGE_REQUIRED_CODE,
      });
    }
  }

  private toStatus(acceptedAt: Date | null): AffirmingPledgeStatusDTO {
    return {
      accepted: Boolean(acceptedAt),
      acceptedAt: acceptedAt?.toISOString() ?? null,
      version: CURRENT_AFFIRMING_PLEDGE_VERSION,
    };
  }
}
