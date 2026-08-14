export const FILES_PREFIX = '/files/';

/** A stored reference may be the raw storage key (`avatars/<id>/x.jpg`) or a
 * `/files/<key>` URL. Normalises either form to the bare key. */
export function toBareKey(value: string): string {
  return value.startsWith(FILES_PREFIX)
    ? value.slice(FILES_PREFIX.length)
    : value;
}
