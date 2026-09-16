import { IsOptional, IsString, MaxLength } from 'class-validator';

/** `GET /admin/official-messages/recipients?q=` typeahead. */
export class SearchOfficialRecipientsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
