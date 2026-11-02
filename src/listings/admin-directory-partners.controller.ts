import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminDirectoryPartnerDTO,
  AdminDirectoryPartnerSearchResultDTO,
} from './directory-partners-response';
import { DirectoryPartnersService } from './directory-partners.service';
import {
  CreateDirectoryPartnerDto,
  DirectoryPartnerSearchQuery,
  ReorderDirectoryPartnersDto,
  UpdateDirectoryPartnerNoteDto,
} from './dto/directory-partners.dto';

/**
 * The admin routes that hand-pick the businesses shown in a row at the top of
 * the public business directory.
 *
 * Admin only, because a partnership is a business decision. The class carries
 * `@Roles(UserRole.Admin)` and an EMPTY `@StaffRoles()`: the empty list
 * switches the grant axis off, so a Moderator and a holder of the
 * `directory_moderator` grant are both refused. See the `RolesOrStaffGuard`
 * doc for why the empty list is needed, and `AdminListingsController` for the
 * wider moderator gate this class sits beside.
 *
 * Route table (contract section 3). Every route answers the full partner list
 * after a write, and every refusal carries a `reason` code:
 *
 *   GET    admin/listings/partners          list the picks, in order
 *   GET    admin/listings/partners/search   picker search, at most 20 rows
 *   POST   admin/listings/partners          add a listing as a partner
 *   PATCH  admin/listings/partners/order    set the order of every pick
 *   PATCH  admin/listings/partners/:id      set or clear a pick's note
 *   DELETE admin/listings/partners/:id      remove a pick
 *
 * The literal `search` and `order` routes are declared before the `:id`
 * routes so Nest matches the literal. The class itself is registered ahead of
 * `AdminListingsController` in `ListingsModule`, whose `:ref` routes share the
 * `admin/listings` base path.
 */
@Feature('listings')
@ApiTags('Admin - Directory partners')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/listings/partners')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles()
export class AdminDirectoryPartnersController {
  constructor(private readonly partners: DirectoryPartnersService) {}

  @Get()
  @ApiOperation({
    summary: 'List the directory partners',
    description:
      'Every pick in display order, with the listing summary, the note and the `publicState` that says whether the public row shows it right now.',
  })
  @ApiOkResponse({ description: 'The partners in display order.' })
  listPartners(): Promise<AdminDirectoryPartnerDTO[]> {
    return this.partners.listPartners();
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search listings to add as a partner',
    description:
      'Live, publicly listed, unmoderated listings outside 18+, ranked by folded name, at most 20 rows. A blank `q` answers an empty list and a `q` over 80 characters is cut to its first 80.',
  })
  @ApiOkResponse({ description: 'The matching listings.' })
  searchListings(
    @Query() query: DirectoryPartnerSearchQuery,
  ): Promise<AdminDirectoryPartnerSearchResultDTO[]> {
    return this.partners.searchListings(query.q);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a listing as a directory partner',
    description:
      'Appends the listing at the end of the row. Checks run in this order: `note_too_long`, `listing_not_found`, `already_partner`, `listing_not_live` or `listing_adult_only`, `partner_limit_reached`.',
  })
  @ApiCreatedResponse({ description: 'The full partner list after the add.' })
  @ApiBadRequestResponse({ description: 'Reason `note_too_long`.' })
  @ApiNotFoundResponse({ description: 'Reason `listing_not_found`.' })
  @ApiConflictResponse({
    description:
      'Reason `already_partner`, `listing_not_live`, `listing_adult_only` or `partner_limit_reached`.',
  })
  addPartner(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateDirectoryPartnerDto,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    return this.partners.addPartner(user.userId, body);
  }

  @Patch('order')
  @ApiOperation({
    summary: 'Reorder the directory partners',
    description:
      'The body lists every current pick id exactly once, in the new order.',
  })
  @ApiOkResponse({ description: 'The full partner list in the new order.' })
  @ApiConflictResponse({
    description:
      'Reason `order_mismatch`: the ids are not exactly the current picks.',
  })
  reorderPartners(
    @Body() body: ReorderDirectoryPartnersDto,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    return this.partners.reorderPartners(body.ids);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Set or clear a partner note',
    description: 'A `null` or blank note clears it.',
  })
  @ApiOkResponse({ description: 'The full partner list after the change.' })
  @ApiBadRequestResponse({ description: 'Reason `note_too_long`.' })
  @ApiNotFoundResponse({ description: 'Reason `partner_not_found`.' })
  updateNote(
    @Param('id') pickId: string,
    @Body() body: UpdateDirectoryPartnerNoteDto,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    return this.partners.updateNote(pickId, body);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a directory partner',
    description: 'The remaining picks close up the gap in their order.',
  })
  @ApiOkResponse({ description: 'The full partner list after the removal.' })
  @ApiNotFoundResponse({ description: 'Reason `partner_not_found`.' })
  removePartner(
    @Param('id') pickId: string,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    return this.partners.removePartner(pickId);
  }
}
