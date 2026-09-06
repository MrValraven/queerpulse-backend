import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { UpdatePartnerProfileDto } from './dto/update-partner-profile.dto';
import { PartnersService } from './partners.service';

/**
 * A partner maintaining its OWN public profile (PRD-263).
 *
 * A separate controller and a separate path prefix, for the two reasons this
 * module already splits its controllers:
 *
 *  - GUARD SHAPE. `PartnersController` is the public directory; both of its
 *    reads carry `@Public()` and answer a logged-out visitor. Hanging an
 *    owner-scoped write off that class would put a member-only route in the
 *    one place where "public by default" is the local convention.
 *  - ROUTE MATCHING. That controller owns `GET /partners/:slug`, so a literal
 *    `/partners/mine` segment would have to be declared before it forever.
 *    `my-partners` cannot collide with anything.
 *
 * `ActiveMemberGuard` and nothing more: ownership is not a role, it is a fact
 * about a row, and it is checked inside the service against the SESSION's user
 * id. No route here takes an owner id from the wire.
 */
@Feature('partners')
@ApiTags('Partners')
@ApiCookieAuth()
@Controller('my-partners')
@UseGuards(ActiveMemberGuard)
export class PartnerOwnerController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'The partner profiles the caller maintains' })
  @ApiOkResponse({
    description:
      'Every approved partner this member owns, newest first. Empty for a member who maintains none.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an active member account.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.partnersService.listOwned(user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Update the caller's own partner profile" })
  @ApiOkResponse({ description: 'The updated partner profile.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'The profile is not published, so it cannot be edited.',
  })
  @ApiNotFoundResponse({
    description: 'No partner with that id that this member owns.',
  })
  updateMine(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerProfileDto,
  ) {
    return this.partnersService.updateOwnedProfile(user.userId, id, dto);
  }
}
