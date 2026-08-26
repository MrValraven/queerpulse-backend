import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreateArticleTranslationDto } from './dto/create-article-translation.dto';
import { SetArticleLifecycleDto } from './dto/set-article-lifecycle.dto';
import { MagazineLifecycleService } from './magazine-lifecycle.service';

/**
 * CON-16 — the lifecycle desk's own guarded surface.
 *
 * Its own `Admin*Controller` rather than more routes on
 * `AdminMagazinePiecesController`, per the repo's admin-CRUD convention and
 * because the two answer different questions: that controller runs pieces
 * through to publication, this one manages the archive afterwards.
 *
 * Same guard chain as every other magazine admin surface: `ActiveMemberGuard`
 * first (a suspended editor is locked out), then the `magazine_editor` staff
 * role (admins are a superset). Route prefix is `magazine/admin/lifecycle`
 * plus two piece-addressed writes under `magazine/admin/pieces`.
 */
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineLifecycleController {
  constructor(private readonly lifecycle: MagazineLifecycleService) {}

  @Get('lifecycle')
  @ApiOperation({
    summary:
      'The lifecycle desk: pieces due for re-review, pieces already flagged, and the standing tally.',
  })
  @ApiOkResponse({
    description:
      '`dueForReview` is the work queue (oldest promise first, `reviewDueInDays` negative when overdue); ' +
      '`flagged` is everything a reader currently sees a banner on; `counts` tallies the archive.',
  })
  getDesk(
    @Query('withinDays', new DefaultValuePipe(30), ParseIntPipe)
    withinDays: number,
  ) {
    return this.lifecycle.getDesk(withinDays);
  }

  @Patch('pieces/:id/article/lifecycle')
  @ApiOperation({
    summary:
      'Set where a published piece stands: live, under review, archived or superseded.',
  })
  @ApiOkResponse({ description: 'The updated lifecycle record.' })
  @ApiBadRequestResponse({
    description:
      'Malformed id or payload, the piece has no article yet, a piece was asked to supersede itself, ' +
      'or `superseded` was requested without the piece that replaces it.',
  })
  @ApiNotFoundResponse({
    description: 'No piece with that id, or no article with the given slug.',
  })
  setLifecycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetArticleLifecycleDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.lifecycle.setLifecycle(id, dto, user.userId);
  }

  @Get('pieces/:id/article/translations')
  @ApiOperation({
    summary:
      'Every language this piece exists in, published or still drafting.',
  })
  @ApiOkResponse({
    description:
      'The whole translation family including the original, ordered by locale. ' +
      'Empty when the piece has no article yet.',
  })
  @ApiNotFoundResponse({ description: 'No piece with that id.' })
  listTranslations(@Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.listTranslations(id);
  }

  @Post('pieces/:id/article/translations')
  @ApiOperation({
    summary:
      'Open a translation of this piece as its own desk record, seeded with the original’s blocks.',
  })
  @ApiCreatedResponse({
    description:
      'The new translation: its article id, its own piece id (open it in the article editor), and its slug.',
  })
  @ApiBadRequestResponse({
    description:
      'Malformed id or payload, the piece has no article yet, the piece is itself a translation, ' +
      'or it is already written in the requested language.',
  })
  @ApiConflictResponse({
    description: 'This piece already has a translation in that language.',
  })
  @ApiNotFoundResponse({ description: 'No piece with that id.' })
  createTranslation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArticleTranslationDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.lifecycle.createTranslation(id, dto, user.userId);
  }
}
