import { StudioPlaylistPerson } from './studio-playlist-response';
import {
  StudioPrice,
  StudioPurchaseRefusalCode,
} from './studio-purchase-rules';
import { StudioArtistRef } from './studio-response';
import {
  StudioSupporterIdentity,
  StudioSupporterOption,
} from './studio-supporters';

/*
 * Wire shapes of the Studio purchases feature (contract
 * QUEERPULSE-STUDIO-PURCHASES-CONTRACT-2026-10-28, sections 2 and 3). Types
 * only: dates are ISO strings with millisecond precision and money is
 * integer euro cents. No shape carries a buyer's user id.
 */

export type { StudioPrice };

/** Contract 2.2 `StudioPaymentMethod`, renamed here so it never collides
 *  with the `StudioPaymentMethod` entity class. */
export interface StudioPaymentMethodResponse {
  /** Regenerated on every effective save; a render key only. */
  id: string;
  kind: 'link' | 'mbway' | 'iban';
  label: string | null;
  /** Canonical: the https URL, 9 MB WAY digits, uppercase IBAN without
   *  spaces. */
  value: string;
  note: string | null;
  /** 0 to 7. */
  position: number;
}

/** Contract 2.2: `GET` and `PUT /studio/artists/:subprofileId/payment-methods`. */
export interface StudioPaymentMethods {
  /** Position ascending. */
  methods: StudioPaymentMethodResponse[];
  /** True while the persona's releases or their tracks carry a price; the
   *  editor warns before the last method goes. */
  hasItemsForSale: boolean;
  /** Latest row `updated_at`; null when empty. */
  updatedAt: string | null;
}

/** Contract 3.0: the item a purchase or an offer is about. */
export interface StudioPurchaseItem {
  kind: 'release' | 'track';
  /** The live title while the item exists, else the `item_title` snapshot. */
  title: string;
  /** A track purchase: the track's release while both exist. */
  releaseId: string | null;
  trackId: string | null;
  /** Live release type while the release exists; drives "Digital album / EP
   *  / single / track". */
  releaseType: string | null;
  /** `toImageUrl(release.cover_key)`. */
  coverUrl: string | null;
  /** False once the release or track row is gone. */
  isAvailable: boolean;
}

/** Contract 3.0: the artist a purchase paid. */
export interface StudioPurchaseArtist {
  /** Live display name while the persona exists, else the `artist_name`
   *  snapshot. */
  name: string;
  subprofileId: string | null;
  handle: string | null;
  /** `listenablePersonaSql` on the persona; false renders as text. */
  isLinkable: boolean;
}

/** Contract 3.0. */
export type StudioPurchaseStatusValue =
  'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';

/** Contract 3.1: `viewer.state`. */
export type StudioOfferViewerState =
  'can_buy' | 'pending' | 'owned' | 'refused';

/** Contract 3.1. */
export interface StudioOfferViewer {
  state: StudioOfferViewerState;
  /** Set when state is 'refused'. */
  refusalCode: StudioPurchaseRefusalCode | null;
  /** The caller's pending purchase of this item (reference code, amount,
   *  wall). */
  pendingPurchase: StudioBuyerPurchase | null;
  /** The confirmed purchase that grants this item: the track's own, or its
   *  release's. Its `downloads` list the tracks. */
  ownedPurchase: StudioBuyerPurchase | null;
}

/** Contract 3.1: one priced track of a release offer, ids only. */
export interface StudioTrackOffer {
  trackId: string;
  position: number;
  title: string;
  price: StudioPrice;
  state: StudioOfferViewerState;
  refusalCode: StudioPurchaseRefusalCode | null;
  pendingPurchaseId: string | null;
  ownedPurchaseId: string | null;
}

/** Contract 3.1: `GET /studio/releases/:releaseId/offer` and the track
 *  twin. */
export interface StudioOffer {
  item: StudioPurchaseItem;
  artist: StudioArtistRef;
  price: StudioPrice | null;
  viewer: StudioOfferViewer;
  /** Only while viewer.state is 'can_buy' or 'pending'; [] otherwise. */
  paymentMethods: StudioPaymentMethodResponse[];
  /** The wall identity picker: "Your account" first, then every persona the
   *  caller is a member of (artist persona excluded). [] unless viewer.state
   *  is 'can_buy'. */
  identityOptions: StudioSupporterOption[];
  /** Release offer only: every track of the release with a price, position
   *  ascending. Absent on the track offer. */
  trackOffers?: StudioTrackOffer[];
}

