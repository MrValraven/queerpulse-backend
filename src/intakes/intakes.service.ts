import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { ListIntakesQuery } from './dto/list-intakes.query';
import { IntakeSubmission } from './entities/intake-submission.entity';
import {
  MEMBER_ONLY_INTAKE_KINDS,
  isIntakeKind,
} from './intake-kinds';
import {
  IntakeAckDTO,
  IntakeSubmissionDTO,
  toIntakeAckDTO,
  toIntakeSubmissionDTO,
} from './intakes-response';

@Injectable()
export class IntakesService {
  constructor(
    @InjectRepository(IntakeSubmission)
    private readonly submissions: Repository<IntakeSubmission>,
  ) {}

  /**
   * Records one intake submission. `rawKind` is the untrusted `:kind` path
   * param — validated against the allowlist first, so an unknown kind can never
   * create a row. Member-only kinds require an authenticated caller; the public
   * kinds accept anonymous submissions and capture `submitterId` only when the
   * caller happened to be signed in (best-effort, via OptionalJwtAuthGuard).
   */
  async submit(
    rawKind: string,
    payload: Record<string, unknown>,
    user: CurrentUserData | undefined,
  ): Promise<IntakeAckDTO> {
    if (!isIntakeKind(rawKind)) {
      throw new BadRequestException(`Unknown intake kind: ${rawKind}`);
    }

    // Member-only kinds require an ACTIVE member — a valid cookie alone isn't
    // enough, since the JWT strategy still issues a principal for suspended /
    // pending / deactivated accounts.
    if (
      MEMBER_ONLY_INTAKE_KINDS.has(rawKind) &&
      user?.status !== UserStatus.Active
    ) {
      throw new UnauthorizedException(
        'This form requires you to be a signed-in member.',
      );
    }

    const saved = await this.submissions.save(
      this.submissions.create({
        kind: rawKind,
        submitterId: user?.userId ?? null,
        payload,
        status: 'new',
      }),
    );

    return toIntakeAckDTO(saved);
  }

  /** Admin triage list, newest first, optionally filtered by kind/status. */
  async list(query: ListIntakesQuery): Promise<Paginated<IntakeSubmissionDTO>> {
    const page = normalizePage(query.page);
    const qb = this.submissions
      .createQueryBuilder('intake')
      .orderBy('intake.createdAt', 'DESC');

    if (query.kind) {
      qb.andWhere('intake.kind = :kind', { kind: query.kind });
    }
    if (query.status) {
      qb.andWhere('intake.status = :status', { status: query.status });
    }

    return paginate(qb, page, (rows) => rows.map(toIntakeSubmissionDTO));
  }
}
