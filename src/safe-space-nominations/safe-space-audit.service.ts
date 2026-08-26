import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SafeSpaceDecisionAudit,
  type SafeSpaceAuditSubjectType,
} from './entities/safe-space-decision-audit.entity';

/** The stable action codes written to the safe-space audit trail. */
export const SafeSpaceAuditAction = {
  NominationAcknowledged: 'nomination_acknowledged',
  NominationAssigned: 'nomination_assigned',
  NominationAwarded: 'nomination_awarded',
  NominationDeclined: 'nomination_declined',
  NominationReopened: 'nomination_reopened',
  FlagRaised: 'flag_raised',
  FlagWithdrawn: 'flag_withdrawn',
  FlagResolved: 'flag_resolved',
  BadgeSuspended: 'badge_suspended',
  BadgeRestored: 'badge_restored',
} as const;

export type SafeSpaceAuditActionCode =
  (typeof SafeSpaceAuditAction)[keyof typeof SafeSpaceAuditAction];

export interface RecordAuditInput {
  subjectType: SafeSpaceAuditSubjectType;
  subjectId: string;
  action: SafeSpaceAuditActionCode;
  /** Null when the platform acted rather than a person (a flag threshold
   * crossing, a scheduled sweep). */
  actorId?: string | null;
  listingId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes the append-only trail behind every safe-space decision: who, when,
 * why. Nothing in this domain updates or deletes a row here.
 *
 * Kept as its own tiny provider rather than a method on each service so that
 * "was this audited?" is answerable by grepping one call, and so a service can
 * be unit-tested with an audit double that asserts the trail was written.
 */
@Injectable()
export class SafeSpaceAuditService {
  constructor(
    @InjectRepository(SafeSpaceDecisionAudit)
    private readonly audits: Repository<SafeSpaceDecisionAudit>,
  ) {}

  async record(input: RecordAuditInput): Promise<void> {
    // `save(create(...))` rather than `insert(...)`: TypeORM's insert signature
    // narrows a jsonb column to `QueryDeepPartialEntity`, which cannot accept an
    // open `Record<string, unknown>`. `create` takes a `DeepPartial`, so the
    // metadata blob passes through with its real type intact.
    await this.audits.save(
      this.audits.create({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        action: input.action,
        actorId: input.actorId ?? null,
        listingId: input.listingId ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? {},
      }),
    );
  }

  /** The trail for one subject, newest first. Moderator-guarded at the route. */
  async listForSubject(
    subjectType: SafeSpaceAuditSubjectType,
    subjectId: string,
  ): Promise<SafeSpaceDecisionAudit[]> {
    return this.audits.find({
      where: { subjectType, subjectId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  /** Everything ever done to one business's badge, newest first. */
  async listForListing(listingId: string): Promise<SafeSpaceDecisionAudit[]> {
    return this.audits.find({
      where: { listingId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }
}
