import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { LEAD_STAGES, LEAD_TYPES } from '../leads.constants';

// Every field below is `@Allow()` and typed `unknown`: the decorator keeps the
// property through `whitelist` and validates nothing, so the service owns each
// check and a bad value always answers its own reason code. A property no
// class declares still gets the global `forbidNonWhitelisted` 400.

/** Query of `GET /admin/leads`. The service answers `LEAD_STAGE_INVALID`,
 *  `LEAD_TYPE_INVALID` and `LEAD_CURSOR_INVALID`, in that order. A blank or
 *  repeated `q` reads as no search and any `due` other than the text `true`
 *  reads as false, so neither can answer a generic 400. */
export class ListLeadsQuery {
  @ApiPropertyOptional({
    description:
      'Search text over name, email and links. Trimmed and cut to 100 characters.',
    type: String,
  })
  @Allow()
  q?: unknown;

  @ApiPropertyOptional({
    description: 'Only leads in this stage. Blank means every stage.',
    enum: [...LEAD_STAGES],
  })
  @Allow()
  stage?: unknown;

  @ApiPropertyOptional({
    description: 'Only leads of this type. Blank means every type.',
    enum: [...LEAD_TYPES],
  })
  @Allow()
  type?: unknown;

  @ApiPropertyOptional({
    description: 'Exactly `true` lists only leads whose follow-up is due.',
    type: String,
  })
  @Allow()
  due?: unknown;

  @ApiPropertyOptional({
    description: 'The `nextCursor` of the previous page.',
    type: String,
  })
  @Allow()
  cursor?: unknown;
}

/** Query of `GET /admin/leads/personas/search`. The service trims `q`,
 *  answers an empty list for a blank or repeated one and cuts a long one to
 *  100 characters, so no rule can answer a generic 400. */
export class LeadPersonaSearchQuery {
  @ApiPropertyOptional({
    description:
      'Search text for the persona picker. A leading @ searches handles by prefix.',
    type: String,
  })
  @Allow()
  q?: unknown;
}

/** Body of `POST /admin/leads`. The service answers, first failure wins:
 *  `LEAD_NAME_REQUIRED`, `LEAD_NAME_TOO_LONG`, `LEAD_TYPE_INVALID`,
 *  `LEAD_STAGE_INVALID`, `LEAD_LOCATION_TOO_LONG`, `LEAD_EMAIL_INVALID`,
 *  `LEAD_PHONE_TOO_LONG`, `LEAD_LINK_INVALID`, `LEAD_LINK_TOO_LONG`,
 *  `LEAD_TOO_MANY_LINKS`, `LEAD_FOLLOW_UP_INVALID`, `LEAD_NOTE_EMPTY`,
 *  `LEAD_NOTE_TOO_LONG`, then `LEAD_EMAIL_TAKEN` and `LEAD_LINK_TAKEN`. */
export class CreateLeadDto {
  @ApiPropertyOptional({
    description: 'Required. At most 120 characters after trimming.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({ description: 'Required.', enum: [...LEAD_TYPES] })
  @Allow()
  type?: unknown;

  @ApiPropertyOptional({
    description: 'Defaults to to_contact.',
    enum: [...LEAD_STAGES],
  })
  @Allow()
  stage?: unknown;

  @ApiPropertyOptional({
    description: 'At most 120 characters.',
    type: String,
    nullable: true,
  })
  @Allow()
  location?: unknown;

  @ApiPropertyOptional({
    description: 'Stored trimmed and lowercased; unique across leads.',
    type: String,
    nullable: true,
  })
  @Allow()
  email?: unknown;

  @ApiPropertyOptional({
    description: 'At most 40 characters.',
    type: String,
    nullable: true,
  })
  @Allow()
  phone?: unknown;

  @ApiPropertyOptional({
    description:
      'Full http or https links, at most 12, each at most 500 characters.',
    type: [String],
  })
  @Allow()
  links?: unknown;

  @ApiPropertyOptional({
    description: 'A YYYY-MM-DD day from 2000-01-01 to 2100-12-31.',
    type: String,
    format: 'date',
    nullable: true,
  })
  @Allow()
  followUpOn?: unknown;

  @ApiPropertyOptional({
    description: 'The first note. Blank or null writes none.',
    type: String,
    nullable: true,
  })
  @Allow()
  note?: unknown;
}

/** Body of `PATCH /admin/leads/:id`. An absent property is left as it is.
 *  The service answers the create codes in the create order, then 400
 *  `LEAD_PERSONA_NOT_FOUND` for a malformed persona id, then `LEAD_NOT_FOUND`,
 *  `LEAD_EMAIL_TAKEN`, `LEAD_LINK_TAKEN`, 404 `LEAD_PERSONA_NOT_FOUND`,
 *  `LEAD_PERSONA_TAKEN` and `LEAD_PERSONA_NOT_LISTED`. */
export class UpdateLeadDto {
  @ApiPropertyOptional({
    description: 'At most 120 characters after trimming. Null is refused.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description: 'Null is refused.',
    enum: [...LEAD_TYPES],
  })
  @Allow()
  type?: unknown;

  @ApiPropertyOptional({
    description: 'Null is refused.',
    enum: [...LEAD_STAGES],
  })
  @Allow()
  stage?: unknown;

  @ApiPropertyOptional({
    description: 'Null or blank clears it.',
    type: String,
    nullable: true,
  })
  @Allow()
  location?: unknown;

  @ApiPropertyOptional({
    description: 'Null or blank clears it.',
    type: String,
    nullable: true,
  })
  @Allow()
  email?: unknown;

  @ApiPropertyOptional({
    description: 'Null or blank clears it.',
    type: String,
    nullable: true,
  })
  @Allow()
  phone?: unknown;

  @ApiPropertyOptional({
    description: 'Replaces the whole list.',
    type: [String],
  })
  @Allow()
  links?: unknown;

  @ApiPropertyOptional({
    description:
      'A YYYY-MM-DD day from 2000-01-01 to 2100-12-31. Null clears it.',
    type: String,
    format: 'date',
    nullable: true,
  })
  @Allow()
  followUpOn?: unknown;

  @ApiPropertyOptional({
    description: 'Id of a publicly listed persona to link. Null unlinks.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Allow()
  linkedSubprofileId?: unknown;
}

/** Body of `POST /admin/leads/:id/entries` and
 *  `PATCH /admin/leads/:id/entries/:entryId`. The service answers
 *  `LEAD_NOTE_EMPTY` for a missing, non-string or blank body and
 *  `LEAD_NOTE_TOO_LONG` past 4000 characters. */
export class LeadNoteDto {
  @ApiProperty({
    description: 'The note text. Trimmed at both ends; inner line breaks stay.',
    type: String,
  })
  @Allow()
  body?: unknown;
}
