import { Logger } from '@nestjs/common';
import { toImageUrl } from '../common/image-url';
import type { Sticker, StickerKeywords } from './entities/sticker.entity';
import type { StickerPack } from './entities/sticker-pack.entity';

// `toStickerResponse`/`toStickerPackResponse` are plain exported functions,
// not Nest providers, so they cannot receive an injected logger. Matches
// `image-url.ts`'s own module-level singleton for the same reason.
const logger = new Logger('StickerResponse');

/** One sticker as the picker needs it. `url` is already resolved, so the
 *  frontend never sees a storage key (a key is not fetchable). */
export interface StickerResponse {
  id: string;
  slug: string;
  label: string;
  url: string;
  width: number;
  height: number;
  keywords: StickerKeywords;
}

export interface StickerPackResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverStickerId: string | null;
  stickers: StickerResponse[];
}

/**
 * Returns null when `sticker.storageKey` does not resolve to a URL, so the
 * caller can drop that one sticker rather than fail the whole catalogue.
 *
 * `toImageUrl`'s own header comment says these image columns "have never
 * validated their input", so a malformed key is ordinary bad data here,
 * exactly like every other image field this codebase reads.
 * `toImageUrl` already separates the two failure modes for us: an
 * unconfigured api base url (a real wiring bug, affecting every image in the
 * app) throws from inside `toImageUrl` itself before this function ever sees
 * a return value; a value that is neither a known storage key nor an
 * `https://` URL (bad data, scoped to this one row) is the only case that
 * reaches the `null` check below. So skipping on `null` here can never mask
 * the wiring-bug case, that one still fails loudly on its own.
 *
 * Skipping rather than throwing follows `toPostPhotoViews` in
 * `src/forum/forum-response.ts`, which resolves each photo's storage key and
 * pushes it only when the url resolves, leaving an unresolvable one out of
 * the array entirely. One bad sticker row costs exactly one missing sticker,
 * and every other member keeps loading the rest of the catalogue on every
 * composer open.
 */
export function toStickerResponse(sticker: Sticker): StickerResponse | null {
  const url = toImageUrl(sticker.storageKey);
  if (!url) {
    logger.warn(
      `Sticker ${sticker.id} (pack ${sticker.packId}) has a storage key that does not resolve to a URL; skipping it from the catalogue.`,
    );
    return null;
  }
  return {
    id: sticker.id,
    slug: sticker.slug,
    label: sticker.label,
    url,
    width: sticker.width,
    height: sticker.height,
    keywords: sticker.keywords ?? { en: [], pt: [] },
  };
}

/** Hand-mapped rather than returned raw, this codebase's standing rule: the
 *  entity carries `svgSource`, `templateParams` and `storageKey`, none of
 *  which a member has any use for and the first two of which are large. */
export function toStickerPackResponse(pack: StickerPack): StickerPackResponse {
  const stickers = [...(pack.stickers ?? [])]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(toStickerResponse)
    .filter((sticker): sticker is StickerResponse => sticker !== null);
  return {
    id: pack.id,
    slug: pack.slug,
    name: pack.name,
    description: pack.description,
    // An unresolvable cover reads as "no cover" and the picker falls back to
    // the first sticker, so a deleted cover never blanks a pack's tile.
    coverStickerId:
      pack.coverStickerId &&
      stickers.some((sticker) => sticker.id === pack.coverStickerId)
        ? pack.coverStickerId
        : null,
    stickers,
  };
}
