import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  assessTrustNetwork,
  AssessmentMemberInput,
  AssessmentVouchInput,
  TrustAssessment,
} from './admin-trust-network-assessment';

/** How long one platform-wide assessment is served before the next caller
 *  triggers a reload. A verify or suspend can take up to this long to reach
 *  the triage list and the badge, which is fine for triage. */
export const ASSESSMENT_TTL_MS = 60_000;

/** Raw row of the profile + account join, one per member. */
interface MemberRow {
  userId: string;
  slug: string;
  firstName: string;
  lastName: string;
  verified: boolean;
  joinedAt: Date | string;
  role: UserRole;
  isSystem: boolean;
  status: UserStatus;
  invitedByUserId: string | null;
}

/**
 * Loads the platform-wide trust inputs (members, open member reports, every
 * vouch row) with column-only queries and runs `assessTrustNetwork` over
 * them. The result is cached for `ASSESSMENT_TTL_MS`, and concurrent callers
 * share one in-flight load, so the graph, the summary badge and the triage
 * list read the same numbers.
 */
@Injectable()
export class AdminTrustNetworkAssessmentService {
  private cachedAssessment: {
    assessment: TrustAssessment;
    expiresAt: number;
  } | null = null;
  private inFlightAssessment: Promise<TrustAssessment> | null = null;

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
  ) {}

  getAssessment(): Promise<TrustAssessment> {
    const cached = this.cachedAssessment;
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.assessment);
    }
    if (this.inFlightAssessment) return this.inFlightAssessment;

    const loading = this.loadAssessment()
      .then((assessment) => {
        this.cachedAssessment = {
          assessment,
          expiresAt: Date.now() + ASSESSMENT_TTL_MS,
        };
        return assessment;
      })
      .finally(() => {
        if (this.inFlightAssessment === loading) {
          this.inFlightAssessment = null;
        }
      });
    this.inFlightAssessment = loading;
    return loading;
  }

  private async loadAssessment(): Promise<TrustAssessment> {
    const [memberRows, openReportCountBySubjectId, vouchInputs] =
      await Promise.all([
        this.loadMemberRows(),
        this.loadOpenReportCountsBySubject(),
        this.loadVouches(),
      ]);
    const members: AssessmentMemberInput[] = memberRows.map((row) => ({
      userId: row.userId,
      slug: row.slug,
      name: `${row.firstName} ${row.lastName}`.trim(),
      verified: row.verified,
      joinedAt: new Date(row.joinedAt),
      role: row.role,
      isSystem: row.isSystem,
      isSuspended: row.status === UserStatus.Suspended,
      isDeactivated: row.status === UserStatus.Deactivated,
      invitedByUserId: row.invitedByUserId ?? null,
      // Reports address a member by userId or by slug; both count.
      openReportCount:
        (openReportCountBySubjectId.get(row.userId) ?? 0) +
        (openReportCountBySubjectId.get(row.slug) ?? 0),
    }));
    return assessTrustNetwork(members, vouchInputs, new Date());
  }

  private loadMemberRows(): Promise<MemberRow[]> {
    return this.profiles
      .createQueryBuilder('profile')
      .innerJoin('profile.user', 'account')
      .select('profile.user_id', 'userId')
      .addSelect('profile.slug', 'slug')
      .addSelect('profile.first_name', 'firstName')
      .addSelect('profile.last_name', 'lastName')
      .addSelect('profile.verified', 'verified')
      .addSelect('profile.joined_at', 'joinedAt')
      .addSelect('account.role', 'role')
      .addSelect('account.is_system', 'isSystem')
      .addSelect('account.status', 'status')
      .addSelect('account.invited_by', 'invitedByUserId')
      .getRawMany<MemberRow>();
  }

  /** Open or escalated member reports, counted per `subject_id` (a userId or
   *  a slug), the same grouping `getGraph` uses. */
  private async loadOpenReportCountsBySubject(): Promise<Map<string, number>> {
    const rows = await this.reports
      .createQueryBuilder('report')
      .select('report.subject_id', 'subjectId')
      .addSelect('COUNT(*)', 'count')
      .where('report.subject_type = :subjectType', {
        subjectType: ReportSubjectType.Member,
      })
      .andWhere('report.status IN (:...statuses)', {
        statuses: [ReportStatus.Open, ReportStatus.Escalated],
      })
      .groupBy('report.subject_id')
      .getRawMany<{ subjectId: string; count: string }>();
    return new Map(rows.map((row) => [row.subjectId, Number(row.count)]));
  }

  private async loadVouches(): Promise<AssessmentVouchInput[]> {
    const rows = await this.vouches.find({
      select: { voucherId: true, voucheeId: true, withdrawnAt: true },
    });
    return rows.map((row) => ({
      voucherId: row.voucherId,
      voucheeId: row.voucheeId,
      withdrawn: row.withdrawnAt !== null && row.withdrawnAt !== undefined,
    }));
  }
}
