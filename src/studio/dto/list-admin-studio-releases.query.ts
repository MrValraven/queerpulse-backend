import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** The statuses the staff release list serves; the Withdrawn tab's today. */
export const ADMIN_STUDIO_RELEASE_LIST_STATUSES = ['taken_down'] as const;

/** `GET /admin/studio/releases?status=taken_down` (Studio open demo pages). */
export class ListAdminStudioReleasesQuery {
  @IsIn(ADMIN_STUDIO_RELEASE_LIST_STATUSES)
  status!: (typeof ADMIN_STUDIO_RELEASE_LIST_STATUSES)[number];

  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
