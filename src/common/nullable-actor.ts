/**
 * Helpers for reading actor columns that can be NULL because their author's
 * account was erased.
 *
 * `SetNullContentAuthorFksOnUserErasure1794610000000` flipped eleven content
 * FKs to `users` from `ON DELETE CASCADE` to `ON DELETE SET NULL`, so
 * `events.host_id`, `listings.owner_id`, `company_reviews.author_id` and
 * their siblings are now `string | null`. The two shapes every read path hits
 * are the same everywhere: build a batch of ids to look profiles up by, and
 * read one row's actor out of the resulting map. Both are here so no caller
 * has to reach for a non-null assertion or a `'unknown'` sentinel id, which
 * would send a lookup for a user that no longer exists.
 *
 * The display side needs nothing new: `toMemberRef` (`common/member-ref.ts`)
 * and `toOrganizerView` (`events/event-response.ts`) already return `null`
 * for a missing profile, which is exactly what an erased author should
 * serialize as.
 */

/**
 * Narrows a batch of actor ids to the ones still pointing at a user, so a
 * NULL from an erased account never reaches an `In([...])` lookup.
 */
export function presentActorIds(
  actorIds: ReadonlyArray<string | null>,
): string[] {
  return actorIds.filter((actorId): actorId is string => actorId !== null);
}

/**
 * Reads one actor out of a pre-batched lookup, treating an erased author
 * (NULL id) the same way an id with no profile row is already treated:
 * `undefined`, which every `toMemberRef`/`toOrganizerView` mapper turns into
 * a `null` in the DTO.
 */
export function actorFromLookup<TValue>(
  lookup: ReadonlyMap<string, TValue>,
  actorId: string | null,
): TValue | undefined {
  return actorId === null ? undefined : lookup.get(actorId);
}
