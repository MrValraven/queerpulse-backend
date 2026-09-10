import type { MentionNameKind } from './resolve-mention-names.query';

/**
 * One mention, named. Carries the `kind`/`slug` back so the client can key it
 * against the token it parsed without re-deriving anything, plus the display
 * name to render in the token's place.
 *
 * Deliberately three fields and no more: this is a rendering aid for text the
 * viewer is already looking at, not a member/community lookup. No avatar, no
 * id, no tagline — a caller that needs those has the entity's own endpoint.
 * A ref that resolves to nothing is simply absent from the response, which is
 * how the client knows to keep rendering the raw `sigil + slug`.
 */
export interface ResolvedMentionNameResponse {
  kind: MentionNameKind;
  slug: string;
  name: string;
}
