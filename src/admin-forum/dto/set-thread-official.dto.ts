import { IsBoolean } from 'class-validator';

// `PATCH /admin/forum/threads/:slug/official` body.
export class SetThreadOfficialDto {
  @IsBoolean()
  isOfficial!: boolean;
}
