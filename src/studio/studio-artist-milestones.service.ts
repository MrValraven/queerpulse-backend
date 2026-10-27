import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  STUDIO_MILESTONES_SHOWN,
  STUDIO_MILESTONE_SELECT_SQL,
  StudioMilestoneCardResponse,
  StudioMilestoneRow,
  StudioMilestonesResponse,
  toStudioMilestone,
} from './studio-milestones';
import { StudioOwnershipService } from './studio-ownership.service';
import { blockedWithAnyPersonaMemberSql } from './studio-persona-members';
import { StudioArtistPersona, toStudioArtistRef } from './studio-response';
import { isStudioArtistPersonaKind, studioError } from './studio.constants';
import { listenablePersonaSql } from './studio-visibility';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_MILESTONES_SQL = `${STUDIO_MILESTONE_SELECT_SQL}
  WHERE "milestone"."subprofile_id" = $1
  ORDER BY "milestone"."reached_at" DESC, "milestone"."threshold" DESC, "milestone"."id" DESC
  LIMIT $2`;

const MILESTONE_BY_ID_SQL = `${STUDIO_MILESTONE_SELECT_SQL}
  WHERE "milestone"."id" = $1`;

/**
 * Studio dashboard milestones: the owner list a persona's members read, and
 * the share card a chat link to one milestone opens. Neither response names
 * the member who runs the persona.
 */
@Injectable()
export class StudioArtistMilestonesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    private readonly ownership: StudioOwnershipService,
  ) {}

  /** Owners and co-owners only; anyone else, and an unknown persona, 404.
   *  Newest first, at most `STUDIO_MILESTONES_SHOWN` rows; rows that share
   *  a reached date read biggest threshold first. */
  async listMilestones(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioMilestonesResponse> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const rows: StudioMilestoneRow[] = await this.dataSource.query(
      LIST_MILESTONES_SQL,
      [subprofileId, STUDIO_MILESTONES_SHOWN],
    );
    return { items: rows.map((row) => toStudioMilestone(row)) };
  }

  /**
   * The share card for one milestone. A member of the persona always reads
   * it, so an owner can preview and share it while the persona is private.
   * Everyone else reads it only when the persona is listenable and no block
   * stands either way between the viewer and any persona member. A persona
   * outside the Studio artist kinds refuses for everyone.
   *
   * Every refusal is the one code `studio_milestone_not_found` with the one
   * body, so the card read never says whether a milestone exists or why it
   * is withheld.
   */
  async getMilestoneCard(
    viewerId: string,
    milestoneId: string,
  ): Promise<StudioMilestoneCardResponse> {
    if (!UUID_PATTERN.test(milestoneId)) {
      throw studioError('studio_milestone_not_found');
    }
    const rows: StudioMilestoneRow[] = await this.dataSource.query(
      MILESTONE_BY_ID_SQL,
      [milestoneId],
    );
    const row = rows[0];
    if (!row) {
      throw studioError('studio_milestone_not_found');
    }
    const isMember = await this.ownership.isPersonaMember(
      viewerId,
      row.subprofile_id,
    );
    const persona = isMember
      ? await this.readMemberPersona(row.subprofile_id)
      : await this.readListenablePersona(viewerId, row.subprofile_id);
    if (!persona || !isStudioArtistPersonaKind(persona.kind)) {
      throw studioError('studio_milestone_not_found');
    }
    return {
      milestone: toStudioMilestone(row),
      artist: toStudioArtistRef(persona),
    };
  }

  private readMemberPersona(
    subprofileId: string,
  ): Promise<StudioArtistPersona | null> {
    return this.subprofiles.findOne({
      where: { id: subprofileId },
      select: {
        id: true,
        handle: true,
        displayName: true,
        kind: true,
        avatarUrl: true,
      },
    });
  }

  private readListenablePersona(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioArtistPersona | null> {
    return this.subprofiles
      .createQueryBuilder('persona')
      .select([
        'persona.id',
        'persona.handle',
        'persona.displayName',
        'persona.kind',
        'persona.avatarUrl',
      ])
      .where('"persona"."id" = :subprofileId', { subprofileId })
      .andWhere(listenablePersonaSql('persona'))
      .andWhere(
        `NOT ${blockedWithAnyPersonaMemberSql(':viewerId', '"persona"."id"')}`,
        { viewerId },
      )
      .getOne();
  }
}
