import { IsOptional, IsString } from 'class-validator';

/**
 * Body of `POST /magazine/admin/pieces/:id/versions` (Magazine Desk Phase 7,
 * Task E1 VersionsRail "save version now" action). `label` is optional — the
 * service defaults it to `"Manual save"` (see
 * `MagazinePieceService.createArticleVersion`). Restoring a version
 * (`POST /magazine/admin/pieces/:id/versions/:versionId/restore`) takes no
 * body — the version id is already in the path.
 */
export class CreateArticleVersionDto {
  @IsOptional() @IsString() label?: string;
}
