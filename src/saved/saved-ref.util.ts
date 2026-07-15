import { BadRequestException } from '@nestjs/common';
import { SavedKind } from './entities/saved-item.entity';

const KNOWN_KINDS = new Set<string>(Object.values(SavedKind));

/** A saved item's subject, decomposed from the frontend's composite id. */
export interface SavedRef {
  subjectType: SavedKind;
  subjectId: string;
}

/**
 * Parses the frontend's conventional composite id (`${kind}:${slug}`, see
 * `SavedItemDTO.id` in `saved.api.ts`) into the polymorphic `(subjectType,
 * subjectId)` pair the entity stores. The frontend always sends this shape —
 * `encodeURIComponent`d in the URL, decoded back to plain text by Nest's
 * router before this ever sees it — so anything else is a malformed request.
 *
 * Splits on the FIRST colon only: a slug is free to contain further colons.
 */
export function parseSavedRef(raw: string): SavedRef {
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) {
    throw new BadRequestException(
      'Saved item id must be of the form "<kind>:<subjectId>"',
    );
  }

  const subjectType = raw.slice(0, sep);
  const subjectId = raw.slice(sep + 1);

  if (!KNOWN_KINDS.has(subjectType)) {
    throw new BadRequestException(`Unknown saved item kind: ${subjectType}`);
  }

  return { subjectType: subjectType as SavedKind, subjectId };
}

/** Reconstructs the frontend's composite id from the stored subject. */
export function toSavedId(subjectType: SavedKind, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}
