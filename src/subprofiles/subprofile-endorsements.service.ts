import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { toImageUrl } from '../common/image-url';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { EndorserView } from './subprofile-response';
import {
  SUBPROFILE_ENDORSED,
  SubprofileEndorsedEvent,
} from './subprofile.events';

// Endorser lists are capped, newest-first — mirrors the vouch page-size
// convention but fixed (not caller-tunable) since the endorse UI shows a
// single avatar cluster, not a paginated page.
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
    private readonly blockFilter: BlockFilterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async endorse(
    endorserId: string,
    id: string,
    note?: string,
  ): Promise<{ endorsementCount: number; viewerEndorsed: boolean }> {
    const persona = await this.resolveEndorsablePersona(endorserId, id);
    if (persona.userId === endorserId) {
      throw new BadRequestException('You cannot endorse your own persona');
    }

    // Empty/whitespace-only notes are stored as null, not "" — mirrors
    // `VouchService.createVouch`.
    const trimmedNote = note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;

    const existing = await this.endorsements.findOne({
      where: { subprofileId: id, endorserId },
    });

    // Upsert mirroring `VouchService.createVouch`, EXCEPT for the
    // already-active case: a vouch 409s on a duplicate, but endorsing is a
    // one-tap UX action, so re-tapping an already-endorsed persona is treated
    // as idempotent success (current count, viewerEndorsed: true) rather than
    // an error. `justActivated` tracks whether a real active→inactive
    // transition happened, so the notification event fires once per genuine
    // endorse (not on every repeat tap).
    let justActivated = false;
    if (existing && existing.withdrawnAt === null) {
      // Already active — this is a note EDIT, not a fresh endorse: update the
      // note in place and DON'T set `justActivated` (no new SUBPROFILE_ENDORSED
      // event fires for a note edit). Idempotent when the note is unchanged —
      // re-writing the same value is a harmless no-op.
      await this.endorsements.update({ id: existing.id }, { note: cleanNote });
    } else if (existing) {
      // Withdrawn → reactivate in place (keeps id/createdAt). Conditional on
      // the row still being withdrawn so two concurrent re-endorses can't both
      // emit: only the update that actually flips a `withdrawnAt IS NOT NULL`
      // row reports `affected === 1` and fires the notification below.
      const reactivateResult = await this.endorsements.update(
        { id: existing.id, withdrawnAt: Not(IsNull()) },
        { withdrawnAt: null, note: cleanNote },
      );
      justActivated = reactivateResult.affected === 1;
    } else {
      try {
        await this.endorsements.insert({
          subprofileId: id,
          endorserId,
          note: cleanNote,
        });
        justActivated = true;
      } catch (err) {
        if (!isUniqueViolation(err)) {
          throw err;
        }
        // Lost a race to a concurrent endorse for the same (persona, endorser)
        // pair — the row now exists and is active; treat as idempotent
        // success rather than surfacing a 409.
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
  ): Promise<{ count: number; endorsers: EndorserView[] }> {
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
    const rows = await qb.take(ENDORSERS_LIST_CAP).getMany();

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
        avatarUrl: toImageUrl(profile?.avatarUrl),
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
    const rows = await this.endorsements.find({
      where: { subprofileId: In(ids), withdrawnAt: IsNull() },
      select: { subprofileId: true },
    });
    for (const row of rows)
      counts.set(row.subprofileId, (counts.get(row.subprofileId) ?? 0) + 1);
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
  // Open visibility, and not block-either-way between `userId` (the
  // endorser/viewer) and the persona's owner. Mirrors the gate `getByHandle`
  // applies.
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
      },
    });
    if (!persona) {
      throw new NotFoundException('Subprofile not found');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, persona.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    return persona;
  }
}
