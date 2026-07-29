import { IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Query for `GET /link-preview`. The URL is validated up-front by the global
 * `ValidationPipe`: it must be a syntactically valid http(s) URL (no other
 * scheme reaches the service) and is length-capped so a pathological query
 * string can't be used as an amplification vector. SSRF hardening (private-IP
 * blocking, redirect capping) happens in the service — validation only proves
 * the string is a well-formed http(s) URL, not that it's safe to fetch.
 */
export class LinkPreviewQuery {
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url!: string;
}
