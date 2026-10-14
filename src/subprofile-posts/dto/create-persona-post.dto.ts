import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeUrl } from '../../common/validators/is-safe-url.decorator';
import { PERSONA_POST } from '../persona-post.constants';

/** A post link is an `https://` address. The empty string still reads as
 *  "no link" (the `@IsOptional` passes null and an absent field). */
export const HTTPS_LINK_PATTERN = /^(?:https:\/\/|$)/i;
export const HTTPS_LINK_MESSAGE = 'linkUrl must be an https:// link';

/** `@Transform` helper: trims a string value. */
export const trimPostText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `POST /subprofiles/:id/posts`. The body is plain text (links in it stay
 * text on the page). `imageKey` comes from the existing persona image
 * presign; the service copies it to a key of this persona.
 */
export class CreatePersonaPostDto {
  @Transform(trimPostText)
  @IsString()
  @MinLength(1)
  @MaxLength(PERSONA_POST.bodyMax)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PERSONA_POST.linkMax)
  @IsSafeUrl()
  @Matches(HTTPS_LINK_PATTERN, { message: HTTPS_LINK_MESSAGE })
  linkUrl?: string | null;

  @IsOptional()
  @IsImageReference()
  imageKey?: string | null;
}
