import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// `PATCH /events/:slug/lineup/:memberSlug` body.
export class ChangeLineupRoleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  role!: string;
}
