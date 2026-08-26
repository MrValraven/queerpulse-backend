import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { MagazineIssueContentsService } from './magazine-issue-contents.service';

/**
 * The reader-facing "In this issue" panel (CON-05), on its own controller
 * beside `MagazineController` rather than inside it: this is the one public
 * read that sources from the desk's ISSUE-PRODUCTION jsonb, and keeping it
 * separate keeps that dependency out of the article/issue reads.
 *
 * Same prefix, same member gate as the rest of the public magazine surface —
 * Nest allows two controllers on one path prefix, and `issues/:number/contents`
 * has one more segment than `MagazineController`'s `issues/:number`, so the two
 * never collide.
 */
@Feature('magazine')
@ApiTags('Magazine')
@ApiCookieAuth()
@Controller('magazine')
@UseGuards(ActiveMemberGuard)
export class MagazineIssueContentsController {
  constructor(private readonly contents: MagazineIssueContentsService) {}

  @Get('issues/:number/contents')
  @ApiOperation({
    summary: "The issue's curated contents, in the desk's own order",
  })
  @ApiOkResponse({
    description:
      "The issue's curated entries (title, desk blurb, and the article or " +
      'deck each opens). Entries whose piece has not published are omitted.',
  })
  @ApiNotFoundResponse({ description: 'No issue with that number.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getIssueContents(@Param('number') number: string) {
    return this.contents.getContents(number);
  }
}
