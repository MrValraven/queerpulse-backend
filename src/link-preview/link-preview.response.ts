/**
 * Frontend-contract shape for a link unfurl. Mirrors the FE
 * `LinkPreviewResponse` in `shared/contracts/contracts.ts` field-for-field.
 * Every field is nullable: an unfurl that yields no usable metadata (or a URL
 * we decline to fetch) returns an all-null card and the client renders nothing
 * — never a broken card. There is no global serializer here, so this is
 * hand-built from the parsed meta; only these five fields ever leave the server.
 */
export interface LinkPreviewResponse {
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  /** SEC-23: always an address on this API (`GET /link-preview-images/<token>`)
   *  or null. The linked page's own `og:image` URL never leaves the server. */
  imageUrl: string | null;
}

/** An all-null card for `url` — returned when a fetch is declined or yields nothing. */
export function emptyPreview(url: string): LinkPreviewResponse {
  return {
    url,
    siteName: null,
    title: null,
    description: null,
    imageUrl: null,
  };
}
