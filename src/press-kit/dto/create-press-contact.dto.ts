import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

export class CreatePressContactDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  role!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsString()
  @MaxLength(200)
  languages!: string;

  @IsEmail()
  email!: string;

  /**
   * Nullable avatar. `@IsOptional` skips validation for both `null` and an
   * omitted value; a present value goes through `@IsImageReference()`, so it is
   * either one of our own storage keys or an `https://` URL on the short list
   * of hosts we already serve images from.
   *
   * This was `@IsUrl()`, which was wrong in both directions. It REFUSED a bare
   * storage key, so an avatar uploaded through `/uploads/avatar` could not be
   * used here at all (the only way to fill the field was to type someone
   * else's URL). And it ACCEPTED any host, on a value rendered by the
   * unauthenticated `/about/press-kit` page: a single row could point every
   * visitor's browser at a chosen third party, which then collects the IP
   * address, user agent and viewing time of everyone who reads our press kit.
   * The decorator's own comment explains at length why that is a safety
   * problem on this platform rather than only an XSS one.
   *
   * Because the column can now hold a key, `PressContact.avatarUrl` is a real
   * `MediaReferenceSource` (see `media-reference-sources.ts`) so the storage
   * garbage collector counts a press-kit avatar as in use, and
   * `toPressContactDTO` resolves it through `toImageUrl` so the browser gets a
   * URL it can load rather than a bare key.
   */
  @IsOptional()
  @IsImageReference()
  avatarUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
