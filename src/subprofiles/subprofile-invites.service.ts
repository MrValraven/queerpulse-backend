import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isUniqueViolation } from '../common/db-errors';
import { IdentityKind } from '../identities/entities/identity.entity';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from '../identities/identity-mailbox-sync.service';
import { IdentitiesService } from '../identities/identities.service';
import { Profile } from '../users/entities/profile.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  SubprofileInvite,
  SubprofileInviteStatus,
} from './entities/subprofile-invite.entity';
import { SubprofilesService } from './subprofiles.service';
import { MAX_SUBPROFILE_CO_OWNERS } from './subprofile-validation';
import {
  SUBPROFILE_INVITE_ACCEPTED,
  SUBPROFILE_INVITED,
} from './subprofile.events';
import {
  InviteView,
  MyInviteView,
  toInviteView,
  toMyInviteView,
} from './subprofile-invite-response';

/** ENG-450: machine-readable code for a co-owner invite refused, at send OR
 *  accept time, because of a block between the invitee and one of the
 *  persona's current owners (or, at accept time, its inviter). Neither
 *  endpoint says which side blocked which (see `blockedAgainstAnyOf`'s
 *  callers below), so the frontend shows one neutral copy for both. */
export const SUBPROFILE_INVITE_BLOCKED_CODE = 'SUBPROFILE_INVITE_BLOCKED';

/** M5 (fix round 1): internal signal thrown inside `accept()`'s locked
 *  transaction when the in-transaction block re-check hits, so the
 *  transaction rolls back (no member row is ever inserted) before anything
 *  else runs. Caught right outside the transaction, once the rollback is
 *  guaranteed, so the invite-closing save and the coded exception run there,
 *  clear of the transaction's own writes. Never surfaced to a caller. */
class InviteBlockedAtAcceptError extends Error {}

// Co-owner invite lifecycle: an existing member invites another member onto a
// persona's `subprofile_members` roster (membership itself, and the
// creator-is-first-member seed, live on `SubprofilesService`/`create` — this
// service only owns the invite row and its accept/decline/revoke transitions).
// Notification delivery is a SEPARATE concern (Task 5): this service only
// EMITS `subprofile.invited` / `subprofile.invite.accepted` — it never touches
// the notifications module directly.
@Injectable()
export class SubprofileInvitesService {
  constructor(
    @InjectRepository(SubprofileInvite)
    private readonly invites: Repository<SubprofileInvite>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
    private readonly subprofilesService: SubprofilesService,
    private readonly events: EventEmitter2,
    private readonly dataSource: DataSource,
    // Resolves the persona's mailbox identity and seats a newly-accepted
    // co-owner into every thread of it, in the same transaction as the
    // acceptance. See `accept`.
    private readonly identities: IdentitiesService,
    private readonly identityMailboxSync: IdentityMailboxSyncService,
  ) {}

