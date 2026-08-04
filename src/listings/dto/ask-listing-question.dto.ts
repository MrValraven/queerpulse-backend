import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /listings/:ref/question body (moderator/admin only). The question is
 * delivered to the listing's submitter as a DM via MessagingService, then the
 * listing is moved to `question` status. Length bounds mirror the housing
 * enquiry body (`create-housing-enquiry.dto.ts`), with a looser 1-char floor:
 * a moderator's clarifying question can legitimately be a single short line.
 */
export class AskListingQuestionDto {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}
