import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateEventCommunityInviteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  communitySlug!: string;
}
