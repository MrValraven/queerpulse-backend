import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';

/** A playlist list's keyset position: `(updated_at desc, id desc)`. Same
 *  opaque encoding as the release cursor; a malformed one reads as the first
 *  page. */
export interface StudioPlaylistCursor {
  updatedAt: Date;
  id: string;
}

export function encodePlaylistCursor(cursor: StudioPlaylistCursor): string {
  return encodeStudioCursor({ publishedAt: cursor.updatedAt, id: cursor.id });
}

export function decodePlaylistCursor(
  cursor: string | undefined,
): StudioPlaylistCursor | null {
  const decoded = decodeStudioCursor(cursor);
  return decoded ? { updatedAt: decoded.publishedAt, id: decoded.id } : null;
}
