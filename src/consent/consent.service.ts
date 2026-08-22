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

@Injectable()
export class ConsentService {
  constructor(
    @InjectRepository(ConsentRecord)
    private readonly records: Repository<ConsentRecord>,
  ) {}

  // Append-only: every call inserts a NEW row. `action` is derived by comparing
  // the incoming decision to the caller's most-recent prior record:
  //   - no prior record            → 'granted'
  //   - a category flipped true→false (analytics or monitoring withdrawn)
  //                                → 'withdrawn'
  //   - otherwise (first time on, unchanged, or broadened)
  //                                → 'updated'
  async record(userId: string, dto: ConsentDto): Promise<ConsentRecordDTO> {
    const prior = await this.latest(userId);

    // A re-post of the decision already on file (same categories, same policy
    // version) adds nothing to the audit trail, so echo the stored record
    // instead of appending a duplicate row. Anything that differs is a fresh
    // decision and is still appended: a category flip, or the same categories
    // re-affirmed against a NEW policy version.
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
        policyVersion: dto.policyVersion,
        source: dto.source,
        action,
      }),
    );

    return toConsentRecordDTO(saved);
  }

  // Current effective consent = the caller's latest record. Falls back to a
  // safe default (everything off except `necessary`) pinned to the incoming
  // request's policy version when the caller has never consented.
  async myConsent(
    userId: string,
    fallbackPolicyVersion: string,
  ): Promise<MyConsentResponse> {
    const latest = await this.latest(userId);
    if (!latest) {
      return {
        categories: { necessary: true, analytics: false, monitoring: false },
        policyVersion: fallbackPolicyVersion,
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

  // Narrowing helper: true only when `prior` exists and records exactly the
  // decision `dto` is asking to store.
  private isUnchanged(
    prior: ConsentRecord | null,
    dto: ConsentDto,
  ): prior is ConsentRecord {
    return (
      prior !== null &&
      prior.analytics === dto.categories.analytics &&
      prior.monitoring === dto.categories.monitoring &&
      prior.policyVersion === dto.policyVersion
    );
  }

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
