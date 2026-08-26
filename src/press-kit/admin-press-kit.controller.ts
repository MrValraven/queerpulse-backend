import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreatePressContactDto } from './dto/create-press-contact.dto';
import { CreatePressCoverageDto } from './dto/create-press-coverage.dto';
import { ReorderPressKitDto } from './dto/reorder-press-kit.dto';
import { UpdatePressContactDto } from './dto/update-press-contact.dto';
import { UpdatePressCoverageDto } from './dto/update-press-coverage.dto';
import { PressKitService } from './press-kit.service';

/**
 * Admin CRUD + reorder over the two press-kit lists (coverage, contacts): list
 * every row (active AND inactive) and create/update/reorder/delete.
 *
 * Deliberately NOT `@LockdownExempt()` — mirrors `AdminLandingController`:
 * nothing here can lift a lockdown, so this surface should go dark with
 * everything else. The facts on the public payload are DERIVED (not editable),
 * so there is no admin surface for them.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('editorial')
@ApiTags('Admin — Press kit')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `editorial` staff role.',
})
@Controller('admin/press-kit')
export class AdminPressKitController {
  constructor(private readonly pressKit: PressKitService) {}

  // ---- Coverage -----------------------------------------------------------

  @ApiOperation({
    summary: 'List every press-coverage row (active and inactive), ordered.',
  })
  @ApiOkResponse({ description: 'The coverage rows in position order.' })
  @Get('coverage')
  listCoverage() {
    return this.pressKit.listAdminCoverage();
  }

  @ApiOperation({ summary: 'Create a press-coverage row.' })
  @ApiOkResponse({ description: 'The created coverage row.' })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @Post('coverage')
  createCoverage(
    @CurrentUser() currentUser: CurrentUserData,
    @Body() dto: CreatePressCoverageDto,
  ) {
    return this.pressKit.createCoverage(currentUser.userId, dto);
  }

  // Declared before ':id' so 'reorder' is not captured as an id param — same
  // precedent as `AdminLandingController`.
  @ApiOperation({ summary: 'Rewrite the position of every coverage row.' })
  @ApiOkResponse({ description: 'The coverage rows in their new order.' })
  @ApiBadRequestResponse({
    description: 'orderedIds is not exactly the current set of coverage ids.',
  })
  @Patch('coverage/reorder')
  reorderCoverage(@Body() dto: ReorderPressKitDto) {
    return this.pressKit.reorderCoverage(dto);
  }

  @ApiOperation({ summary: "Update a coverage row's copy and/or active flag." })
  @ApiOkResponse({ description: 'The updated coverage row.' })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({ description: 'Press coverage not found.' })
  @Patch('coverage/:id')
  updateCoverage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePressCoverageDto,
  ) {
    return this.pressKit.updateCoverage(id, dto);
  }

  @ApiOperation({ summary: 'Delete a coverage row.' })
  @ApiOkResponse({ description: 'The coverage row was deleted.' })
  @ApiNotFoundResponse({ description: 'Press coverage not found.' })
  @Delete('coverage/:id')
  deleteCoverage(@Param('id', ParseUUIDPipe) id: string) {
    return this.pressKit.deleteCoverage(id);
  }

  // ---- Contacts -----------------------------------------------------------

  @ApiOperation({
    summary: 'List every press-contact row (active and inactive), ordered.',
  })
  @ApiOkResponse({ description: 'The contact rows in position order.' })
  @Get('contacts')
  listContacts() {
    return this.pressKit.listAdminContacts();
  }

  @ApiOperation({ summary: 'Create a press-contact row.' })
  @ApiOkResponse({ description: 'The created contact row.' })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @Post('contacts')
  createContact(
    @CurrentUser() currentUser: CurrentUserData,
    @Body() dto: CreatePressContactDto,
  ) {
    return this.pressKit.createContact(currentUser.userId, dto);
  }

  // Declared before ':id' so 'reorder' is not captured as an id param.
  @ApiOperation({ summary: 'Rewrite the position of every contact row.' })
  @ApiOkResponse({ description: 'The contact rows in their new order.' })
  @ApiBadRequestResponse({
    description: 'orderedIds is not exactly the current set of contact ids.',
  })
  @Patch('contacts/reorder')
  reorderContacts(@Body() dto: ReorderPressKitDto) {
    return this.pressKit.reorderContacts(dto);
  }

  @ApiOperation({ summary: "Update a contact row's copy and/or active flag." })
  @ApiOkResponse({ description: 'The updated contact row.' })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({ description: 'Press contact not found.' })
  @Patch('contacts/:id')
  updateContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePressContactDto,
  ) {
    return this.pressKit.updateContact(id, dto);
  }

  @ApiOperation({ summary: 'Delete a contact row.' })
  @ApiOkResponse({ description: 'The contact row was deleted.' })
  @ApiNotFoundResponse({ description: 'Press contact not found.' })
  @Delete('contacts/:id')
  deleteContact(@Param('id', ParseUUIDPipe) id: string) {
    return this.pressKit.deleteContact(id);
  }
}
