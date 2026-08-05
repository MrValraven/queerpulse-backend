import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { SaveListingDraftDto } from './dto/save-listing-draft.dto';
import { ListingDraftsService } from './listing-drafts.service';

/**
 * Cross-device "list a business" wizard drafts (wizard overhaul item #11).
 * Every route is auth-gated by `ActiveMemberGuard` and scoped to the
 * signed-in member: a draft that is not the caller's own 404s. Tagged with the
 * `listings` feature so it 404s in lockstep if the listings feature is off.
 *
 * `resume/:token` is declared before the `:id` routes so Nest resolves the
 * literal `resume` segment as a route rather than treating `resume` as an `:id`
 * (mirrors the "static path before dynamic param" ordering in
 * `ListingsController`).
 */
@Feature('listings')
@ApiTags('Listing drafts')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('listing-drafts')
@UseGuards(ActiveMemberGuard)
export class ListingDraftsController {
  constructor(private readonly listingDraftsService: ListingDraftsService) {}

  @Get()
  @ApiOperation({
    summary: 'List your in-progress listing drafts (newest edited first).',
  })
  @ApiOkResponse({ description: 'The caller’s listing drafts.' })
  list(@CurrentUser() user: CurrentUserData) {
    return this.listingDraftsService.list(user.userId);
  }

  @Post()
  @ApiOperation({
    summary: 'Autosave a listing draft (creates when no id, else updates).',
  })
  @ApiCreatedResponse({ description: 'The id of the saved draft.' })
  save(@CurrentUser() user: CurrentUserData, @Body() dto: SaveListingDraftDto) {
    return this.listingDraftsService.save(user.userId, dto);
  }

  @Get('resume/:token')
  @ApiOperation({
    summary: 'Resolve a resume token to its draft (owner only).',
  })
  @ApiOkResponse({ description: 'The draft the token resumes.' })
  @ApiNotFoundResponse({
    description: 'No draft for that token belonging to the caller.',
  })
  resolveByToken(
    @CurrentUser() user: CurrentUserData,
    @Param('token') token: string,
  ) {
    return this.listingDraftsService.resolveByToken(user.userId, token);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of your listing drafts by id.' })
  @ApiOkResponse({ description: 'The draft owned by the caller.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listingDraftsService.getById(user.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one of your listing drafts.' })
  @ApiNoContentResponse({ description: 'The draft was deleted.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listingDraftsService.remove(user.userId, id);
  }

  @Post(':id/resume-link')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Email yourself a cross-device resume link for a draft. ' +
      'Sent via the transactional mailer; when SMTP is unconfigured (dev/test) ' +
      'the mailer logs the message instead of delivering it.',
  })
  @ApiNoContentResponse({ description: 'The resume link was dispatched.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  sendResumeLink(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listingDraftsService.sendResumeLink(
      user.userId,
      user.email,
      id,
    );
  }
}
