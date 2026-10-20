import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  creatorDraftExpiryCutoff,
  deleteCreatorDraftWithin,
  readCreatorDraftWithin,
  saveCreatorDraftWithin,
  type CreatorDraftSlot,
} from './creator-draft-store';
import { CreatorDraftMadeForService } from './creator-draft-made-for.service';
import {
  CREATOR_DRAFT_LIMITS,
  DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
  creatorDraftError,
  creatorDraftRevisionConflict,
} from './creator-drafts.constants';
import type {
  CreatorDraftResponse,
  CreatorDraftSaved,
} from './creator-draft.types';
import { SaveCreatorDraftDto } from './dto/save-creator-draft.dto';

/** Postgres jsonb and text[] both reject U+0000, so a save carrying one
 *  answers 400 before it reaches the database. */
const NUL_CHARACTER = String.fromCharCode(0);
/** JSON.stringify writes U+0000 as the six characters `\u0000`; the
 *  lookbehind counts backslashes so an escaped backslash followed by the
 *  text `u0000` stays allowed. */
const ESCAPED_NUL_PATTERN = /(?<!\\)(?:\\\\)*\\u0000/;
/** JSON.stringify writes a paired surrogate as the character itself and an
 *  unpaired one as a `\udXXX` escape, which Postgres jsonb rejects; the same
 *  backslash count keeps the escaped text `\\ud800` allowed. */
const ESCAPED_LONE_SURROGATE_PATTERN =
  /(?<!\\)(?:\\\\)*\\ud[89a-f][0-9a-f]{2}/i;
/** An unpaired surrogate in a plain string (a missing code). */
const LONE_SURROGATE_PATTERN =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Which of the caller's slots a creator route addresses. */
export type CreatorDraftTarget =
  | { kind: 'event' }
  | { kind: 'community' }
  | { kind: 'listing_edit'; listingRef: string };

/** A resolved target: the slot, plus the listing a listing edit is made for. */
interface ResolvedCreatorDraftTarget {
  slot: CreatorDraftSlot;
  listingId: string | null;
}

/**
 * The creator's own draft slots. Every read and write is keyed by the
 * caller's user id, so a member only ever reaches their own rows. Nothing
 * here hands a payload, a title or a name to a logger or an error message.
 */
