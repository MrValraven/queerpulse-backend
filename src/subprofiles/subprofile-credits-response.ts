// Wire views for the persona credit graph (directory card credits and the
// "Made together" strip) plus their pure mappers. Shapes are the frozen
// contract mirrored by the frontend `subprofiles.api.ts` `*DTO` types. No DB
// access: the rules live in `subprofile-credit-graph.ts`, the loading in
// `SubprofileCreditGraphService`.

import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { SubprofileKind } from './entities/subprofile.entity';
import type {
  CardCreditsSummary,
  CreditPersonaIdentity,
} from './subprofile-credit-graph';
import { CARD_CREDIT_FACE_LIMIT } from './subprofile-credit-graph';

export interface CreditFaceView {
  kind: 'persona' | 'member';
  name: string;
  avatarUrl: string | null;
  accent: string | null;
}

export interface CardCreditsView {
  count: number;
  /** At most three, newest shared item first. */
  faces: CreditFaceView[];
}

export interface MadeTogetherPersonaView {
  handle: string;
  displayName: string;
  kind: SubprofileKind;
  avatarUrl: string | null;
  avatarCrop?: CropRect;
  accent: string | null;
}

export interface MadeTogetherItemView {
  itemId: string;
  title: string;
  imageUrl: string | null;
  imageCrop?: CropRect;
  createdAt: string;
  author: MadeTogetherPersonaView;
  partner: MadeTogetherPersonaView;
}

export interface MadeTogetherResponse {
  items: MadeTogetherItemView[];
}

/** A card with nobody credited, the safe default for `toCardDTO`. A fresh
 *  object per call, so no two cards ever share one `faces` array. */
export function emptyCardCredits(): CardCreditsView {
  return { count: 0, faces: [] };
}

/** Card credits from the pure summary, resolving each face's stored image. */
export function toCardCreditsView(
  summary: CardCreditsSummary,
): CardCreditsView {
  return {
    count: summary.count,
    faces: summary.faces.slice(0, CARD_CREDIT_FACE_LIMIT).map((face) => ({
      kind: face.kind,
      name: face.name,
      avatarUrl: toImageUrl(face.avatarUrl),
      accent: face.accent,
    })),
  };
}

/** One credited item of the "Made together" strip, before mapping. */
export interface MadeTogetherSource {
  item: {
    id: string;
    title: string;
    /** RAW stored value of `subprofile_items.image_url`. */
    imageUrl: string | null;
    createdAt: Date;
  };
  author: CreditPersonaIdentity;
  partner: CreditPersonaIdentity;
}

// Names are each persona's own display name and the link is its handle only:
// no owner slug, owner name, link visibility or persona id ever leaves here.
function toMadeTogetherPersonaView(
  persona: CreditPersonaIdentity,
  crops: Map<string, CropRect>,
): MadeTogetherPersonaView {
  return {
    handle: persona.handle ?? '',
    displayName: persona.displayName,
    kind: persona.kind,
    avatarUrl: toImageUrl(persona.avatarUrl),
    avatarCrop: cropFor(persona.avatarUrl, crops),
    accent: persona.accent,
  };
}

/** The "Made together" response from already-chosen items. */
export function toMadeTogetherView(
  sources: readonly MadeTogetherSource[],
  crops: Map<string, CropRect> = new Map(),
): MadeTogetherResponse {
  return {
    items: sources.map(({ item, author, partner }) => ({
      itemId: item.id,
      title: item.title,
      imageUrl: toImageUrl(item.imageUrl),
      imageCrop: cropFor(item.imageUrl, crops),
      createdAt: item.createdAt.toISOString(),
      author: toMadeTogetherPersonaView(author, crops),
      partner: toMadeTogetherPersonaView(partner, crops),
    })),
  };
}
