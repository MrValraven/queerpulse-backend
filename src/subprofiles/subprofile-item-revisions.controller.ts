import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RestoreItemRevisionDTO } from './dto/restore-item-revision.dto';
import { SubprofilesService } from './subprofiles.service';

// Protect Your Work (revision history), Task 8: list/view/restore an item's
// saved revisions. Same base path ('subprofiles') and the same class-level
// `ActiveMemberGuard` + `CurrentUser` mechanism as `SubprofilesController`.
// A separate controller class only to keep the (already large)
// `SubprofilesController` from growing further; Nest merges both controllers'
// routes at the shared 'subprofiles' base path with no collision, since every
// route here sits under the literal ':subprofileId/items/...' segment, which
// none of `SubprofilesController`'s own ':id/...' routes use.
@ApiTags('Subprofiles')
@ApiCookieAuth()
@UseGuards(ActiveMemberGuard)
@Controller('subprofiles')
export class SubprofileItemRevisionsController {
  constructor(private readonly subprofilesService: SubprofilesService) {}

  @Get(':subprofileId/items/:itemId/revisions')
  @ApiOperation({ summary: "List a portfolio item's saved revisions" })
  @ApiOkResponse({ description: 'The item’s revisions, newest first.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({ description: 'No subprofile with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listRevisions(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.subprofilesService.listRevisions(
      user.userId,
      subprofileId,
      itemId,
    );
  }

  @Get(':subprofileId/items/:itemId/revisions/:revisionId')
  @ApiOperation({ summary: 'Get one saved revision of a portfolio item' })
  @ApiOkResponse({ description: 'The revision’s full snapshot.' })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({
    description:
      'No subprofile with that id, or no such revision for that item.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getRevision(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
  ) {
    return this.subprofilesService.getRevision(
      user.userId,
      subprofileId,
      itemId,
      revisionId,
    );
  }

  @Post(':subprofileId/items/:itemId/revisions/:revisionId/restore')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Restore a saved revision onto a portfolio item (non-destructive)',
  })
  @ApiCreatedResponse({
    description:
      '`{ ok: true, editVersion }` once restored. `editVersion` is the persona edit version the restore raised to.',
  })
  @ApiConflictResponse({
    description:
      '`{ code: "PERSONA_EDIT_CONFLICT", currentEditVersion }`: `expectedEditVersion` differs from the stored edit version, so nothing was restored.',
  })
  @ApiForbiddenResponse({ description: 'The subprofile is not yours.' })
  @ApiNotFoundResponse({
    description:
      'No subprofile with that id, no such item, or no such revision.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  async restoreRevision(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    // Optional: an empty or absent body restores with no precondition.
    @Body() dto?: RestoreItemRevisionDTO,
  ): Promise<{ ok: true; editVersion: number }> {
    const editVersion = await this.subprofilesService.restoreRevision(
      user.userId,
      subprofileId,
      itemId,
      revisionId,
      dto?.expectedEditVersion,
    );
    return { ok: true, editVersion };
  }
}
