import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateResourceListingDto } from './create-resource-listing.dto';

/**
 * Body for `POST /admin/resource-suggestions/:id/approve` (PRD-269).
 *
 * Approving now publishes the organisation to the public Legal Aid / Sexual
 * Health Testing directory, so the request carries the listing that will be
 * published rather than a bare note. `listing` is REQUIRED, and that is the
 * whole point of this DTO: the suggestion does not capture everything a
 * listing needs, and the missing pieces are exactly the ones no code may
 * invent.
 *
 *  - `region` has no counterpart on `resource_suggestion` at all.
 *  - Contact details are all optional on a suggestion and at least one is
 *    mandatory on a listing (`HasAtLeastOneContactField`), so a suggestion
 *    naming an organisation and no way to reach it cannot become a listing
 *    until a human finds one.
 *  - `description` is unbounded on a suggestion and capped at 2000 on a
 *    listing, so a long submission has to be cut by somebody who read it.
 *
 * Above all, these are legal-aid and clinic contact details. A member typed
 * them from memory and nobody has checked them. The admin console pre-fills
 * this block from the suggestion and asks the reviewer to confirm or correct
 * every field before approving, which is the verification step the old
 * hand-retyped second entry was supposed to provide and frequently skipped.
 *
 * `note` is unchanged and still THE MEMBER'S to read: it rides on the
 * decision notification and on `GET /resources/suggestions/mine`. See
 * `DecideResourceSuggestionDto`, which decline and archive still use.
 */
export class ApproveResourceSuggestionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  // `@IsObject()` beside `@ValidateNested()` rather than the bare pair
  // `ConsentDto.categories` uses: an approve arriving with no `listing` at all
  // is the case that has to fail LOUDLY and with a message a curator can act
  // on, and this states that requirement in the DTO instead of relying on how
  // nested validation happens to treat `undefined`.
  @IsObject()
  @ValidateNested()
  @Type(() => CreateResourceListingDto)
  listing!: CreateResourceListingDto;
}
