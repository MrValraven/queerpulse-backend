import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_ARTIST_PERSONA_KINDS,
  isStudioArtistPersonaKind,
  studioError,
} from './studio.constants';

export type StudioWritablePersona = Pick<Subprofile, 'id' | 'kind'>;

export interface ReleaseWriteContext {
  release: StudioRelease;
  persona: StudioWritablePersona;
}

/**
 * Studio v1: who may write to a persona's releases. Ownership is any
 * `subprofile_members` row, so a co-owner writes exactly as the creator
 * does, and the kind is checked on every write.
 */
@Injectable()
export class StudioOwnershipService {
  constructor(
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(StudioRelease)
    private readonly releases: Repository<StudioRelease>,
  ) {}

  isPersonaMember(userId: string, subprofileId: string): Promise<boolean> {
    return this.members.exists({ where: { userId, subprofileId } });
  }

  /** The persona a new release is created for. An unknown persona reads as
   *  "not yours", so the refusal never confirms an id exists. */
  async assertArtistPersona(
    userId: string,
    subprofileId: string,
  ): Promise<StudioWritablePersona> {
    const persona = await this.subprofiles.findOne({
      where: { id: subprofileId },
      select: { id: true, kind: true },
    });
    if (!persona || !(await this.isPersonaMember(userId, subprofileId))) {
      throw studioError('studio_not_persona_owner');
    }
    if (!isStudioArtistPersonaKind(persona.kind)) {
      throw studioError('studio_persona_kind_not_allowed');
    }
    return persona;
  }

  /** Personas of a Studio artist kind the member co-owns whose releases can be heard.
   *  Pass the caller's transaction `manager` to read on its connection, so a
   *  read under a lock that transaction holds needs no second connection. */
  listUploadablePersonas(
    userId: string,
    manager?: EntityManager,
  ): Promise<Subprofile[]> {
    const subprofiles = manager
      ? manager.getRepository(Subprofile)
      : this.subprofiles;
    return subprofiles
      .createQueryBuilder('persona')
      .select([
        'persona.id',
        'persona.handle',
        'persona.displayName',
        'persona.kind',
        'persona.avatarUrl',
      ])
      .innerJoin(
        SubprofileMember,
        'member',
        '"member"."subprofile_id" = "persona"."id" AND "member"."user_id" = :uploaderId',
        { uploaderId: userId },
      )
      .where('persona.kind IN (:...artistKinds)', {
        artistKinds: [...STUDIO_ARTIST_PERSONA_KINDS],
      })
      .andWhere(listenablePersonaSql('persona'))
      .orderBy('persona.displayName', 'ASC')
      .getMany();
  }

  /** A release the caller may write, read without a lock (the audio confirm
   *  checks this before its long read, then again under the lock). */
  async loadReleaseForWrite(
    userId: string,
    releaseId: string,
  ): Promise<ReleaseWriteContext> {
    const release = await this.releases.findOne({ where: { id: releaseId } });
    return this.authorizeReleaseWrite(
      release,
      (subprofileId) => this.isPersonaMember(userId, subprofileId),
      (subprofileId) =>
        this.subprofiles.findOne({
          where: { id: subprofileId },
          select: { id: true, kind: true },
        }),
    );
  }

  /**
   * The release row locked `FOR UPDATE` inside the caller's transaction.
   * Every structural write takes this first, so writes to one release run
   * one at a time and each sees what the previous one committed.
   */
  async lockReleaseForWrite(
    manager: EntityManager,
    userId: string,
    releaseId: string,
  ): Promise<ReleaseWriteContext> {
    const release = await manager.findOne(StudioRelease, {
      where: { id: releaseId },
      lock: { mode: 'pessimistic_write' },
    });
    return this.authorizeReleaseWrite(
      release,
      (subprofileId) =>
        manager.exists(SubprofileMember, { where: { userId, subprofileId } }),
      (subprofileId) =>
        manager.findOne(Subprofile, {
          where: { id: subprofileId },
          select: { id: true, kind: true },
        }),
    );
  }

  // A non-owner learns nothing about a draft or taken-down release (404); a
  // published or scheduled one is visible to granted members, so 403 tells
  // them why.
  private async authorizeReleaseWrite(
    release: StudioRelease | null,
    isMemberOf: (subprofileId: string) => Promise<boolean>,
    loadPersona: (
      subprofileId: string,
    ) => Promise<StudioWritablePersona | null>,
  ): Promise<ReleaseWriteContext> {
    if (!release) {
      throw new NotFoundException('Release not found');
    }
    if (!(await isMemberOf(release.subprofileId))) {
      if (
        release.status === StudioReleaseStatus.Published ||
        release.status === StudioReleaseStatus.Scheduled
      ) {
        throw studioError('studio_not_persona_owner');
      }
      throw new NotFoundException('Release not found');
    }
    const persona = await loadPersona(release.subprofileId);
    if (!persona || !isStudioArtistPersonaKind(persona.kind)) {
      throw studioError('studio_persona_kind_not_allowed');
    }
    return { release, persona };
  }
}
