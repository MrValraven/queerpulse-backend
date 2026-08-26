import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { MagazineFrontService } from './magazine-front.service';

/**
 * The editor-arranged magazine front (CON-13), on its own controller beside
 * `MagazineController` for the same reason `MagazineIssueContentsController`
 * is: these two reads source from the desk's ISSUE-PRODUCTION jsonb, and that
 * dependency stays out of the plain article/issue reads.
 *
 * Same prefix and same member gate as the rest of the public magazine
 * surface. Both paths are single fixed segments, so neither collides with
 * `MagazineController`'s `issues/:number` / `articles/:slug` — and
 * `current-issue` is deliberately NOT `issues/current`, which would be
 * swallowed by `issues/:number` (registered first).
 */
@Feature('magazine')
@ApiTags('Magazine')
@ApiCookieAuth()
@Controller('magazine')
@UseGuards(ActiveMemberGuard)
export class MagazineFrontController {
  constructor(private readonly front: MagazineFrontService) {}

  @Get('front')
  @ApiOperation({
    summary: "The magazine front, in the desk's own running order",
  })
  @ApiOkResponse({
    description:
      "The current issue, the lead story, and the rest of the issue's run " +
      'order grouped into section rails. Slots whose piece has not published ' +
      'are omitted; everything is null/empty before an issue ships.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getFront() {
    return this.front.getFront();
  }

  @Get('current-issue')
  @ApiOperation({ summary: 'The issue the masthead names' })
  @ApiOkResponse({
    description:
      'The most recently published issue, or null before any has shipped.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getCurrentIssue() {
    return this.front.getCurrentIssue();
  }
}
