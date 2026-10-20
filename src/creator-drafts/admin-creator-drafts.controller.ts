import {
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCreatorDraftsService } from './admin-creator-drafts.service';
import {
  CREATOR_DRAFT_KINDS,
  CREATOR_DRAFT_KIND_VALUES,
  CreatorDraftKind,
} from './creator-drafts.constants';
import { ListAdminCreatorDraftsQuery } from './dto/list-admin-creator-drafts.query';

/**
 * Every open creator draft (personas, Studio releases and episodes, list a
 * business, events, listing edits, Start a Community) for the admin console.
 * Admin only, with no `@StaffRoles` union and no class `@Feature`: a kind
 * whose feature is off lists no rows and its detail answers 404.
 *
 * Read-only, view and message: staff read a draft and reach its author
 * through the official thread, and no route here edits, publishes or deletes
 * a member's draft. Every detail read writes one `creator_draft_viewed` row to
 * the Platform log.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin: Creator drafts')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/creator-drafts')
export class AdminCreatorDraftsController {
  constructor(private readonly adminCreatorDrafts: AdminCreatorDraftsService) {}

  @Get()
  @ApiOperation({
    summary: "List members' open creator drafts (newest saved first)",
  })
  @ApiOkResponse({
    description:
      'A `{ items, total, page, pageSize }` page of draft rows: kind, title, ' +
      'made for, owner, last saved, progress and missing steps. Writes no ' +
      'audit row.',
  })
  @ApiBadRequestResponse({
    description: 'An unknown `kind`, or a `page` outside 1 to 10000.',
  })
  list(@Query() query: ListAdminCreatorDraftsQuery) {
    return this.adminCreatorDrafts.list(query);
  }

  @Get(':kind/:id')
  @ApiOperation({
    summary: "One member's open creator draft with its allow-listed preview",
  })
  @ApiParam({ name: 'kind', enum: CREATOR_DRAFT_KINDS })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    description:
      'The draft row plus `preview`, built from allow-listed public fields ' +
      'only. Writes one `creator_draft_viewed` row to the Platform log; when ' +
      'that write fails the request answers 500 and shows nothing.',
  })
  @ApiBadRequestResponse({
    description: 'An unknown `kind` or a malformed `id`.',
  })
  @ApiNotFoundResponse({
    description:
      '`creator_draft_not_found`: no such draft, out of scope (a personal ' +
      'event draft, a private or removed persona, a deactivated author), ' +
      'expired, saved before its kind’s notice date, or its feature is off.',
  })
  getOne(
    @CurrentUser() user: CurrentUserData,
    @Param('kind', new ParseEnumPipe(CREATOR_DRAFT_KIND_VALUES))
    kind: CreatorDraftKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminCreatorDrafts.getOne(user.userId, kind, id);
  }
}
