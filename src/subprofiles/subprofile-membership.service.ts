import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, Not, Repository } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { Profile } from '../users/entities/profile.entity';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { transferCreatorWithin } from './subprofile-creator-transfer';
import { MemberView, toMemberView } from './subprofile-invite-response';
import {
  SUBPROFILE_CREATOR_CHANGED,
  SUBPROFILE_MEMBER_REMOVED,
  SubprofileCreatorChangedEvent,
  SubprofileMemberRemovedEvent,
} from './subprofile.events';

/** Two seat reports from one transaction, merged in the order they happened. */
function mergeSeatChanges(
  earlier: MailboxSeatChanges,
  later: MailboxSeatChanges,
): MailboxSeatChanges {
  return {
    endedSeats: [...earlier.endedSeats, ...later.endedSeats],
    releasedClaims: [...earlier.releasedClaims, ...later.releasedClaims],
    staffingChanges: [...earlier.staffingChanges, ...later.staffingChanges],
  };
}

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
  private readonly logger = new Logger(SubprofileMembershipService.name);

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
    // Resolves the persona's mailbox identity and ends a departing co-owner's
    // seat across every thread of it. See `leave` and `removeMember`.
    private readonly identities: IdentitiesService,
    private readonly identityMailboxSync: IdentityMailboxSyncService,
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
  async assertMember(
    userId: string,
    subprofileId: string,
  ): Promise<Subprofile> {
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
  //
  // When the member leaving is the persona's creator, the creator role moves
  // to the longest-standing remaining co-owner in this same transaction and
  // under the same row lock (`transferCreatorWithin`), and every remaining
  // member hears about it once the transaction has committed.
  async leave(userId: string, id: string): Promise<void> {
    await this.getOwned(userId, id); // 404/403 gate (must be a member)
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Subprofile,
      id,
    );
    const { mailboxChanges, creatorChangedEvent } =
      await this.dataSource.transaction(async (manager) => {
        // Lock the persona row FIRST — same lock `invite()`/`accept()` take, so
        // a concurrent leave/invite/accept on this subprofile never interleaves.
        const lockedSubprofile = await manager.findOne(Subprofile, {
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
        // Ends the departing co-owner's mailbox seat in this same transaction,
        // so a failed sync rolls the departure back with it. The live-room
        // eviction event is deferred to after this transaction resolves
        // (below), mirroring `GroupsService.leaveGroup`'s post-commit fan-out,
        // so a rollback can never leave a client believing it lost a room it
        // still has.
        const removedChanges = await this.identityMailboxSync.onStaffRemoved(
          identity.id,
          userId,
          manager,
          { shouldDeferEmission: true },
        );
        // A null row means the persona vanished between the gate and the
        // lock; the count above has already refused that case.
        const transfer = lockedSubprofile
          ? await transferCreatorWithin(manager, lockedSubprofile, userId, {
              identityId: identity.id,
              identityMailboxSync: this.identityMailboxSync,
            })
          : null;
        return {
          mailboxChanges: transfer
            ? mergeSeatChanges(removedChanges, transfer.seatChanges)
            : removedChanges,
          creatorChangedEvent: transfer?.creatorChangedEvent ?? null,
        };
      });
    // Best-effort live fan-out AFTER commit: see the comment above. Task 25:
    // this also carries the departing co-owner's claim releases and their
    // staffing change, and after a creator handoff the new creator's.
    this.identityMailboxSync.emitSeatChanges(mailboxChanges);
    if (creatorChangedEvent) {
      this.emitCreatorChanged(creatorChangedEvent);
    }
  }

  /**
   * Account erasure's persona step: every persona `userId` created that still
   * has another member passes its creator role to the longest-standing of
   * them, by the same rule `leave` applies, before the user row is deleted
   * (its `subprofiles.user_id` foreign key cascades, which would otherwise
   * delete a persona other members still co-own). A persona with no other
   * member is skipped and cascades away with the account as before.
   *
   * One transaction per persona, each under the persona row lock: the erased
   * user's member row goes (when present), their mailbox seat ends, then the
   * transfer runs. Each persona's seat changes and `SUBPROFILE_CREATOR_CHANGED`
   * go out after that persona's own commit, so a failure part way leaves the
   * committed personas announced and the rest untouched.
   *
   * Idempotent, so erasure can retry it: a persona already handed over no
   * longer carries `userId` as its creator and is not selected again, and each
   * transaction re-checks the creator and the roster under the lock.
   */
  async handOverCreatedPersonasFor(userId: string): Promise<void> {
    const sharedPersonas = await this.subprofiles
      .createQueryBuilder('subprofile')
      .select('subprofile.id', 'id')
      .where('subprofile.userId = :userId', { userId })
      .andWhere(
        `EXISTS (SELECT 1 FROM "subprofile_members" "member" WHERE "member"."subprofile_id" = "subprofile"."id" AND "member"."user_id" <> :userId)`,
        { userId },
      )
      .orderBy('subprofile.createdAt', 'ASC')
      .getRawMany<{ id: string }>();

    for (const { id } of sharedPersonas) {
      await this.handOverCreatedPersona(userId, id);
    }
  }

  private async handOverCreatedPersona(
    userId: string,
    subprofileId: string,
  ): Promise<void> {
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Subprofile,
      subprofileId,
    );
    const outcome = await this.dataSource.transaction(async (manager) => {
      // The same persona row lock `leave` takes, so a handoff and a concurrent
      // leave, invite or accept on this persona serialize.
      const lockedSubprofile = await manager.findOne(Subprofile, {
        where: { id: subprofileId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedSubprofile || lockedSubprofile.userId !== userId) {
        return null;
      }
      const otherMemberCount = await manager.count(SubprofileMember, {
        where: { subprofileId, userId: Not(userId) },
      });
      if (otherMemberCount === 0) {
        return null;
      }
      await manager.delete(SubprofileMember, { subprofileId, userId });
      const removedChanges = await this.identityMailboxSync.onStaffRemoved(
        identity.id,
        userId,
        manager,
        { shouldDeferEmission: true },
      );
      const transfer = await transferCreatorWithin(
        manager,
        lockedSubprofile,
        userId,
        {
          identityId: identity.id,
          identityMailboxSync: this.identityMailboxSync,
        },
      );
      if (!transfer) {
        return null;
      }
      return {
        mailboxChanges: mergeSeatChanges(removedChanges, transfer.seatChanges),
        creatorChangedEvent: transfer.creatorChangedEvent,
      };
    });
    if (!outcome) {
      return;
    }
    this.identityMailboxSync.emitSeatChanges(outcome.mailboxChanges);
    this.emitCreatorChanged(outcome.creatorChangedEvent);
  }

  // Post-commit and best-effort, like the seat changes: the handoff has
  // already committed, so a listener failure must not surface as an error to
  // the member who left or fail an account erasure that has moved on.
  private emitCreatorChanged(event: SubprofileCreatorChangedEvent): void {
    try {
      this.eventEmitter.emit(SUBPROFILE_CREATOR_CHANGED, event);
    } catch (error) {
      this.logger.error(
        `Failed to emit ${SUBPROFILE_CREATOR_CHANGED}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
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
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Subprofile,
      id,
    );
    // The roster delete and the end of the removed co-owner's mailbox seat
    // commit together, as in `leave`: access ends in the same transaction as
    // the removal, and a failed sync rolls the removal back with it.
    const mailboxChanges = await this.dataSource.transaction(
      async (manager) => {
        // The same persona row lock `leave` and `SubprofileInvitesService`'s
        // `invite()`/`accept()` take, so a removal and a concurrent accept for
        // the same member serialize and the seats end up matching the roster.
        const locked = await manager.findOne(Subprofile, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) {
          throw new NotFoundException('Subprofile not found');
        }
        // The gate above read the persona before this lock. A concurrent
        // `leave` by the same creator may have committed in between and
        // handed the persona to a successor, possibly the very co-owner this
        // call removes. Deleting that successor's roster row would orphan the
        // persona, so the creator is re-checked on the locked row.
        if (locked.userId !== creatorUserId) {
          throw new ForbiddenException(
            'Only the persona creator can remove co-owners',
          );
        }
        const result = await manager.delete(SubprofileMember, {
          subprofileId: id,
          userId: targetProfile.userId,
        });
        if (!result.affected) {
          throw new NotFoundException(
            'That member does not co-own this persona.',
          );
        }
        return this.identityMailboxSync.onStaffRemoved(
          identity.id,
          targetProfile.userId,
          manager,
          { shouldDeferEmission: true },
        );
      },
    );
    // Best-effort live fan-out AFTER commit, the same schedule `leave` uses:
    // the room evictions, claim releases and staffing change.
    this.identityMailboxSync.emitSeatChanges(mailboxChanges);
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
