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
import { UserRole } from '../users/entities/user.entity';
import {
  AddPersonaWallPickDto,
  PersonaWallSearchQuery,
  ReorderPersonaWallPicksDto,
  UpdatePersonaWallSettingsDto,
} from './dto/persona-wall.dto';
import { PersonaWallService } from './persona-wall.service';

/**
 * The admin routes that hand-pick the personas shown on the wall at the top of
 * the People Directory, and set the order that fills the rest of it.
 *
 * Admin only, because the wall is an editorial decision. The class carries
 * `@Roles(UserRole.Admin)` and an EMPTY `@StaffRoles()`: the empty list
 * switches the grant axis off, so a Moderator and a holder of a staff grant
 * are both refused. See the `RolesOrStaffGuard` doc for why the empty list is
 * needed, and `AdminDirectoryPartnersController` for the same gate on the
 * business directory.
 *
 * Route table. Every route answers the full admin view (`fillOrder`, `picks`
 * and `preview`) after a write, except the search, and every refusal carries
 * a `code`:
 *
 *   GET    admin/personas/wall                load picks, fill order, preview
 *   GET    admin/personas/wall/search         picker search, at most 20 rows
 *   POST   admin/personas/wall/picks          add a persona at the end
 *   PATCH  admin/personas/wall/picks/reorder  set the order of every pick
 *   DELETE admin/personas/wall/picks/:id      remove a pick
 *   PATCH  admin/personas/wall/settings       set the fill order
 *
 * Reason codes per route:
 *
 *   POST    PERSONA_WALL_PERSONA_NOT_FOUND, PERSONA_WALL_ALREADY_PICKED,
 *           PERSONA_WALL_NOT_LISTED, PERSONA_WALL_FULL (checked in this order)
 *   PATCH   picks/reorder: PERSONA_WALL_REORDER_MISMATCH
 *   DELETE  PERSONA_WALL_PICK_NOT_FOUND
 *   PATCH   settings: PERSONA_WALL_INVALID_FILL_ORDER
 *
 * The literal `search`, `picks/reorder` and `settings` routes are declared
 * before the `picks/:id` route so Nest matches the literal.
 */
@ApiTags('Admin - Persona wall')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/personas/wall')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles()
export class AdminPersonaWallController {
  constructor(private readonly personaWall: PersonaWallService) {}

  @Get()
  @ApiOperation({
    summary: 'Load the persona wall for editing',
    description:
      'The fill order, every pick in wall order with the persona summary and the `publicState` that says whether the public wall shows it right now, and a preview of the wall as most members see it.',
  })
  @ApiOkResponse({ description: 'The fill order, the picks and the preview.' })
  getWall() {
    return this.personaWall.adminView();
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search personas to put on the wall',
    description:
      'Live personas that pass the directory rules, ranked by name, at most 20 rows, each marked with `isPicked`. A blank `q` answers an empty list and a `q` over 100 characters is cut to its first 100.',
  })
  @ApiOkResponse({ description: 'The matching personas.' })
  searchPersonas(@Query() query: PersonaWallSearchQuery) {
    return this.personaWall.searchPersonas(query.q);
  }

  @Post('picks')
  @ApiOperation({
    summary: 'Put a persona on the wall',
    description:
      'Appends the persona after the last pick. Checks run in this order: `PERSONA_WALL_PERSONA_NOT_FOUND`, `PERSONA_WALL_ALREADY_PICKED`, `PERSONA_WALL_NOT_LISTED`, `PERSONA_WALL_FULL`.',
  })
  @ApiCreatedResponse({ description: 'The full admin view after the add.' })
  @ApiBadRequestResponse({
    description:
      'Code `PERSONA_WALL_PERSONA_NOT_FOUND`: `subprofileId` is missing or is not a persona id.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `PERSONA_WALL_PERSONA_NOT_FOUND`: no persona has that id.',
  })
  @ApiConflictResponse({
    description:
      'Code `PERSONA_WALL_ALREADY_PICKED`, `PERSONA_WALL_NOT_LISTED` (the body also names the persona `publicState`) or `PERSONA_WALL_FULL`.',
  })
  addPick(
    @CurrentUser() user: CurrentUserData,
    @Body() body: AddPersonaWallPickDto,
  ) {
    return this.personaWall.addPick(user.userId, body.subprofileId);
  }

  @Patch('picks/reorder')
  @ApiOperation({
    summary: 'Reorder the wall picks',
    description:
      'The body lists every current pick id exactly once, in the new order.',
  })
  @ApiOkResponse({ description: 'The full admin view in the new order.' })
  @ApiConflictResponse({
    description:
      'Code `PERSONA_WALL_REORDER_MISMATCH`: the ids are not exactly the current picks.',
  })
  reorderPicks(@Body() body: ReorderPersonaWallPicksDto) {
    return this.personaWall.reorderPicks(body.ids);
  }

  @Delete('picks/:id')
  @ApiOperation({
    summary: 'Take a persona off the wall',
    description: 'The remaining picks keep their order.',
  })
  @ApiOkResponse({ description: 'The full admin view after the removal.' })
  @ApiNotFoundResponse({
    description:
      'Code `PERSONA_WALL_PICK_NOT_FOUND`: no pick has that id, or the id is not a uuid.',
  })
  removePick(@Param('id') pickId: string) {
    return this.personaWall.removePick(pickId);
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Set the fill order of the persona wall',
    description:
      'The order that fills the tiles the picks leave open: `endorsed`, `followed`, `newest` or `daily_shuffle`.',
  })
  @ApiOkResponse({
    description: 'The full admin view with the new fill order.',
  })
  @ApiBadRequestResponse({
    description:
      'Code `PERSONA_WALL_INVALID_FILL_ORDER`: `fillOrder` is missing or unknown.',
  })
  updateSettings(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdatePersonaWallSettingsDto,
  ) {
    return this.personaWall.updateSettings(user.userId, body.fillOrder);
  }
}
