import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { PERSONA_WALL_FILL_ORDERS } from '../persona-wall.constants';

/** Body of `POST /admin/personas/wall/picks`. */
export class AddPersonaWallPickDto {
  /** A persona id. `@Allow()` keeps the property through `whitelist` and
   *  validates nothing, so the service owns the check: a missing, non-string
   *  or non-uuid value answers 400 `PERSONA_WALL_PERSONA_NOT_FOUND` and
   *  carries its reason code. */
  @ApiProperty({
    description: 'Id of the persona to put on the wall.',
    type: String,
  })
  @Allow()
  subprofileId!: unknown;
}

/** Body of `PATCH /admin/personas/wall/picks/reorder`. */
export class ReorderPersonaWallPicksDto {
  /** Every current pick id once, in the new order. The service owns the shape
   *  and completeness checks, so a missing, non-array or wrong set answers
   *  409 `PERSONA_WALL_REORDER_MISMATCH` and carries its reason code. */
  @ApiProperty({
    description: 'Every current pick id once, in the new order.',
    type: [String],
  })
  @Allow()
  ids!: unknown;
}

/** Body of `PATCH /admin/personas/wall/settings`. */
export class UpdatePersonaWallSettingsDto {
  /** The fill order. The service owns the check, so a missing or unknown value
   *  answers 400 `PERSONA_WALL_INVALID_FILL_ORDER` and carries its reason
   *  code. */
  @ApiProperty({
    description: 'One of endorsed, followed, newest or daily_shuffle.',
    enum: [...PERSONA_WALL_FILL_ORDERS],
  })
  @Allow()
  fillOrder!: unknown;
}

/** Query of `GET /admin/personas/wall/search`. */
export class PersonaWallSearchQuery {
  /** The search text. The service owns the length handling: it trims `q`,
   *  answers an empty list for a blank or repeated one and cuts a long one to
   *  100 characters, so no rule can answer a generic 400. */
  @ApiPropertyOptional({
    description: 'Search text for the picker.',
    type: String,
  })
  @Allow()
  q?: unknown;
}
