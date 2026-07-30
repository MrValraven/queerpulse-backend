import { IsEnum, IsOptional } from 'class-validator';
import { ListingEditSuggestionStatus } from '../entities/listing-edit-suggestion.entity';

/** `GET /listings/admin/edit-suggestions?status=` query. Moderator/admin-only
 * (see `ListingsController.listEditSuggestions`). `status` omitted ⇒ every
 * status. Mirrors `ListListingQueueQuery`'s shape. */
export class ListEditSuggestionsQuery {
  @IsOptional()
  @IsEnum(ListingEditSuggestionStatus)
  status?: ListingEditSuggestionStatus;
}
