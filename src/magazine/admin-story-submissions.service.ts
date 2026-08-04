import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { MagazineStorySubmission } from './entities/magazine-story-submission.entity';
import {
  AdminStorySubmissionDTO,
  AdminStorySubmissionsPageDTO,
  toAdminStorySubmissionDTO,
} from './admin-story-submissions-response';
import { ListAdminStorySubmissionsQuery } from './dto/list-admin-story-submissions.query';

/** One page of the admin story-submission list. */
export const ADMIN_STORY_SUBMISSIONS_PAGE_SIZE = 20;

/**
 * Read model behind the admin dashboard's magazine-submission oversight surface:
 * every reader story pitch, newest first, optionally filtered by status,
 * paginated. This is the admin READ side of the submissions the editor was
 * previously mock-only for — it never mutates a submission's status.
 *
 * Every row is hand-mapped to `AdminStorySubmissionDTO` (never a raw entity),
 * and the submitting members are resolved in ONE batched profile lookup across
 * the whole page — never one query per row — mirroring `AdminInvitesService`.
 */
@Injectable()
export class AdminStorySubmissionsService {
  constructor(
    @InjectRepository(MagazineStorySubmission)
    private readonly submissions: Repository<MagazineStorySubmission>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async list(
    query: ListAdminStorySubmissionsQuery,
  ): Promise<AdminStorySubmissionsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_STORY_SUBMISSIONS_PAGE_SIZE;

    const [rows, total] = await this.submissions.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminStorySubmissionDTO[] = rows.map((submission) =>
      toAdminStorySubmissionDTO(
        submission,
        refsByUserId.get(submission.userId) ?? null,
      ),
    );

    return { items, total, page, pageSize };
  }
}
