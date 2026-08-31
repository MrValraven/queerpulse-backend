import {
  Body,
  Controller,
  Get,
  Param,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminLegalRequestDTO,
  AdminLegalRequestPageDTO,
} from './legal-request-response';
import { CreateLegalRequestDto } from './dto/create-legal-request.dto';
import { ListLegalRequestsQuery } from './dto/list-legal-requests.query';
import { UpdateLegalRequestDto } from './dto/update-legal-request.dto';
import { VoidLegalRequestDto } from './dto/void-legal-request.dto';
import { LegalRequestsService } from './legal-requests.service';

/**
 * Where staff record a demand from a court, a police force, a ministry or any
 * other arm of a state, for the public Transparency Report to count (PRD-32).
 *
 * ## Admin only, deliberately
 *
 * `@Roles(UserRole.Admin)` alone, where the neighbouring staff queues
 * (`AdminDsarController`, `AdminStatusIncidentsController`) take
 * `Moderator, Admin`. Every row here names a state body, a jurisdiction and a
 * number of members it came for, which makes this the most sensitive table in
 * the product: the moderation rota is a much wider group than the people who
 * should be able to read a police file, and a legal register is not
 * operational moderation work. There is no Editor role in this codebase, so
 * this is as narrow as a role guard goes.
 *
 * ## There is no DELETE route
 *
 * Not an omission. A register of state demands that can be quietly emptied is
 * worth less than no register, because its silence is still published as a
 * zero. `POST :id/void` is the only way a record leaves the published figures,
 * it requires a written reason, it keeps the row, and the count of voided
 * records is itself published.
 *
 * Deliberately NOT `@LockdownExempt()`, matching `AdminDsarController`: the
 * register goes dark with the rest of the admin dashboard during a lockdown.
 * The PUBLIC aggregate it feeds is served by `TransparencyController`, which
 * stays readable throughout.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin: legal requests')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the admin role. The moderator role is deliberately not enough.',
})
@Controller('admin/legal-requests')
export class AdminLegalRequestsController {
  constructor(private readonly legalRequests: LegalRequestsService) {}

  @ApiOperation({
    summary:
      'List the register, newest demand first (paginated). Voided records ' +
      'are included unless state=active narrows them out.',
  })
  @ApiOkResponse({ description: 'One page of the register.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get()
  list(
    @Query() query: ListLegalRequestsQuery,
  ): Promise<AdminLegalRequestPageDTO> {
    return this.legalRequests.list(query);
  }

  @ApiOperation({ summary: 'One recorded demand in full.' })
  @ApiOkResponse({ description: 'The recorded demand.' })
  @ApiNotFoundResponse({ description: 'No legal request with that id.' })
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminLegalRequestDTO> {
    return this.legalRequests.findOne(id);
  }

  @ApiOperation({
    summary:
      'Record a demand. The outcome may be left pending and completed later.',
  })
  @ApiOkResponse({ description: 'The recorded demand.' })
  @ApiBadRequestResponse({
    description:
      'Malformed body, more accounts notified than affected, a notified ' +
      'count without its date, or a disclosure with nobody notified and no ' +
      'reason on file.',
  })
  @Post()
  create(
    @CurrentUser() actingAdmin: CurrentUserData,
    @Body() dto: CreateLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    return this.legalRequests.create(actingAdmin.userId, dto);
  }

  @ApiOperation({
    summary: 'Amend a record (partial; omitted fields stay as they are).',
  })
  @ApiOkResponse({ description: 'The record as it now stands.' })
  @ApiBadRequestResponse({
    description: 'Malformed body, or a merged record that contradicts itself.',
  })
  @ApiNotFoundResponse({ description: 'No legal request with that id.' })
  @ApiConflictResponse({
    description: 'The record is voided, and a voided record is frozen.',
  })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    return this.legalRequests.update(id, dto);
  }

  @ApiOperation({
    summary:
      'Strike a record from the published figures. The row stays, the reason ' +
      'is stored, and the count of voided records is published.',
  })
  @ApiOkResponse({ description: 'The struck record.' })
  @ApiBadRequestResponse({ description: 'A reason is required.' })
  @ApiNotFoundResponse({ description: 'No legal request with that id.' })
  @ApiConflictResponse({ description: 'That record is already voided.' })
  @Post(':id/void')
  voidRecord(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actingAdmin: CurrentUserData,
    @Body() dto: VoidLegalRequestDto,
  ): Promise<AdminLegalRequestDTO> {
    return this.legalRequests.voidRecord(id, actingAdmin.userId, dto);
  }
}
