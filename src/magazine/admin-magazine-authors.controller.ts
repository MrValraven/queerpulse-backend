import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
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
import { UpdateAuthorDto } from './dto/update-author.dto';
import { MagazineService } from './magazine.service';

/**
 * Staff editing of magazine bylines (CON-11). Until this existed there was NO
 * endpoint anywhere to edit an author: a byline row was auto-created on
 * publish by slugifying the free-text byline, with `bio: null` and
 * `avatarUrl: null`, and nobody could fix it without a database console.
 *
 * ActiveMemberGuard runs first (a suspended editor is locked out), then
 * StaffRolesGuard requires `magazine_editor` (admins are a superset), matching
 * `AdminMagazineDecksController`. Route prefix is `magazine/admin/authors`,
 * distinct from the public `magazine/authors` reads on `MagazineController`.
 */
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin/authors')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineAuthorsController {
  constructor(private readonly magazine: MagazineService) {}

  @Get()
  @ApiOperation({ summary: 'List every magazine byline.' })
  @ApiOkResponse({
    description:
      'All bylines by name, each with its member link and published piece count.',
  })
  listAll() {
    return this.magazine.listAuthors();
  }

  @Patch(':slug')
  @ApiOperation({
    summary: 'Edit a byline: name, bio, portrait, and its member link.',
  })
  @ApiOkResponse({ description: 'The updated byline.' })
  @ApiNotFoundResponse({
    description:
      'No byline with that slug, or no member with that profile slug.',
  })
  @ApiConflictResponse({
    description: 'That member is already linked to another byline.',
  })
  update(
    @Param('slug') slug: string,
    @Body() dto: UpdateAuthorDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazine.updateAuthorBySlug(slug, dto, user.userId);
  }
}