  // A co-owner invites another member onto the persona. Capped at
  // `MAX_SUBPROFILE_CO_OWNERS` counting BOTH current members and outstanding
  // pending invites (so a persona can't oversell its remaining seats to
  // several people at once and then accept past the cap).
  //
  // The cap-count + insert is wrapped in ONE transaction that first takes a
  // `SELECT ... FOR UPDATE` lock on the persona row — this serializes
  // concurrent `invite()`/`accept()` calls against the SAME subprofile (they
  // all lock the same row, in the same order, so the second one always sees
  // the first one's write) rather than racing two independent
  // count-then-write sequences that could both pass a stale count and jointly
  // exceed the ceiling. Mirrors every other read-check-then-write in
  // `subprofiles.service.ts`, all of which use `this.dataSource.transaction`.
  async invite(
    inviterUserId: string,
    subprofileId: string,
    slug: string,
  ): Promise<InviteView> {
    const sp = await this.subprofilesService.assertMember(
      inviterUserId,
      subprofileId,
    ); // 404/403 gate
    // Resolve the invitee's `slug` (the client's addressing convention — see
    // `messaging/dto/create-conversation.dto.ts`) to their `userId` FIRST —
    // every check below (self-invite, block-filter, membership, pending
    // invite, the stored invite row) is keyed on `userId`, never the slug.
    const invitedProfile = await this.profiles.findOne({ where: { slug } });
    if (!invitedProfile) {
      throw new NotFoundException('No such member.');
    }
    const invitedUserId = invitedProfile.userId;
    if (invitedUserId === inviterUserId) {
      throw new BadRequestException('You already co-own this persona.');
    }
    // ENG-450: refuse when the invitee is blocked, either way, with ANY
    // current owner. One batched query covers every owner, including the
    // inviter (`assertMember` above already required they be one), so this
    // subsumes the previous inviter-only check. The message stays neutral
    // either way, naming neither which side blocked which nor which owner.
    const ownerUserIds = (
      await this.members.find({
        where: { subprofileId },
        select: { userId: true },
      })
    ).map((row) => row.userId);
    const blockedInvitee = await this.blockFilter.blockedAgainstAnyOf(
      [invitedUserId],
      ownerUserIds,
    );
    if (blockedInvitee.size > 0) {
      throw new BadRequestException({
        code: SUBPROFILE_INVITE_BLOCKED_CODE,
        message: 'You cannot invite this member.',
      });
    }
    const alreadyMember = await this.members.findOne({
      where: { subprofileId, userId: invitedUserId },
      select: { id: true },
    });
    if (alreadyMember) {
      throw new ConflictException('They already co-own this persona.');
    }

    const invite = await this.dataSource.transaction(async (manager) => {
      // Lock the persona row FIRST — every concurrent invite/accept on this
      // subprofile takes this same lock before touching the cap-relevant
      // counts, so they serialize instead of interleaving.
      await manager.findOne(Subprofile, {
        where: { id: subprofileId },
        lock: { mode: 'pessimistic_write' },
      });
      const memberCount = await manager.count(SubprofileMember, {
        where: { subprofileId },
      });
      const pendingCount = await manager.count(SubprofileInvite, {
        where: { subprofileId, status: SubprofileInviteStatus.Pending },
      });
      if (memberCount + pendingCount >= MAX_SUBPROFILE_CO_OWNERS) {
        throw new BadRequestException(
          `A persona can have at most ${MAX_SUBPROFILE_CO_OWNERS} co-owners.`,
        );
      }
      const existingPending = await manager.findOne(SubprofileInvite, {
        where: {
          subprofileId,
          invitedUserId,
          status: SubprofileInviteStatus.Pending,
        },
      });
      if (existingPending) {
        throw new ConflictException('They already have a pending invite.');
      }
      return manager.save(
        manager.create(SubprofileInvite, {
          subprofileId,
          invitedUserId,
          invitedByUserId: inviterUserId,
          status: SubprofileInviteStatus.Pending,
        }),
      );
    });

    // Emitted AFTER the transaction commits — a listener (Task 5) must never
    // observe an invite that could still be rolled back.
    this.events.emit(SUBPROFILE_INVITED, {
      subprofileId,
      invitedUserId,
      invitedByUserId: inviterUserId,
      displayName: sp.displayName,
    });
    return toInviteView(invite, invitedProfile);
  }

  // Persona-scoped: the pending invites a co-owner can see/manage on their own
  // persona. Batches the invitee-profile lookup into ONE query regardless of
  // how many invites are outstanding (mirrors `SubprofilesService.listMembers`).
  async listInvites(
    userId: string,
    subprofileId: string,
  ): Promise<InviteView[]> {
    await this.subprofilesService.assertMember(userId, subprofileId);
    const rows = await this.invites.find({
      where: { subprofileId, status: SubprofileInviteStatus.Pending },
      order: { createdAt: 'ASC' },
    });
    const profileRows = await this.profiles.find({
      where: { userId: In(rows.map((row) => row.invitedUserId)) },
    });
    const byUserId = new Map(profileRows.map((p) => [p.userId, p]));
    return rows
      .filter((row) => byUserId.has(row.invitedUserId))
      .map((row) => toInviteView(row, byUserId.get(row.invitedUserId)!));
  }

