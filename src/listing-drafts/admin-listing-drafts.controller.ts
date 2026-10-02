import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminListingDraftsService } from './admin-listing-drafts.service';
import { ListAdminListingDraftsQuery } from './dto/list-admin-listing-drafts.query';

/**
 * Members' unfinished "list a business" drafts, for the admin console's
 * "Unfinished drafts" tab. Admin only, with no `@StaffRoles` union: a draft
 * is a member's unsubmitted work, and the console's only action on it is
 * reaching out through the official thread, which is itself `@Roles(Admin)`
 * (`AdminOfficialMessagesController`). Read-only: staff can never open, edit
 * or publish a draft, since publishing carries the owner's own consent.
 */
@Feature('listings')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin: Listing drafts')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/listing-drafts')
export class AdminListingDraftsController {
  constructor(private readonly adminListingDrafts: AdminListingDraftsService) {}

  @Get()
  @ApiOperation({
    summary: "List members' unfinished listing drafts (newest edited first)",
  })
  @ApiOkResponse({
    description:
      'A `{ items, total, page, pageSize }` page of draft summaries: name, ' +
      'neighbourhood, wizard path, step reached, owner and dates. Never the ' +
      'draft payload, which carries the owner’s consent decisions.',
  })
  list(@Query() query: ListAdminListingDraftsQuery) {
    return this.adminListingDrafts.list(query);
  }
}
