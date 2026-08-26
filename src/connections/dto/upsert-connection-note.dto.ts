import { IsString, MaxLength } from 'class-validator';

/**
 * `PUT /connections/:id/note` body.
 *
 * An empty (or whitespace-only, or markup-only) body is the CLEAR action
 * rather than a validation error, so the editor needs no second endpoint to
 * delete a note it has just emptied.
 */
export class UpsertConnectionNoteDto {
  @IsString()
  @MaxLength(500)
  body!: string;
}
