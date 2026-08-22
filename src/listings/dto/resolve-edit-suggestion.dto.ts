import { IsIn } from 'class-validator';

/**
 * Body of `PATCH /admin/listings/edit-suggestions/:id` — the moderator/admin
 * accept-or-dismiss decision on a member's proposed listing correction.
 */
export class ResolveEditSuggestionDto {
  @IsIn(['accepted', 'dismissed'])
  status!: 'accepted' | 'dismissed';
}
