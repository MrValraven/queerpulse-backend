import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConsentRecordDTO,
  MyConsentResponse,
  toConsentRecordDTO,
  toMyConsentResponse,
} from './consent-response';
import { ConsentDto } from './dto/consent.dto';
import { ConsentAction, ConsentRecord } from './entities/consent-record.entity';
import { CURRENT_PRIVACY_POLICY_VERSION } from './policy-versions';

@Injectable()
export class ConsentService {
  constructor(
    @InjectRepository(ConsentRecord)
    private readonly records: Repository<ConsentRecord>,
  ) {}

  /**
   * Append-only: every call inserts a NEW row. `action` is derived by comparing
   * the incoming decision to the caller's most-recent prior record:
   *   - no prior record            → 'granted'
   *   - a category flipped true→false (analytics or monitoring withdrawn)
   *                                → 'withdrawn'
   *   - otherwise (first time on, unchanged, or broadened)
   *                                → 'updated'
   *
   * The `policyVersion` stamped on the row is ALWAYS the server's
   * `CURRENT_PRIVACY_POLICY_VERSION`, and never `dto.policyVersion` (ENG-23).
   * `consent_record` is the GDPR evidence trail, and the version on a row exists
   * to answer one question: which revision of the privacy policy was in effect
   * when this person made this choice. An unattested string lifted off a request
   * body answers that with whatever the caller chose to send, so the row stops
   * being evidence and becomes a self-report. A member cannot have consented
   * against a revision the platform never published, and a client must not be
   * able to pin its own record to one. `PolicyAcceptanceService.accept` follows
   * the same rule and refuses a body outright for the same reason.
   *
   * The two body fields that DO survive are the categories and `anonId`, and
   * both are correct to take from the client: the categories are the decision
   * itself, which only the member can make, and `anonId` is the browser's own
   * pre-sign-in correlation id for a banner choice made before there was a
   * session to attach it to. Neither is a claim about what the platform is
   * serving, which is the only class of value this method now refuses.
   */
  async record(userId: string, dto: ConsentDto): Promise<ConsentRecordDTO> {
    const prior = await this.latest(userId);

    // A re-post of the decision already on file (same categories, already at
    // the revision in effect) adds nothing to the audit trail, so echo the
    // stored record instead of appending a duplicate row. Anything that differs
    // is a fresh decision and is still appended: a category flip, or the same
    // categories re-affirmed against a NEW policy version.
    if (this.isUnchanged(prior, dto)) {
      return toConsentRecordDTO(prior);
    }

    const action = this.deriveAction(prior, dto);

    const saved = await this.records.save(
      this.records.create({
        userId,
        anonId: dto.anonId ?? null,
        analytics: dto.categories.analytics,
        monitoring: dto.categories.monitoring,
        policyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        source: dto.source,
        action,
      }),
    );

    return toConsentRecordDTO(saved);
  }

  /**
   * Current effective consent = the caller's latest record. When the caller has
   * never consented there is no record to report, so this answers with the safe
   * default (everything off except `necessary`) pinned to the revision now in
   * effect.
   *
   * `publishedPolicyVersion` is that revision, handed in by `ConsentController`
   * from `consent.constants`, which re-exports
   * `CURRENT_PRIVACY_POLICY_VERSION`. It was already free of client input before
   * ENG-23 and stays a parameter, because the controller is where this
   * deployment's published revision is already read and threading it in keeps
   * `consent.constants` a live re-export with one honest caller instead of an
   * orphan. What changed is the name and this comment: the old ones described
   * the value as "the incoming request's policy version", which was never true
   * of the code and is precisely the misreading ENG-23 is about. Only a
   * published revision may be passed here.
   */
  async myConsent(
    userId: string,
    publishedPolicyVersion: string,
  ): Promise<MyConsentResponse> {
    const latest = await this.latest(userId);
    if (!latest) {
      return {
        categories: { necessary: true, analytics: false, monitoring: false },
        policyVersion: publishedPolicyVersion,
      };
    }
    return toMyConsentResponse(latest);
  }

  private latest(userId: string): Promise<ConsentRecord | null> {
    return this.records.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Narrowing helper: true only when `prior` exists and already records exactly
   * the row `record` is about to insert: the same two category flags, against
   * the policy revision now in effect.
   *
   * The version half compares `prior.policyVersion` to
   * `CURRENT_PRIVACY_POLICY_VERSION` rather than to `dto.policyVersion`, and it
   * has to: this predicate exists to describe the row that would actually be
   * written, and since ENG-23 that row carries the server constant. Comparing
   * against the body would break in both directions the first time a revision is
   * bumped. A stale client posting the old string at a member whose newest row
   * is already current would read as "changed" and append a pure duplicate. A
   * stale client posting the old string at a member whose newest row is equally
   * old would read as "unchanged", the insert would be skipped, and that member
   * would never get a row against the new revision, which is the single case
   * this whole comparison exists to let through, since re-affirming the same
   * categories against a NEW policy version is a fresh decision and must be
   * appended.
   */
  private isUnchanged(
    prior: ConsentRecord | null,
    dto: ConsentDto,
  ): prior is ConsentRecord {
    return (
      prior !== null &&
      prior.analytics === dto.categories.analytics &&
      prior.monitoring === dto.categories.monitoring &&
      prior.policyVersion === CURRENT_PRIVACY_POLICY_VERSION
    );
  }

  /**
   * The direction of the change, for the audit column. Reads the CATEGORY flags
   * only and no policy version at all, which is why ENG-23 left it alone: a
   * re-affirmation against a newer revision with nothing switched off is an
   * 'updated' row, exactly as it was when the version came from the body.
   */
  private deriveAction(
    prior: ConsentRecord | null,
    dto: ConsentDto,
  ): ConsentAction {
    if (!prior) return ConsentAction.Granted;

    const withdrew =
      (prior.analytics && !dto.categories.analytics) ||
      (prior.monitoring && !dto.categories.monitoring);

    return withdrew ? ConsentAction.Withdrawn : ConsentAction.Updated;
  }
}
