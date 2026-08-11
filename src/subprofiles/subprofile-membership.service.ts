import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { MemberView, toMemberView } from './subprofile-invite-response';
import {
  SUBPROFILE_MEMBER_REMOVED,
  SubprofileMemberRemovedEvent,
} from './subprofile.events';

// Co-ownership membership for personas: the "am I a member?" gate every write
// path leans on (`getOwned`/`assertMember`), the co-owner roster reads
// (`listMembers`/`loadMemberCountsFor`), and the two roster mutations that are
// NOT part of the invite lifecycle (`leave`/`removeMember`). Extracted from the
// former god-service so `SubprofileInvitesService` can depend on this narrow
// membership gate instead of the whole facade (keeps the DI graph acyclic —
// this service depends only on repositories, so nothing here can cycle back
// through the facade).
@Injectable()
export class SubprofileMembershipService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    // Emits `subprofile.member.removed` so an evicted co-owner is notified
    // (Task 4). Globally available via `EventEmitterModule` at the app root.
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // Co-owner-aware membership check backing `getOwned`: any row in
  // `subprofile_members` for this (userId, subprofileId) pair passes, not
  // just the original creator (`sp.userId`).
  async isMember(userId: string, subprofileId: string): Promise<boolean> {
    const row = await this.members.findOne({
      where: { subprofileId, userId },
      select: { id: true },
    });
    return row !== null;
  }

  async getOwned(userId: string, id: string): Promise<Subprofile> {
    const sp = await this.subprofiles.findOne({ where: { id } });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    if (!(await this.isMember(userId, id))) {
      throw new ForbiddenException('Not your subprofile');
    }
    return sp;
  }

  // Public membership gate (404/403) for other services (e.g.
  // `SubprofileInvitesService`) that need the same check `getOwned` already
  // does, without exposing the private `isMember` boolean helper itself.
  async assertMember(userId: string, subprofileId: string): Promise<Subprofile> {
    return this.getOwned(userId, subprofileId);
  }

  // List a persona's co-owners (members-gated). Batches the profile lookup
  // into ONE query regardless of how many co-owners the persona has.
  async listMembers(userId: string, id: string): Promise<MemberView[]> {
    const sp = await this.getOwned(userId, id); // 404/403 gate
    const memberRows = await this.members.find({
      where: { subprofileId: id },
      order: { joinedAt: 'ASC' },
    });
    const profileRows = await this.profiles.find({
      where: { userId: In(memberRows.map((row) => row.userId)) },
    });
    const profileByUserId = new Map(profileRows.map((p) => [p.userId, p]));
    return memberRows
      .filter((row) => profileByUserId.has(row.userId))
      .map((row) =>
        toMemberView(row, profileByUserId.get(row.userId)!, sp.userId),
      );
  }

  // A co-owner leaves the persona. The last remaining member cannot leave —
  // they must delete the persona instead (mirrors `remove`'s cascade).
  //
  // The count-then-delete is wrapped in ONE transaction that first takes the
  // SAME `SELECT ... FOR UPDATE` lock on the persona row that
  // `SubprofileInvitesService.invite()`/`accept()` take, so two co-owners of a
  // 2-member persona leaving at the same instant can never both read
  // count === 2 and both delete — serialized instead, the second leave
  // re-counts under the lock and correctly sees count === 1 (the ConflictException
  // last-owner guard), rather than the persona ending up with zero members
  // (bricked: `getOwned` then 403s everyone, including `remove()`).
  async leave(userId: string, id: string): Promise<void> {
    await this.getOwned(userId, id); // 404/403 gate (must be a member)
    await this.dataSource.transaction(async (manager) => {
      // Lock the persona row FIRST — same lock `invite()`/`accept()` take, so
      // a concurrent leave/invite/accept on this subprofile never interleaves.
      await manager.findOne(Subprofile, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      const count = await manager.count(SubprofileMember, {
        where: { subprofileId: id },
      });
      if (count <= 1) {
        throw new ConflictException(
          'You are the only owner — delete the persona instead of leaving.',
        );
      }
      await manager.delete(SubprofileMember, { subprofileId: id, userId });
    });
  }

  // Creator-initiated "remove a co-owner" (Task 4): the persona's original
  // owner evicts another co-owner from the roster. Creator-only, and the
  // creator cannot remove THEMSELF via this path (there is no owner to hand off
  // to — self-leave lives on `DELETE :id/members/me`, and the last owner must
  // delete the persona instead). The target is addressed by their profile slug,
  // matching every other member-addressing route.
  async removeMember(
    creatorUserId: string,
    id: string,
    targetSlug: string,
  ): Promise<void> {
    const sp = await this.getOwned(creatorUserId, id); // 404/403 membership gate
    if (sp.userId !== creatorUserId) {
      throw new ForbiddenException(
        'Only the persona creator can remove co-owners',
      );
    }
    const targetProfile = await this.profiles.findOne({
      where: { slug: targetSlug },
    });
    if (!targetProfile) {
      throw new NotFoundException('No such member.');
    }
    if (targetProfile.userId === creatorUserId) {
      throw new BadRequestException(
        'You cannot remove yourself — delete the persona instead.',
      );
    }
    const result = await this.members.delete({
      subprofileId: id,
      userId: targetProfile.userId,
    });
    if (!result.affected) {
      throw new NotFoundException('That member does not co-own this persona.');
    }
    // Emitted AFTER the roster row is gone (post-commit) so the evicted co-owner
    // is told they no longer co-own the persona — best-effort, mirroring
    // `remove()`'s `SUBPROFILE_DELETED`: the delete already committed, so a
    // notification failure must not surface as an error to the creator.
    this.eventEmitter.emit(SUBPROFILE_MEMBER_REMOVED, {
      subprofileId: id,
      displayName: sp.displayName,
      removedUserId: targetProfile.userId,
      removedByUserId: creatorUserId,
    } satisfies SubprofileMemberRemovedEvent);
  }

  // Batches a per-subprofile co-owner COUNT into ONE query (Personas redesign
  // Phase 2 dashboard plan Decision §5) — mirrors
  // `SubprofileEndorsementsService.loadEndorsementCountsFor`'s
  // find-then-tally shape rather than a raw `GROUP BY`, so it stays consistent
  // with every other batched count in this service. The creator is always
  // given a `subprofile_members` row in the same transaction as the persona
  // itself (see `SubprofilesService.create()`), so every real persona has at
  // least one row here — callers still default a missing map entry to 1
  // defensively.
  async loadMemberCountsFor(
    subprofileIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!subprofileIds.length) return counts;
    // Grouped SQL COUNT — Postgres tallies per subprofile and returns one row
    // per persona, rather than materialising every membership row into the app
    // just to count them.
    const rows = await this.members
      .createQueryBuilder('member')
      .select('member.subprofileId', 'subprofileId')
      .addSelect('COUNT(*)', 'count')
      .where('member.subprofileId IN (:...subprofileIds)', { subprofileIds })
      .groupBy('member.subprofileId')
      .getRawMany<{ subprofileId: string; count: string }>();
    for (const row of rows) {
      counts.set(row.subprofileId, Number(row.count));
    }
    return counts;
  }
}
