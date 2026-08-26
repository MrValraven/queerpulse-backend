import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /events/:slug/bans` — host and co-host only.
 *
 * `reason` is the organiser's own note for their own list. It is never sent
 * to the barred member and never enters a notification payload: a host has to
 * be able to write down why without it becoming a message to the person it is
 * about.
 */
export class CreateEventBanDto {
  /** The member to bar, by profile slug. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  memberSlug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
