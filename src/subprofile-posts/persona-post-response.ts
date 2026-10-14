import { toImageUrl } from '../common/image-url';
import { SubprofilePost } from './entities/subprofile-post.entity';

// Studio v3 persona post wire shapes (contract `PersonaPost`).

export interface PersonaPost {
  id: string;
  body: string;
  linkUrl: string | null;
  imageUrl: string | null;
  createdAt: string;
  editedAt: string | null;
  /** The caller owns or co-owns the persona. Says nothing about who wrote it. */
  canEdit: boolean;
}

export interface PersonaPostPage {
  items: PersonaPost[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export const EMPTY_PERSONA_POST_PAGE: PersonaPostPage = {
  items: [],
  pageInfo: { nextCursor: null, hasMore: false },
};

/** The author and the persona id never reach the wire. */
export function toPersonaPost(
  post: SubprofilePost,
  canEdit: boolean,
): PersonaPost {
  return {
    id: post.id,
    body: post.body,
    linkUrl: post.linkUrl,
    imageUrl: toImageUrl(post.imageKey),
    createdAt: post.createdAt.toISOString(),
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    canEdit,
  };
}
