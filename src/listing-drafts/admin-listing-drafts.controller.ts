import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
 * (`AdminOfficialMessagesController`), and finishing it as a team listing
 * through `POST /admin/listings`, also Admin only.
 *
 * Read-only: no route here writes to a member's draft, and none publishes it
 * as the member's own. Publishing in their name carries their consent, so the
 * console can only finish the BUSINESS half as a team listing offered back to
 * them (`GET :id` returns that half and nothing about the member), and they
 * add their own answers and take the pledge when they accept.
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

  @Get(':id')
  @ApiOperation({
    summary:
      "One member's unfinished listing draft: its summary and the business half of its wizard state",
  })
  @ApiOkResponse({
    description:
      'The summary fields plus `payload`: only the business keys of the ' +
      'wizard state (`LISTING_DRAFT_BUSINESS_KEYS`). Never the owner’s ' +
      'personal answers, consents, pledge or queer-owned claim.',
  })
  @ApiNotFoundResponse({
    description: 'No such draft, or it was submitted or discarded.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminListingDrafts.getOne(id);
  }
}
