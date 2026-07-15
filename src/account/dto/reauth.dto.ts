import { IsOptional, IsString } from 'class-validator';

// OAuth-only: there is no password to verify server-side. This DTO tolerates
// (and ignores) a `password` field so the current frontend build — which
// still sends one pending its post-Tier-1 trim (spec §5) — isn't rejected by
// the global `forbidNonWhitelisted` ValidationPipe.
export class ReauthDto {
  @IsOptional()
  @IsString()
  password?: string;
}
