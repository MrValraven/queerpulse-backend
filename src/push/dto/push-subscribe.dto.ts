import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';

class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh: string;

  @IsString()
  @IsNotEmpty()
  auth: string;
}

export class PushSubscribeDto {
  // The endpoint is a URL this backend later POSTs to (web-push delivery), so it
  // must be an absolute https:// URL to a real host — not a bare string that
  // could smuggle a non-http scheme or an internal target past validation. The
  // per-request SSRF guard in PushService is the second, resolution-time layer.
  @IsUrl({ require_protocol: true, protocols: ['https'], require_tld: true })
  @MaxLength(1024)
  @IsNotEmpty()
  endpoint: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}
