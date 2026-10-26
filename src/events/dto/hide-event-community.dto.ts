import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /me/hidden-event-communities`. Keyed by slug because every surface
 * that offers "Hide events" (the event card menu, the Browse refine search)
 * already holds the community's slug.
 */
export class HideEventCommunityDto {
  @ApiProperty({
    description: 'Slug of the community whose events to hide.',
    example: 'queer-runners',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  communitySlug!: string;
}
