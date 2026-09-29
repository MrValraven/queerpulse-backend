import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { lockEngageablePersonaWithin } from './subprofile-engagement-lock';
import { EndorserView } from './subprofile-response';
import { isSubprofileUnderTakedown } from './subprofile-takedown';
import {
  SUBPROFILE_ENDORSED,
  SubprofileEndorsedEvent,
} from './subprofile.events';

// Endorser pages are capped at 50 rows, newest-first. The owner-facing list is
// now pageable (optional `page`/`limit`), but a single page never exceeds this
// cap.
const ENDORSERS_LIST_CAP = 50;

// Owns the endorse / withdraw / list-endorsers behaviour plus the batched
// count/viewer-state derivations the persona read paths consume. Extracted
// from `SubprofilesService` (which now delegates to it) so the endorsement
// concern is self-contained; it injects the shared deps it needs directly
// rather than reaching back through the facade (no circular DI).
@Injectable()
export class SubprofileEndorsementsService {
  constructor(
    @InjectRepository(SubprofileEndorsement)
    private readonly endorsements: Repository<SubprofileEndorsement>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // Read-only: `listEndorsers`'s owner/co-owner visibility gate — a member
    // row means the viewer may see the endorser list of even a draft/private
    // persona they own (injected directly to avoid a circular DI back through
    // the facade, like `SubprofileFollowersService` does).
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
    // Read-only: `resolveEndorsablePersona` withholds a persona under a
    // moderator takedown, the same state every public READ path already
    // applies. `ContentModerationModule` is already imported by
    // `SubprofilesModule` for `SubprofilePublicReadService`.
    private readonly contentModeration: ContentModerationService,
    // Read-only: the self-endorse guard in `endorse` asks whether the endorser
    // co-owns the persona, through the same `isMember` predicate every owner
    // gate uses.
    private readonly membership: SubprofileMembershipService,
  ) {}

