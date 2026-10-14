/** The persona post page's keyset position: the last post a page returned. */
export interface PersonaPostCursor {
  createdAt: Date;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodePersonaPostCursor(cursor: PersonaPostCursor): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

/** Never throws: anything malformed reads as "no cursor" (the first page). */
export function decodePersonaPostCursor(
  cursor: string | undefined,
): PersonaPostCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [isoTimestamp, id, ...extraParts] = decoded.split('|');
  if (!isoTimestamp || !id || extraParts.length > 0 || !UUID_PATTERN.test(id)) {
    return null;
  }
  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return { createdAt, id };
}