/** Contract 3.7: what a download of one track would answer now. */
export type StudioDownloadRefusalCode =
  | 'studio_download_release_taken_down'
  | 'studio_download_artist_unavailable'
  | 'studio_download_track_withheld'
  | 'studio_download_track_not_ready'
  | 'studio_download_track_preparing';

/** Contract 3.2: one track a confirmed purchase covers. */
export interface StudioPurchaseDownloadTrack {
  trackId: string;
  position: number;
  title: string;
  durationSeconds: number | null;
  /** From the stored content type: 'mp3' for audio/mpeg, 'm4a' for
   *  audio/mp4; null without audio. */
  format: 'mp3' | 'm4a' | null;
  /** The code the download route would answer for this track now; null when
   *  it downloads. */
  unavailableReason: StudioDownloadRefusalCode | null;
}

/** Contract 3.2: the buyer's own view of a purchase. */
export interface StudioBuyerPurchase {
  id: string;
  status: StudioPurchaseStatusValue;
  item: StudioPurchaseItem;
  artist: StudioPurchaseArtist;
  amountCents: number;
  referenceCode: string;
  payerName: string | null;
  declineReason: 'payment_not_found' | 'amount_different' | 'other' | null;
  declineNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  wall: {
    isOnWall: boolean;
    /** The chosen identity; null when isOnWall is false or the chosen
     *  persona is gone. */
    shownAs: StudioSupporterIdentity | null;
    /** isOnWall, a persona was chosen, and it no longer resolves: the row
     *  asks to pick again. */
    needsNewIdentity: boolean;
  };
  /** Confirmed only, else []. A release purchase lists the release's current
   *  tracks (position ascending); a track purchase lists that track. */
  downloads: StudioPurchaseDownloadTrack[];
}

/** Contract 3.4: `GET` and `PUT /studio/purchases/:purchaseId/wall`. */
export interface StudioPurchaseWallState {
  isOnWall: boolean;
  /** Null shows the account. */
  shownAsSubprofileId: string | null;
  shownAs: StudioSupporterIdentity | null;
  needsNewIdentity: boolean;
  options: StudioSupporterOption[];
}

/** Contract 3.5: one entry of `GET /studio/releases/:releaseId/wall`. */
export interface StudioWallEntry {
  /** 'account:' plus an opaque per-row key, or 'persona:' plus the persona
   *  id. Never a user id. */
  key: string;
  identity: StudioSupporterIdentity;
}

/** Contract 4.4: `POST /studio/purchases/reference-code`. */
export interface StudioPurchaseReference {
  /** Six picks of `STUDIO_REFERENCE_CODE_ALPHABET`. */
  referenceCode: string;
  /** `base64url(expiresAtEpochSeconds) + '.' + base64url(HMAC)`. */
  referenceToken: string;
  /** ISO, now plus 7 days. */
  expiresAt: string;
}

/** Contract 3.7: the answer of the download route. */
export interface StudioPurchaseDownload {
  /** Presigned GET, attachment disposition. */
  url: string;
  expiresAt: string;
  /** The sanitised name signed into the disposition. */
  fileName: string;
}

/** Contract 3.8 and 3.10: a purchase as the artist's persona members see
 *  it. */
export interface StudioSellerPurchase {
  id: string;
  status: StudioPurchaseStatusValue;
  item: StudioPurchaseItem;
  amountCents: number;
  referenceCode: string;
  payerName: string | null;
  /** `toMemberRef` then `toStudioPlaylistPerson` (photo setting honoured, no
   *  user id). Null is a deleted account. Always the account, whatever the
   *  wall choice. */
  buyer: StudioPlaylistPerson | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Contract 3.10: `GET /studio/artists/:subprofileId/sales/totals`.
 *  Confirmed rows only, unfloored. */
export interface StudioSalesTotals {
  /** `decided_at >= now() - interval '28 days'`. */
  last28Days: { amountCents: number; count: number };
  allTime: { amountCents: number; count: number };
}

/** Contract 3.11: `GET /studio/sales/pending-count`. */
export interface StudioSalesPendingCount {
  /** The menu dot. */
  count: number;
  /** The per-persona page link badge, count above 0 only. */
  byPersona: { subprofileId: string; count: number }[];
}