  async endorse(
    endorserId: string,
    id: string,
    note?: string,
  ): Promise<{ endorsementCount: number; viewerEndorsed: boolean }> {
    const persona = await this.resolveEndorsablePersona(endorserId, id);
    // Every owner is refused: the creator (`persona.userId`) and each co-owner
    // holding a `subprofile_members` row. A co-owner endorsing their own
    // persona would inflate its count from inside and send the creator an
    // endorsement bell from a fellow owner.
    if (
      persona.userId === endorserId ||
      (await this.membership.isMember(endorserId, persona.id))
    ) {
      throw new BadRequestException('You cannot endorse your own persona');
    }

    // Empty/whitespace-only notes are stored as null, not "" — mirrors
    // `VouchService.createVouch`.
    const trimmedNote = note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;

    // Upsert mirroring `VouchService.createVouch`, except for the
    // already-active case: a vouch 409s on a duplicate, while endorsing is a
    // one-tap action, so re-tapping an already-endorsed persona is idempotent
    // success (current count, viewerEndorsed: true). `justActivated` records
    // whether a real inactive-to-active transition happened, so the
    // notification event fires once per genuine endorse.
    //
    // The write runs in a transaction that first re-reads the persona under a
    // share lock (`lockEngageablePersonaWithin`), so it cannot land after a
    // concurrent linked-to-unlinked switch has deleted every endorsement. A
    // unique violation (a concurrent endorse for the same pair won the insert)
    // aborts that transaction and is caught out here, after the rollback: the
    // row exists and is active, which is idempotent success.
    let justActivated = false;
    try {
      justActivated = await this.endorsements.manager.transaction(
        async (manager) => {
          await lockEngageablePersonaWithin(manager, persona);
          return this.writeEndorsementWithin(
            manager,
            id,
            endorserId,
            cleanNote,
          );
        },
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }

    const endorsementCount =
      (await this.loadEndorsementCountsFor([id])).get(id) ?? 0;

    if (justActivated) {
      this.eventEmitter.emit(SUBPROFILE_ENDORSED, {
        subprofileId: id,
        endorserId,
        ownerId: persona.userId,
      } satisfies SubprofileEndorsedEvent);
    }

    return { endorsementCount, viewerEndorsed: true };
  }

  /**
   * The endorse write on `manager`, returning whether it activated an
   * endorsement (the signal for the notification event).
   * - Already active: a note edit. The note is updated in place and nothing
   *   is activated, so no new event fires.
   * - Withdrawn: reactivated in place (keeps id and createdAt), conditional on
   *   the row still being withdrawn, so of two concurrent re-endorses only the
   *   one whose update reports `affected === 1` activates it.
   * - None: inserted. A unique violation propagates to `endorse`.
   */
  private async writeEndorsementWithin(
    manager: EntityManager,
    subprofileId: string,
    endorserId: string,
    cleanNote: string | null,
  ): Promise<boolean> {
    const endorsementRows = manager.getRepository(SubprofileEndorsement);
    const existing = await endorsementRows.findOne({
      where: { subprofileId, endorserId },
    });
    if (existing && existing.withdrawnAt === null) {
      await endorsementRows.update({ id: existing.id }, { note: cleanNote });
      return false;
    }
    if (existing) {
      const reactivateResult = await endorsementRows.update(
        { id: existing.id, withdrawnAt: Not(IsNull()) },
        { withdrawnAt: null, note: cleanNote },
      );
      return reactivateResult.affected === 1;
    }
    await endorsementRows.insert({ subprofileId, endorserId, note: cleanNote });
    return true;
  }

  async withdrawEndorsement(
    endorserId: string,
    id: string,
  ): Promise<{ endorsementCount: number; viewerEndorsed: boolean }> {
    // No-op if there is no active endorsement to withdraw — unlike
    // `VouchService.withdrawVouch`, this never 404s (the endorse control is a
    // toggle; withdrawing a non-existent/already-withdrawn endorsement should
    // just settle into the "not endorsed" state).
    const active = await this.endorsements.findOne({
      where: { subprofileId: id, endorserId, withdrawnAt: IsNull() },
    });
    if (active) {
      await this.endorsements.update(
        { id: active.id },
        { withdrawnAt: new Date() },
      );
    }
    const endorsementCount =
      (await this.loadEndorsementCountsFor([id])).get(id) ?? 0;
    return { endorsementCount, viewerEndorsed: false };
  }

  async listEndorsers(
    viewerId: string,
    id: string,
    page?: number,
    limit?: number,
  ): Promise<{ count: number; endorsers: EndorserView[] }> {
    // Persona-visibility gate (Task 1): the endorser list — including each
    // endorser's free-text note — must never be enumerable by anyone holding
    // only the persona's UUID. A co-owner (any `subprofile_members` row) may
    // see it regardless of status/visibility (their own draft/private persona);
    // everyone else is held to the SAME public-endorsable gate `endorse`/
    // `follow` funnel through — published, Open, and not blocked either way —
    // which 404s a draft/network/private/removed/blocked persona.
    const isMember = await this.members.findOne({
      where: { subprofileId: id, userId: viewerId },
      select: { id: true },
    });
    if (!isMember) {
      await this.resolveEndorsablePersona(viewerId, id);
    }

    // `count` stays the viewer's full visible total; the returned list is the
    // requested page. Both `page` and `limit` are clamped so a hostile/omitted
    // value can never exceed `ENDORSERS_LIST_CAP` per page.
    const safeLimit = Math.min(
      Math.max(limit ?? ENDORSERS_LIST_CAP, 1),
      ENDORSERS_LIST_CAP,
    );
    const safePage = Math.max(page ?? 1, 1);

    // In-query block filtering (mirrors `directory()`) so `LIMIT` counts only
    // visible rows and `count` reflects the viewer's actually-visible total,
    // not the raw active tally.
    const qb = this.endorsements
      .createQueryBuilder('se')
      .where('se.subprofileId = :id', { id })
      .andWhere('se.withdrawnAt IS NULL');
    this.blockFilter.excludeBlocked(qb, viewerId, '"se"."endorser_id"');
    qb.orderBy('se.createdAt', 'DESC');

    const count = await qb.getCount();
    const rows = await qb
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getMany();

    const endorserProfiles = await this.profiles.find({
      where: { userId: In(rows.map((row) => row.endorserId)) },
    });
    const profileByUserId = new Map(
      endorserProfiles.map((profile) => [profile.userId, profile]),
    );
    const endorsers = rows.map((row) => {
      const profile = profileByUserId.get(row.endorserId);
      return {
        slug: profile?.slug ?? '',
        name: `${profile?.firstName ?? ''} ${profile?.lastName ?? ''}`.trim(),
        // Same `photoVisible` gate `toMemberRef` applies, called directly
        // because `EndorserView` is a narrower shape than `MemberRef`: photo
        // on -> the resolved url, photo off (or no profile row) -> null.
        avatarUrl: toVisibleAvatarUrl(profile),
        note: row.note,
      };
    });
    return { count, endorsers };
  }

  // The viewer's own endorsement standing + note for one persona — backs the
  // lazy prefill the endorse-with-note modal fetches when it opens in edit
  // mode. Reuses `resolveEndorsablePersona` so a blocked/unreachable persona
  // 404s exactly like `endorse`/`withdrawEndorsement` do. `viewerEndorsed` is
  // true only when an ACTIVE (non-withdrawn) row exists; `note` is that row's
  // note (or null), so a withdrawn row reads as "not endorsed, no note".
  async getViewerEndorsement(
    viewerId: string,
    id: string,
  ): Promise<{ viewerEndorsed: boolean; note: string | null }> {
    await this.resolveEndorsablePersona(viewerId, id);
    const active = await this.endorsements.findOne({
      where: { subprofileId: id, endorserId: viewerId, withdrawnAt: IsNull() },
    });
    return {
      viewerEndorsed: active !== null,
      note: active?.note ?? null,
    };
  }

  // Batches the active-endorsement COUNT for many personas into ONE query
  // (mirrors `loadSocialCountsFor`) — avoids an N+1 across every read path
  // (`listMine`, `listForProfile`, `getByHandle`, `ownerDTO`) and is reused
  // even for a single-persona read by passing a one-element id array.
  async loadEndorsementCountsFor(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!ids.length) return counts;
    // Grouped SQL COUNT of active (non-withdrawn) endorsements — one row per
    // persona out of Postgres, rather than pulling every endorsement row into
    // the app to tally.
    const rows = await this.endorsements
      .createQueryBuilder('endorsement')
      .select('endorsement.subprofileId', 'subprofileId')
      .addSelect('COUNT(*)', 'count')
      .where('endorsement.subprofileId IN (:...ids)', { ids })
      .andWhere('endorsement.withdrawnAt IS NULL')
      .groupBy('endorsement.subprofileId')
      .getRawMany<{ subprofileId: string; count: string }>();
    for (const row of rows) counts.set(row.subprofileId, Number(row.count));
    return counts;
  }

