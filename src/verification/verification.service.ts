import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { StartPhoneVerificationDto } from './dto/start-phone-verification.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { MemberVerification } from './entities/member-verification.entity';
import {
  IDENTITY_VERIFICATION_PROVIDER,
  IdentityVerificationProvider,
} from './providers/identity-verification.provider';
import {
  PHONE_VERIFICATION_PROVIDER,
  PhoneVerificationProvider,
} from './providers/phone-verification.provider';
import {
  AdminVerificationDTO,
  toAdminVerificationDTO,
  toVerificationStatusDTO,
  VerificationStatusDTO,
} from './verification-response';
import { levelRank, meetsLevel, VerificationLevel } from './verification-level';

/**
 * Machine-readable code the frontend keys the step-up prompt off. Emitted in
 * the 403 body from `requireLevel`, alongside `requiredLevel`.
 */
export const VERIFICATION_REQUIRED_CODE = 'VERIFICATION_REQUIRED';

/**
 * Owns a member's identity-assurance level and the step-up flows that raise it.
 *
 * The email floor is IMPLICIT: sign-in is Google-only, so any account already
 * proves email control. `levelForUser` therefore resolves a member with no row
 * (or a seeded `email` row) to `email` without a write. Phone/ID are real
 * events that create/raise a row. The document check itself never touches this
 * service — it lives behind `IdentityVerificationProvider`.
 */
@Injectable()
export class VerificationService {
  constructor(
    @InjectRepository(MemberVerification)
    private readonly repo: Repository<MemberVerification>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @Inject(PHONE_VERIFICATION_PROVIDER)
    private readonly phoneProvider: PhoneVerificationProvider,
    @Inject(IDENTITY_VERIFICATION_PROVIDER)
    private readonly identityProvider: IdentityVerificationProvider,
  ) {}

  /** The member's current level (email floor when no explicit row exists). */
  async levelForUser(userId: string): Promise<VerificationLevel> {
    const row = await this.repo.findOne({ where: { userId } });
    return row?.level ?? VerificationLevel.Email;
  }

  /** Batched levels for a set of members (badge hydration). Missing rows resolve
   * to the email floor so every requested id is present in the map. */
  async levelsForUsers(
    userIds: string[],
  ): Promise<Map<string, VerificationLevel>> {
    const map = new Map<string, VerificationLevel>();
    if (!userIds.length) return map;
    const unique = [...new Set(userIds)];
    const rows = await this.repo.find({ where: { userId: In(unique) } });
    for (const row of rows) map.set(row.userId, row.level);
    for (const id of unique) {
      if (!map.has(id)) map.set(id, VerificationLevel.Email);
    }
    return map;
  }

  /**
   * Gate a high-risk action. Throws a typed 403 the frontend can turn into a
   * step-up prompt (`code: VERIFICATION_REQUIRED`, `requiredLevel`).
   */
  async requireLevel(
    userId: string,
    required: VerificationLevel,
  ): Promise<void> {
    const current = await this.levelForUser(userId);
    if (!meetsLevel(current, required)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'A higher verification level is needed for this',
        code: VERIFICATION_REQUIRED_CODE,
        requiredLevel: required,
        currentLevel: current,
      });
    }
  }

  async getStatus(userId: string): Promise<VerificationStatusDTO> {
    const row = await this.repo.findOne({ where: { userId } });
    return toVerificationStatusDTO(row?.level ?? VerificationLevel.Email, row);
  }

  // --- phone step-up ---

  async startPhone(
    userId: string,
    dto: StartPhoneVerificationDto,
  ): Promise<{ started: true }> {
    await this.phoneProvider.startChallenge(userId, dto.phoneNumber);
    return { started: true };
  }

  async verifyPhone(
    userId: string,
    dto: VerifyPhoneDto,
  ): Promise<VerificationStatusDTO> {
    const ok = await this.phoneProvider.checkChallenge(userId, dto.code);
    if (!ok) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'That code did not match — request a new one and try again',
        code: 'PHONE_CODE_INVALID',
      });
    }
    await this.raiseTo(
      userId,
      VerificationLevel.Phone,
      'phone_otp',
      'dev_phone',
    );
    return this.getStatus(userId);
  }

  // --- identity step-up ---

  async startIdentity(
    userId: string,
  ): Promise<{ redirectUrl: string; providerRef: string }> {
    const session = await this.identityProvider.createSession(userId);
    // Persist the pending ref on the member's row so the (later, possibly
    // unauthenticated) callback can map the result back to this member.
    const row = await this.loadOrCreate(userId);
    row.provider = this.identityProvider.name;
    row.providerRef = session.providerRef;
    await this.repo.save(row);
    return {
      redirectUrl: session.redirectUrl,
      providerRef: session.providerRef,
    };
  }

  /**
   * Provider callback (webhook seam). On success, elevate the member who owns
   * the `providerRef` to `id_verified`. Idempotent — a repeat callback is a
   * no-op once the member is already ID-verified.
   */
  async handleIdentityCallback(payload: unknown): Promise<{ received: true }> {
    const result = this.identityProvider.parseCallback(payload);
    const row = await this.repo.findOne({
      where: { providerRef: result.providerRef },
    });
    if (!row) {
      throw new NotFoundException('Unknown verification session');
    }
    if (result.verified && row.level !== VerificationLevel.IdVerified) {
      row.level = VerificationLevel.IdVerified;
      row.method = 'id_document';
      row.verifiedAt = new Date();
      await this.repo.save(row);
    }
    return { received: true };
  }

  // --- admin (manual review / override) ---

  /** Newest-touched verification rows for the admin console. */
  async listForAdmin(): Promise<AdminVerificationDTO[]> {
    const rows = await this.repo.find({
      order: { updatedAt: 'DESC' },
      take: 100,
    });
    if (!rows.length) return [];
    const members = await new MemberLookup(this.profiles).byUserIds(
      rows.map((row) => row.userId),
    );
    return rows.map((row) =>
      toAdminVerificationDTO(row, members.get(row.userId) ?? null),
    );
  }

  /**
   * Manual override — the stub path for granting or revoking a level after a
   * human review. Sets the level DIRECTLY (may lower it), recorded as a
   * `manual_review`/`admin` provenance so the badge never claims a provider
   * check that did not happen.
   */
  async override(
    userId: string,
    level: VerificationLevel,
  ): Promise<AdminVerificationDTO> {
    const row = await this.loadOrCreate(userId);
    row.level = level;
    row.method = 'manual_review';
    row.provider = 'admin';
    row.providerRef = null;
    row.verifiedAt =
      levelRank(level) > levelRank(VerificationLevel.Email) ? new Date() : null;
    const saved = await this.repo.save(row);
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    return toAdminVerificationDTO(saved, members.get(userId) ?? null);
  }

  // --- internals ---

  private async loadOrCreate(userId: string): Promise<MemberVerification> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (existing) return existing;
    return this.repo.create({ userId, level: VerificationLevel.Email });
  }

  /** Raise a member to `level` if it is above their current one; never lowers. */
  private async raiseTo(
    userId: string,
    level: VerificationLevel,
    method: string,
    provider: string,
  ): Promise<void> {
    const row = await this.loadOrCreate(userId);
    if (levelRank(level) <= levelRank(row.level)) return;
    row.level = level;
    row.method = method;
    row.provider = provider;
    row.verifiedAt = new Date();
    await this.repo.save(row);
  }
}
