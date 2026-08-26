/**
 * The support a platform staff member can offer a community that is having a
 * hard time. A fixed, code-defined set, so it is stored as stable keys in a
 * `text[]` column and validated against this list on the way in.
 *
 * Why a registry rather than free strings or a jsonb blob: three surfaces have
 * to agree on the same four things — the admin modal that offers them, the
 * validator that accepts them, and the community's own mod-tools pane that
 * reads them back. A free string would let the offer say something no reader
 * has copy for; a jsonb blob would let the shape drift per row. The frontend
 * keeps its mirror of this list in
 * `queerpulse/src/features/communities/api/communitySupportOffers.api.ts`,
 * where the i18n keys for each option's label live.
 *
 * Retiring an option means leaving its key here (rows already carry it) and
 * dropping it from `OFFERABLE_COMMUNITY_SUPPORT_OPTIONS` below, so an old
 * offer still reads correctly while no new one can be written with it.
 */
export const COMMUNITY_SUPPORT_OPTIONS = [
  /** A staff member writes to the community's moderators directly. */
  'message_moderators',
  /** A named staff member stays alongside the moderators for two weeks. */
  'staff_buddy',
  /** The de-escalation toolkit is shared with the moderation team. */
  'deescalation_toolkit',
  /** Help finding another moderator to share the load. */
  'recruit_moderator',
] as const;

export type CommunitySupportOption = (typeof COMMUNITY_SUPPORT_OPTIONS)[number];

/** The options a NEW offer may name. Same list today; see the note above for
 *  why the two are kept separate. */
export const OFFERABLE_COMMUNITY_SUPPORT_OPTIONS: readonly CommunitySupportOption[] =
  COMMUNITY_SUPPORT_OPTIONS;

/** How many options one offer may name. There are four, and an offer that
 *  names none is not an offer, so this is the whole range. */
export const MIN_SUPPORT_OPTIONS_PER_OFFER = 1;
export const MAX_SUPPORT_OPTIONS_PER_OFFER =
  OFFERABLE_COMMUNITY_SUPPORT_OPTIONS.length;

/** The longest note a staff member may attach. Long enough for a paragraph of
 *  context, short enough that the pane reading it stays a pane. */
export const MAX_SUPPORT_OFFER_NOTE_LENGTH = 1000;

export function isCommunitySupportOption(
  value: string,
): value is CommunitySupportOption {
  return (COMMUNITY_SUPPORT_OPTIONS as readonly string[]).includes(value);
}