@Injectable()
export class CreatorDraftsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly madeFor: CreatorDraftMadeForService,
  ) {}

  async getDraft(
    userId: string,
    target: CreatorDraftTarget,
  ): Promise<{ draft: CreatorDraftResponse | null }> {
    const { slot } = await this.resolveTarget(userId, target);
    const stored = await readCreatorDraftWithin(
      this.dataSource.manager,
      slot,
      this.expiryCutoff(),
    );
    if (!stored) return { draft: null };
    return {
      draft: {
        payload: stored.payload,
        payloadVersion: stored.payloadVersion,
        revision: stored.revision,
        savedAt: stored.updatedAt.toISOString(),
      },
    };
  }

  /**
   * Size first (before any read), then the slot, then the progress bounds,
   * then the made-for refs (events only), then one conditional save. A
   * mismatch writes nothing and answers 409 with the live row, or with nulls
   * when the slot holds none.
   */
  async saveDraft(
    userId: string,
    target: CreatorDraftTarget,
    body: SaveCreatorDraftDto,
  ): Promise<CreatorDraftSaved> {
    const serializedPayload = JSON.stringify(body.payload);
    const payloadBytes = Buffer.byteLength(serializedPayload, 'utf8');
    if (payloadBytes > CREATOR_DRAFT_LIMITS.payloadMaxBytes) {
      throw creatorDraftError('creator_draft_too_large');
    }
    if (
      ESCAPED_NUL_PATTERN.test(serializedPayload) ||
      (body.missing ?? []).some((code) => code.includes(NUL_CHARACTER))
    ) {
      throw new BadRequestException([
        'payload and missing must not contain a NUL character',
      ]);
    }
    if (
      ESCAPED_LONE_SURROGATE_PATTERN.test(serializedPayload) ||
      (body.missing ?? []).some((code) => LONE_SURROGATE_PATTERN.test(code))
    ) {
      throw new BadRequestException([
        'payload and missing must not contain an unpaired surrogate',
      ]);
    }
    const { slot, listingId } = await this.resolveTarget(userId, target);
    if (body.progress && body.progress.done > body.progress.total) {
      throw new BadRequestException([
        'progress.done must not be greater than progress.total',
      ]);
    }
    const madeFor = await this.resolveMadeFor(userId, target, body, listingId);
    const outcome = await saveCreatorDraftWithin(
      this.dataSource.manager,
      slot,
      {
        payload: body.payload,
        payloadVersion: body.payloadVersion,
        baseRevision: body.baseRevision,
        progress: body.progress
          ? { done: body.progress.done, total: body.progress.total }
          : null,
        missing: body.missing,
        madeForCommunityId: madeFor.madeForCommunityId,
        madeForListingId: madeFor.madeForListingId,
      },
      this.expiryCutoff(),
    );
    if (!outcome.isSaved) {
      throw creatorDraftRevisionConflict({
        revision: outcome.current?.revision ?? null,
        savedAt: outcome.current?.savedAt.toISOString() ?? null,
      });
    }
    return {
      revision: outcome.revision,
      savedAt: outcome.savedAt.toISOString(),
    };
  }

  /** Empties the caller's slot. Answers the same on an empty slot. A listing
   *  edit is found by its listing id alone: an author who no longer manages
   *  the listing can still discard their own draft. */
  async discardDraft(
    userId: string,
    target: CreatorDraftTarget,
  ): Promise<void> {
    const slot = await this.resolveDiscardSlot(userId, target);
    await deleteCreatorDraftWithin(this.dataSource.manager, slot);
  }

  private async resolveDiscardSlot(
    userId: string,
    target: CreatorDraftTarget,
  ): Promise<CreatorDraftSlot> {
    if (target.kind !== 'listing_edit') {
      return { userId, kind: target.kind, slotKey: '' };
    }
    const listingId = await this.madeFor.findListingIdByRef(target.listingRef);
    if (!listingId)
      throw creatorDraftError('creator_draft_listing_unavailable');
    return { userId, kind: 'listing_edit', slotKey: listingId };
  }

  /** A listing edit is keyed by the listing id, and only for a listing the
   *  caller owns or actively co-manages; anything else is 404. */
  private async resolveTarget(
    userId: string,
    target: CreatorDraftTarget,
  ): Promise<ResolvedCreatorDraftTarget> {
    if (target.kind !== 'listing_edit') {
      return {
        slot: { userId, kind: target.kind, slotKey: '' },
        listingId: null,
      };
    }
    const listing = await this.madeFor.findManageableListingByRef(
      userId,
      target.listingRef,
    );
    if (!listing) throw creatorDraftError('creator_draft_listing_unavailable');
    return {
      slot: { userId, kind: 'listing_edit', slotKey: listing.id },
      listingId: listing.id,
    };
  }

  /** Every listing edit names its listing, so the nightly purge of listing
   *  edits with a null listing only ever removes orphans. */
  private async resolveMadeFor(
    userId: string,
    target: CreatorDraftTarget,
    body: SaveCreatorDraftDto,
    listingId: string | null,
  ): Promise<{
    madeForCommunityId: string | null;
    madeForListingId: string | null;
  }> {
    if (target.kind === 'event') {
      const refs = await this.madeFor.resolveEventRefs(userId, body.payload);
      return {
        madeForCommunityId: refs.madeForCommunityId,
        madeForListingId: refs.madeForListingId,
      };
    }
    return { madeForCommunityId: null, madeForListingId: listingId };
  }

  private expiryCutoff(): Date {
    return creatorDraftExpiryCutoff(
      new Date(),
      this.config.get<number>(
        'retention.creatorDraftDays',
        DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
      ),
    );
  }
}