  // Batches "did this viewer endorse this persona" for many personas into ONE
  // query — the `viewerEndorsed` companion to `loadEndorsementCountsFor`.
  async viewerEndorsedFor(
    viewerId: string,
    ids: string[],
  ): Promise<Set<string>> {
    const set = new Set<string>();
    if (!ids.length) return set;
    const rows = await this.endorsements.find({
      where: {
        subprofileId: In(ids),
        endorserId: viewerId,
        withdrawnAt: IsNull(),
      },
      select: { subprofileId: true },
    });
    for (const row of rows) set.add(row.subprofileId);
    return set;
  }

  // Fetches a persona by id AND enforces it is publicly endorsable: published,
  // Open visibility, not owner-removed, not under a moderator takedown, and not
  // block-either-way between `userId` (the endorser/viewer) and the persona's
  // owner. Mirrors the gate `getByHandle` applies.
  private async resolveEndorsablePersona(
    userId: string,
    id: string,
  ): Promise<Subprofile> {
    const persona = await this.subprofiles.findOne({
      // Open + published only: `network`/`private` personas are not publicly
      // endorsable/followable and 404 like any other unreachable persona,
      // matching the gate `getByHandle` / `directory` apply.
      where: {
        id,
        status: SubprofileStatus.Published,
        visibility: SubprofileVisibility.Open,
        // A removed persona is unreachable here too, exactly as it is in
        // `directory()` and `listForProfile`. Without this, anyone holding the
        // uuid from before the removal could keep endorsing it (notifying the
        // owner each time) and keep reading the endorser list through
        // `listEndorsers`, which funnels through this same gate.
        removedAt: IsNull(),
      },
    });
    if (!persona) {
      throw new NotFoundException('Subprofile not found');
    }
    // A moderator takedown withholds the persona from every public read path
    // (`dropModeratedSubprofiles` / `excludeModeratedSubprofiles`), so it has
    // to close the write path too. Same predicate, one shared spelling.
    if (await isSubprofileUnderTakedown(this.contentModeration, persona.id)) {
      throw new NotFoundException('Subprofile not found');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, persona.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    return persona;
  }
}
