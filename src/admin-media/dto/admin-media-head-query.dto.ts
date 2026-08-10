import { IsNotEmpty, IsString } from 'class-validator';

// Admin `GET /admin/media/head` query. `key` was previously an unvalidated
// `@Query('key') key: string` — honestly typed only by accident, since
// `AdminMediaService.assertKnownKey` -> `parseStorageKey`'s `typeof value ===
// 'string'` guard happened to catch a missing/non-string value. Declaring it
// here makes the route's real contract explicit and 400s a missing `key`
// instead of routing a `NotFoundException` through `assertKnownKey`.
export class AdminMediaHeadQueryDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
