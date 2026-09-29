import { IsISO8601, IsOptional } from 'class-validator';

// `POST /forum/threads/:slug/read` body (PRD-409). Omitted (or an empty body)
// means "read up to now", which is how the route behaved before the field
// existed. The service clamps a future value to now, and the stored watermark
// only ever moves forward.
export class MarkThreadReadDto {
  /**
   * ISO-8601 timestamp of the newest reply the member actually had on screen,
   * so the watermark records what they saw: a reply that landed while the page
   * was open stays unread until it is rendered.
   */
  @IsOptional()
  @IsISO8601()
  upTo?: string;
}
