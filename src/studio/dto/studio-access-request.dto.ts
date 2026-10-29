import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** `POST /studio/access-requests`: whether the member wants to release music. */
export class CreateStudioAccessRequestDto {
  @IsBoolean()
  wantsToRelease!: boolean;
}

/** `GET /admin/studio/access-requests`: an opaque keyset cursor; a malformed value reads as the first page. */
export class AdminStudioAccessRequestsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
