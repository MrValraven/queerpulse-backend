import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import {
  AdminChangemakerNominationDTO,
  AdminChangemakerNominationsPageDTO,
  toAdminChangemakerNominationDTO,
} from './admin-changemaker-nominations-response';
import { ListAdminChangemakerNominationsQuery } from './dto/list-admin-changemaker-nominations.query';

/** One page of the admin changemaker-nomination list. */
export const ADMIN_CHANGEMAKER_NOMINATIONS_PAGE_SIZE = 20;

/**
 * Read model behind the admin dashboard's changemaker-nomination oversight
 * surface: every "Nominate them" a member has submitted, newest first,
 * paginated.
 *
 * Every row is hand-mapped to `AdminChangemakerNominationDTO` (never a raw
 * entity), and the nominating members are resolved in ONE batched profile
 * lookup across the whole page — never one query per row — mirroring
 * `AdminInvitesService`.
 */
@Injectable()
export class AdminChangemakerNominationsService {
  constructor(
    @InjectRepository(ChangemakerNomination)
    private readonly nominations: Repository<ChangemakerNomination>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async list(
    query: ListAdminChangemakerNominationsQuery,
  ): Promise<AdminChangemakerNominationsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_CHANGEMAKER_NOMINATIONS_PAGE_SIZE;

    const [rows, total] = await this.nominations.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const nominatorIds = [...new Set(rows.map((row) => row.nominatorId))];
    const refsByUserId = await memberLookup.byUserIds(nominatorIds);

    const items: AdminChangemakerNominationDTO[] = rows.map((nomination) =>
      toAdminChangemakerNominationDTO(
        nomination,
        refsByUserId.get(nomination.nominatorId) ?? null,
      ),
    );

    return { items, total, page, pageSize };
  }
}
