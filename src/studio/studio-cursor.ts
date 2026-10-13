/** The home feed's keyset position: the last release a page returned. */
export interface StudioReleaseCursor {
  publishedAt: Date;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeStudioCursor(cursor: StudioReleaseCursor): string {
  return Buffer.from(
    `${cursor.publishedAt.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

/** Never throws: anything malformed reads as "no cursor" (the first page). */
export function decodeStudioCursor(
  cursor: string | undefined,
): StudioReleaseCursor | null {
  if (!cursor) {
    return null;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [isoTimestamp, id, ...extraParts] = decoded.split('|');
  if (!isoTimestamp || !id || extraParts.length > 0 || !UUID_PATTERN.test(id)) {
    return null;
  }
  const publishedAt = new Date(isoTimestamp);
  if (Number.isNaN(publishedAt.getTime())) {
    return null;
  }
  return { publishedAt, id };
}
