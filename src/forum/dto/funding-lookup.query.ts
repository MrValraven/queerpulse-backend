import { IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_FUNDING_LINK_URL_LENGTH } from '../forum-funding';

// `GET /forum/funding/lookup?link=` query. The link is parsed and normalised
// by the service (`normalizeFundingLink`); an unparsable one answers 204.
export class FundingLookupQuery {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_FUNDING_LINK_URL_LENGTH)
  link!: string;
}
