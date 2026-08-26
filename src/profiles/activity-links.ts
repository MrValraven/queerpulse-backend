/**
 * The frontend paths a profile activity row can point at.
 *
 * Every one of these addresses a page that is already public to anyone who can
 * see the row: `ActivityListener` only writes a row for a public subject, and
 * `ActivityVisibilityService` re-checks that the subject is still public
 * before the row is served. A link is never the thing that grants access; it
 * is a shortcut to a page the reader could have browsed to.
 *
 * Kept here as one small module rather than inline template literals so the
 * shapes have a single definition on this side of the wire. They mirror the
 * frontend's `routeMap.ts` (`communityPath`, `thread`, `nestedPersonaPath`)
 * and `features/communities/communityPostPath.ts`; changing a route there
 * means changing it here.
 */

/** A gathering's detail page (`/gatherings/:slug`). */
export const gatheringPath = (slug: string): string => `/gatherings/${slug}`;

/** A forum thread's detail page (`/thread/:slug`). */
export const threadPath = (slug: string): string => `/thread/${slug}`;

/** A community's detail page (`/community/:slug`). */
export const communityPath = (slug: string): string => `/community/${slug}`;

/** One community post's permalink (`/community/:slug/post/:postId`). */
export const communityPostPath = (slug: string, postId: string): string =>
  `${communityPath(slug)}/post/${postId}`;

/** A linked persona nested under its owner's main profile. */
export const nestedPersonaPath = (
  ownerSlug: string,
  personaSlug: string,
): string => `/members/${ownerSlug}/${personaSlug}`;
