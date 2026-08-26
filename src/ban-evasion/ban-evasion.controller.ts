import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { UserRole } from '../users/entities/user.entity';
import { BanEvasionAssessmentDTO } from './ban-evasion-response';
import { BanEvasionService } from './ban-evasion.service';
import { AssessJoinRequestsQuery } from './dto/assess-join-requests.query';

/**
 * Staff-only read surface for ban-evasion signals.
 *
 * READ ONLY, on purpose. There is no endpoint here that bans, blocks, declines
 * or holds anybody: the whole module produces a tier and a list of reasons for a
 * human reviewer, and every decision stays with that reviewer on the surface
 * they already use.
 *
 * Guarded exactly like `AdminJoinRequestsController`, the console that consumes
 * it: `ActiveMemberGuard` + `RolesGuard` with `@Roles(Moderator, Admin)`, at
 * class level so anything added here is staff-only by default.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Ban evasion')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/ban-evasion')
export class BanEvasionController {
  constructor(private readonly banEvasion: BanEvasionService) {}

  /**
   * Assess a page of the invite review queue in one call. Returns one
   * assessment per id that resolved, `tier: 'none'` included, so the console can
   * tell "checked, clear" from "not checked yet".
   */
  @ApiOperation({
    summary: 'Ban-evasion signals for a batch of join requests (advisory).',
  })
  @ApiOkResponse({ description: 'One assessment per resolved join request.' })
  @ApiBadRequestResponse({ description: 'Malformed or oversized id list.' })
  @Get('join-requests')
  assessJoinRequests(
    @Query() query: AssessJoinRequestsQuery,
  ): Promise<BanEvasionAssessmentDTO[]> {
    return this.banEvasion.assessJoinRequests(query.ids);
  }

  /**
   * Assess one account that is already on the platform, for the case where
   * someone got in and staff are now asking whether this is a return.
   */
  @ApiOperation({
    summary: 'Ban-evasion signals for one existing account (advisory).',
  })
  @ApiOkResponse({ description: 'The assessment for that account.' })
  @Get('users/:userId')
  assessUser(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<BanEvasionAssessmentDTO> {
    return this.banEvasion.assessUser(userId);
  }
}
