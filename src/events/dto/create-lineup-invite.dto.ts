import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// `POST /events/:slug/lineup` body: invite one member onto the lineup.
export class CreateLineupInviteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  memberSlug!: string;

  // Free-ish craft label, see `EventLineupEntry.role`.
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  role!: string;
}