  // A co-owner revokes a pending invite they (or another co-owner) sent.
  async revoke(
    userId: string,
    subprofileId: string,
    inviteId: string,
  ): Promise<void> {
    await this.subprofilesService.assertMember(userId, subprofileId);
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite || invite.subprofileId !== subprofileId) {
      throw new NotFoundException('Invite not found.');
    }
    if (invite.status !== SubprofileInviteStatus.Pending) {
      throw new ConflictException('That invite is no longer pending.');
    }
    invite.status = SubprofileInviteStatus.Revoked;
    invite.respondedAt = new Date();
    await this.invites.save(invite);
  }

  // Invitee-scoped: every pending invite addressed to this member, across
  // every persona. The banner needs the PERSONA's identity (not the invitee's
  // own profile) and who invited them — resolved via TWO batched queries
  // total (one `subprofiles.find`, one `profiles.find` over the inviter set),
  // never one query per invite row.
  async listMine(userId: string): Promise<MyInviteView[]> {
    const rows = await this.invites.find({
      where: { invitedUserId: userId, status: SubprofileInviteStatus.Pending },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) {
      return [];
    }
    const [personaRows, inviterProfileRows] = await Promise.all([
      this.subprofiles.find({
        where: { id: In(rows.map((row) => row.subprofileId)) },
      }),
      this.profiles.find({
        where: { userId: In(rows.map((row) => row.invitedByUserId)) },
      }),
    ]);
    const personaById = new Map(personaRows.map((sp) => [sp.id, sp]));
    const inviterByUserId = new Map(
      inviterProfileRows.map((profile) => [profile.userId, profile]),
    );
    return rows
      .filter(
        (row) =>
          personaById.has(row.subprofileId) &&
          inviterByUserId.has(row.invitedByUserId),
      )
      .map((row) =>
        toMyInviteView(
          row,
          personaById.get(row.subprofileId)!,
          inviterByUserId.get(row.invitedByUserId)!,
        ),
      );
  }

  // Accepting seats the invitee onto the persona's roster (idempotent if they
  // are somehow already a member — e.g. a double-tap, or a concurrent second
  // accept for the same invitee — see the unique-violation catch below) and
  // flips the invite.
  //
  // The member-count-vs-cap check + insert is wrapped in ONE transaction that
  // first takes the SAME `SELECT ... FOR UPDATE` lock on the persona row that
  // `invite()` takes, so an `accept()` racing another `accept()` OR an
  // `invite()` on the same subprofile always serializes rather than both
  // reading a stale, under-cap count.
  async accept(userId: string, inviteId: string): Promise<void> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite || invite.invitedUserId !== userId) {
      throw new NotFoundException('Invite not found.');
    }
    if (invite.status !== SubprofileInviteStatus.Pending) {
      throw new ConflictException('That invite is no longer pending.');
    }
    // The persona already exists (this invite was sent against it), so this
    // is safe to resolve outside the lock below: idempotent, and orthogonal
    // to the membership-cap check the lock actually protects.
    const identity = await this.identities.ensureIdentityFor(
      IdentityKind.Subprofile,
      invite.subprofileId,
    );

    let seatChanges: MailboxSeatChanges;
    try {
      seatChanges = await this.dataSource.transaction(async (manager) => {
        // Lock the persona row FIRST — same lock `invite()` takes, so the two
        // operations never interleave on the same subprofile.
        await manager.findOne(Subprofile, {
          where: { id: invite.subprofileId },
          lock: { mode: 'pessimistic_write' },
        });
        // ENG-450 / M5 (fix round 1): a block formed any time between the
        // invite and this accept, by either the accepter or a current owner
        // in either direction, must still stop the seat, so this re-checks
        // fresh right here. Read AFTER the row lock above (not before the
        // transaction opens), so two invitees who blocked each other cannot
        // both pass a stale pre-lock read and both get seated. Guards
        // against ANY current owner (the roster may have changed since the
        // invite was sent) AND the original inviter specifically: a departed
        // inviter is no longer in `ownerUserIds`, yet a block with them
        // still means the two should never end up co-owning the same
        // persona. A hit aborts the whole transaction (no member row is
        // ever inserted); the invite is closed and the coded error thrown
        // in the `catch` below, once the rollback is guaranteed.
        const ownerUserIds = (
          await manager.find(SubprofileMember, {
            where: { subprofileId: invite.subprofileId },
            select: { userId: true },
          })
        ).map((row) => row.userId);
        const guardianIds = [
          ...new Set([...ownerUserIds, invite.invitedByUserId]),
        ];
        const blockedAccepter = await this.blockFilter.blockedAgainstAnyOf(
          [userId],
          guardianIds,
        );
        if (blockedAccepter.size > 0) {
          throw new InviteBlockedAtAcceptError();
        }
        const existing = await manager.findOne(SubprofileMember, {
          where: { subprofileId: invite.subprofileId, userId },
          select: { id: true },
        });
        if (!existing) {
          const count = await manager.count(SubprofileMember, {
            where: { subprofileId: invite.subprofileId },
          });
          if (count >= MAX_SUBPROFILE_CO_OWNERS) {
            throw new BadRequestException('This persona is already full.');
          }
          try {
            await manager.save(
              manager.create(SubprofileMember, {
                subprofileId: invite.subprofileId,
                userId,
              }),
            );
          } catch (err) {
            // A second, concurrent accept for the SAME invitee can still
            // slip past the `existing` check above (it's not itself locked)
            // and insert first — the row now genuinely exists, so this is
            // the idempotent "already a member" success the pre-check
            // already promises, not a server error. Anything else re-throws.
            if (!isUniqueViolation(err)) {
              throw err;
            }
          }
        }
        invite.status = SubprofileInviteStatus.Accepted;
        invite.respondedAt = new Date();
        await manager.save(invite);
        // Seat the new co-owner into every thread of the persona's mailbox,
        // in this same transaction, so a failed sync rolls the acceptance
        // back with it. Safe to call even on the idempotent "already a
        // member" branch above: a member already seated is skipped. The
        // staffing frame waits for the commit (below).
        return this.identityMailboxSync.onStaffAdded(
          identity.id,
          userId,
          manager,
          { shouldDeferEmission: true },
        );
      });
    } catch (err) {
      // M5 (fix round 1): the transaction above has already rolled back by
      // the time this runs, so the invite-closing save below cannot race the
      // (never-committed) seat insert. Mirrors `revoke`'s shape, so a stale
      // pending row never lingers offering an accept that would only fail
      // again.
      if (err instanceof InviteBlockedAtAcceptError) {
        invite.status = SubprofileInviteStatus.Revoked;
        invite.respondedAt = new Date();
        await this.invites.save(invite);
        throw new BadRequestException({
          code: SUBPROFILE_INVITE_BLOCKED_CODE,
          message: 'This invite is no longer available.',
        });
      }
      throw err;
    }
    // Task 25: the new co-owner hears their new mailbox only once the
    // acceptance has committed, so a rollback never announces a seat.
    this.identityMailboxSync.emitSeatChanges(seatChanges);

    // Emitted AFTER the transaction commits.
    this.events.emit(SUBPROFILE_INVITE_ACCEPTED, {
      subprofileId: invite.subprofileId,
      joinedUserId: userId,
      invitedByUserId: invite.invitedByUserId,
    });
  }

  async decline(userId: string, inviteId: string): Promise<void> {
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    if (!invite || invite.invitedUserId !== userId) {
      throw new NotFoundException('Invite not found.');
    }
    if (invite.status !== SubprofileInviteStatus.Pending) {
      throw new ConflictException('That invite is no longer pending.');
    }
    invite.status = SubprofileInviteStatus.Declined;
    invite.respondedAt = new Date();
    await this.invites.save(invite);
  }
}
