import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /directory/:slug/enquiries` — a member writing PRIVATELY to
 * the business behind a listing, through the platform's own messaging.
 *
 * Not the same thing as `AskListingPublicQuestionDto`, which posts on the
 * listing's public page for every future reader. The distinction is the whole
 * point of this endpoint: "is your upstairs room step-free" is worth publishing,
 * and "I am trans and I want to know whether your staff will be weird with me
 * before I turn up" is not something anybody should have to ask in public.
 *
 * Shares that DTO's 8-character floor for the same reason (a one-character
 * enquiry is noise a business has to open and read), with a longer ceiling: a
 * private message can reasonably carry more context than a public one-liner,
 * and 2000 sits well inside messaging's own 5000-character `body` limit.
 */
export class CreateListingEnquiryDto {
  @IsString() @MinLength(8) @MaxLength(2000) body!: string;
}
