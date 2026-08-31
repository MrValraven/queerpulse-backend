import { IsBoolean } from 'class-validator';

/**
 * `PUT /me/content-sensitivity`: the three content-sensitivity filters, in
 * one full REPLACE (PRD-10).
 *
 * All three fields are REQUIRED, following `UpdateWorkPreferencesDto` rather
 * than the single-switch DTOs beside it: the Interests pane holds the whole
 * triple in state and submits it whole, and an omitted field on a "do not show
 * me this" form would silently keep a value the member believes they just
 * changed.
 *
 * Named `hide*` for what each field DOES, matching the columns and
 * `UpdatePushPreviewsDto`'s reasoning: a `show*` spelling reads as its own
 * opposite to whoever wires the toggle next. The pane's checkbox is "show me
 * this content", so exactly one inversion exists, and it lives at the render
 * site next to the label rather than anywhere on the wire.
 */
export class UpdateContentSensitivityDto {
  /** Hide dating and relationship content from the feed. */
  @IsBoolean()
  hideDating!: boolean;

  /** Hide mental-health and wellbeing content from the feed. */
  @IsBoolean()
  hideMentalHealth!: boolean;

  /** Hide sexuality and identity exploration content from the feed. */
  @IsBoolean()
  hideSexualityIdentity!: boolean;
}
