import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RSVP_DETAILS_VISIBILITY_OPTIONS,
  RsvpDetailsVisibility,
} from '../entities/event-rsvp.entity';
import {
  MAX_RSVP_CUSTOM_ANSWER_LENGTH,
  MAX_RSVP_PRONOUNS_LENGTH,
} from '../gathering-extras';

/**
 * Body for `PATCH /events/:slug/rsvp/details` — the caller's own RSVP only
 * (host/co-host status grants no access to anyone else's). Every field is
 * optional so the modal can save a partial edit without clobbering the rest.
 */
export class UpdateRsvpDetailsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  guestCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accessNeeds?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  dietaryNeeds?: string;

  @IsOptional()
  @IsIn(RSVP_DETAILS_VISIBILITY_OPTIONS)
  visibility?: RsvpDetailsVisibility;

  // Answers to the gathering's optional questions (`Event.rsvpQuestions`,
  // `Event.customRsvpQuestion`). Trimmed by the service, and a blank answer
  // clears the stored one.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RSVP_PRONOUNS_LENGTH)
  pronouns?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_RSVP_CUSTOM_ANSWER_LENGTH)
  customAnswer?: string;
}
