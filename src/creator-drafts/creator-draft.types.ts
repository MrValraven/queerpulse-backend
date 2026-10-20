import type { MemberRef } from '../common/member-ref';
import type { StudioReleaseResponse } from '../studio/studio-response';
import type { SubprofilePublicView } from '../subprofiles/subprofile-response';
import type { CreatorDraftKind } from './creator-drafts.constants';

export interface CreatorDraftProgress {
  done: number;
  total: number;
}

/** Who a draft is for. `slug` is null when there is no live page to link. */
export interface CreatorDraftMadeFor {
  kind: 'community' | 'listing' | 'persona';
  name: string;
  slug: string | null;
}

/** The draft's author as staff see it. `userId` rides along because the
 * reach-out route is keyed by it. */
export interface CreatorDraftOwner extends MemberRef {
  userId: string;
}

export interface AdminCreatorDraftRow {
  kind: CreatorDraftKind;
  id: string;
  title: string | null;
  madeFor: CreatorDraftMadeFor | null;
  owner: CreatorDraftOwner | null;
  lastSavedAt: string;
  progress: CreatorDraftProgress | null;
  missing: string[] | null;
}

export interface CreatorDraftSaved {
  revision: number;
  savedAt: string;
}

export interface CreatorDraftResponse {
  payload: Record<string, unknown>;
  payloadVersion: number;
  revision: number;
  savedAt: string;
}

/** The 409 body. Both fields are null when the slot holds no live row. */
export interface CreatorDraftConflictBody {
  code: 'creator_draft_revision_conflict';
  message: string;
  revision: number | null;
  savedAt: string | null;
}

export type EventDraftPreview = Record<string, unknown> & {
  community: { slug: string; name: string } | null;
  /** `slug` is null when the listing is not live. */
  runByListing: { slug: string | null; name: string } | null;
};

export type CommunityDraftPreview = Record<string, unknown>;

/** Allow-listed listing draft fields; image fields may be null. */
export type ListingDraftPreview = Record<string, unknown>;

export type AdminCreatorDraftDetail = AdminCreatorDraftRow &
  (
    | { kind: 'persona'; preview: SubprofilePublicView }
    | { kind: 'studio_release'; preview: StudioReleaseResponse }
    | {
        kind: 'studio_episode';
        preview: StudioReleaseResponse;
        episodeTrackId: string;
      }
    | { kind: 'listing'; preview: ListingDraftPreview }
    | {
        kind: 'listing_edit';
        preview: ListingDraftPreview;
        listing: { ref: string; slug: string | null; name: string };
      }
    | { kind: 'event'; preview: EventDraftPreview }
    | { kind: 'community'; preview: CommunityDraftPreview }
  );
