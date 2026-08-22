import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// Both keys are base64url, optionally padded. Anchoring the alphabet (and the
// lengths below) is what keeps these fields the fixed-size crypto material they
// actually are: they were `@IsString() @IsNotEmpty()` into `text` columns, so a
// member could store megabytes per subscription row and that row is loaded on
// every push fan-out.
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

class PushKeysDto {
  // The client's P-256 public key: 65 raw bytes, i.e. 87 base64url characters
  // (88 padded). 128 leaves generous headroom without leaving it unbounded.
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(BASE64URL, {
    message: 'p256dh must be base64url-encoded',
  })
  p256dh!: string;

  // The auth secret: 16 raw bytes, i.e. 22 base64url characters (24 padded).
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(BASE64URL, {
    message: 'auth must be base64url-encoded',
  })
  auth!: string;
}

export class PushSubscribeDto {
  // The endpoint is a URL this backend later POSTs to (web-push delivery), so it
  // must be an absolute https:// URL to a real host — not a bare string that
  // could smuggle a non-http scheme or an internal target past validation. The
  // per-request SSRF guard in PushService is the second, resolution-time layer.
  @IsUrl({ require_protocol: true, protocols: ['https'], require_tld: true })
  @MaxLength(1024)
  @IsNotEmpty()
  endpoint!: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}
