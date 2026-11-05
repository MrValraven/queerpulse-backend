import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import type { Subprofile } from './entities/subprofile.entity';
import type {
  PersonaWallFillOrder,
  PersonaWallPublicState,
  PersonaWallSource,
} from './persona-wall.constants';
import type { SubprofileCardView } from './subprofile-response';

/** The only persona columns the admin wall reads. No owner field is in the
 *  list, so none can reach a response. */
export const PERSONA_WALL_PERSONA_FIELDS = [
  'id',
  'handle',
  'displayName',
  'kind',
  'avatarUrl',
  'coverUrl',
  'accent',
] as const;

/** A persona row holding exactly the columns above. */
export type PersonaWallPersonaRow = Pick<
  Subprofile,
  (typeof PERSONA_WALL_PERSONA_FIELDS)[number]
>;

/** The persona-only projection the admin wall shows. */
export interface PersonaWallPersonaDTO {
  id: string;
  handle: string | null;
  displayName: string;
  kind: string;
  /** The avatar, else the cover, else `null`. */
  imageUrl: string | null;
  /** The crop that goes with `imageUrl`. */
  imageCrop: CropRect | null;
  imageSource: 'avatar' | 'cover' | null;
  /** The persona's own palette key. A persona column, so it says nothing
   *  about the owner. */
  accent: string | null;
}

/** One pick in the admin list, in position order. */
export interface PersonaWallPickDTO {
  /** The pick id. */
  id: string;
  /** 1-based place in position order. */
  position: number;
  persona: PersonaWallPersonaDTO;
  publicState: PersonaWallPublicState;
}

/** One preview tile: the directory card plus where it came from. */
export type PersonaWallPreviewCardDTO = SubprofileCardView & {
  wallSource: PersonaWallSource;
};

/** What every admin wall route answers. */
export interface PersonaWallAdminDTO {
  fillOrder: PersonaWallFillOrder;
  picks: PersonaWallPickDTO[];
  /** 0..9 tiles, computed without a viewer block filter. */
  preview: PersonaWallPreviewCardDTO[];
}

/** One row of the admin picker search. */
export interface PersonaWallSearchResultDTO {
  persona: PersonaWallPersonaDTO;
  isPicked: boolean;
}

/** The public wall: the directory cards, 0..9, in wall order. */
export interface PersonaWallPublicResponse {
  items: SubprofileCardView[];
}

/** Maps a persona row to the persona-only projection. The avatar wins when it
 *  resolves to a URL, then the cover, and the crop is the one stored for that
 *  same key. The object is built field by field and the row is never spread. */
export function toPersonaWallPersona(
  row: PersonaWallPersonaRow,
  crops: Map<string, CropRect>,
): PersonaWallPersonaDTO {
  const avatarImageUrl = toImageUrl(row.avatarUrl);
  const coverImageUrl = avatarImageUrl ? null : toImageUrl(row.coverUrl);
  const imageSource = avatarImageUrl
    ? 'avatar'
    : coverImageUrl
      ? 'cover'
      : null;
  const imageKey =
    imageSource === 'avatar'
      ? row.avatarUrl
      : imageSource === 'cover'
        ? row.coverUrl
        : null;
  return {
    id: row.id,
    handle: row.handle ?? null,
    displayName: row.displayName,
    kind: row.kind,
    imageUrl: avatarImageUrl ?? coverImageUrl,
    imageCrop: cropFor(imageKey, crops) ?? null,
    imageSource,
    accent: row.accent ?? null,
  };
}

/** Maps a pick row and its persona to the admin list entry. `position` is the
 *  1-based place in position order. */
export function toPersonaWallPick(
  pickId: string,
  position: number,
  row: PersonaWallPersonaRow,
  crops: Map<string, CropRect>,
  publicState: PersonaWallPublicState,
): PersonaWallPickDTO {
  return {
    id: pickId,
    position,
    persona: toPersonaWallPersona(row, crops),
    publicState,
  };
}

/** Maps a persona row to a picker search result, flagged when it is already
 *  a pick. */
export function toPersonaWallSearchResult(
  row: PersonaWallPersonaRow,
  crops: Map<string, CropRect>,
  isPicked: boolean,
): PersonaWallSearchResultDTO {
  return { persona: toPersonaWallPersona(row, crops), isPicked };
}
