import { IsString, MaxLength, MinLength } from 'class-validator';

/** Longest one announcement may be. Sized for the whole of what a host
 *  actually needs to say at the door ("we moved to the back room, the code is
 *  4471, come up the stairs on the left"), and short enough that it stays a
 *  message rather than a second description. */
export const MAX_EVENT_ANNOUNCEMENT_LENGTH = 1000;

/**
 * Body for `POST /events/:slug/announcements` — host and co-host only.
 *
 * Plain text. It is stored as typed, carried into the notification payload as
 * typed, and rendered as text by every reader, so there is no HTML to strip
 * at a render site later.
 */
export class CreateEventAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EVENT_ANNOUNCEMENT_LENGTH)
  body!: string;
}
