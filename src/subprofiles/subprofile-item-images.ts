import type { ItemStructured } from './entities/subprofile-item.entity';

export type ItemImageCarrier = {
  imageUrl?: string | null;
  structured?: ItemStructured | null;
};

function isNonEmptyRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Every image ref an item stores: imageUrl, structured.coverUp.beforeImageUrl
 * and each structured.sessions[].imageUrl. Non-empty strings in stored order,
 * duplicates kept.
 */
export function listItemImageRefs(item: ItemImageCarrier): string[] {
  const refs: string[] = [];
  if (isNonEmptyRef(item.imageUrl)) {
    refs.push(item.imageUrl);
  }
  const beforeImageUrl = item.structured?.coverUp?.beforeImageUrl;
  if (isNonEmptyRef(beforeImageUrl)) {
    refs.push(beforeImageUrl);
  }
  for (const session of item.structured?.sessions ?? []) {
    if (isNonEmptyRef(session?.imageUrl)) {
      refs.push(session.imageUrl);
    }
  }
  return refs;
}

/**
 * Returns a copy of the item with every non-empty image ref passed through
 * `rewrite`. A null result clears the ref: imageUrl becomes null and a nested
 * ref becomes "" so the nested shapes keep their string type. The input is not
 * modified.
 */
export function mapItemImageRefs<Item extends ItemImageCarrier>(
  item: Item,
  rewrite: (ref: string) => string | null,
): Item {
  const result: Item = { ...item };
  if (isNonEmptyRef(item.imageUrl)) {
    result.imageUrl = rewrite(item.imageUrl);
  }
  if (!item.structured) {
    return result;
  }
  const structured: ItemStructured = { ...item.structured };
  const coverUp = item.structured.coverUp;
  if (coverUp && isNonEmptyRef(coverUp.beforeImageUrl)) {
    structured.coverUp = {
      ...coverUp,
      beforeImageUrl: rewrite(coverUp.beforeImageUrl) ?? '',
    };
  }
  const sessions = item.structured.sessions;
  if (Array.isArray(sessions)) {
    structured.sessions = sessions.map((session) =>
      session && isNonEmptyRef(session.imageUrl)
        ? { ...session, imageUrl: rewrite(session.imageUrl) ?? '' }
        : session,
    );
  }
  result.structured = structured;
  return result;
}
