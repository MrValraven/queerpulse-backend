import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { MAX_BATCH_URLS } from '../link-preview.constants';

/**
 * Query for `GET /link-preview/batch?url=A&url=B`. The parameter is repeated
 * rather than comma-joined because a comma is legal inside a URL, so splitting
 * on one would corrupt real links.
 *
 * Express gives a single occurrence as a string and several as an array; the
 * transform normalises both to an array so one URL and four validate the same
 * way. Every entry then faces exactly the checks a single unfurl faces: an
 * http(s) URL with a protocol, length-capped. Nothing here proves a URL is safe
 * to fetch; the SSRF layer in `ssrf.ts` does that, per URL, unchanged.
 */
export class LinkPreviewBatchQuery {
  @Transform(({ value }: { value: unknown }): unknown => {
    if (value === undefined || value === null) {
      return value;
    }
    // `Array.isArray` widens `unknown` to `any[]`; re-narrow so nothing
    // untyped escapes the transform into the validated instance.
    return Array.isArray(value) ? (value as unknown[]) : [value];
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_URLS)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { each: true },
  )
  url!: string[];
}
