import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * `PUT /admin/mod-response-templates/order` body: the template ids in their
 * new display order. Each id's `sortOrder` becomes its index in this array.
 *
 * Sending the whole order (rather than one row's new position) keeps the list
 * consistent when two admins reorder at once: the last write wins as a
 * complete, coherent order instead of leaving a half-applied shuffle.
 */
export class ReorderModResponseTemplatesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids!: string[];
}
