import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { PlatformAmbassadorRowDTO } from './ambassador-response';
import { AmbassadorStatusService } from './ambassador-status.service';

// Always-on member primitive, the ambassador twin of `GET /platform/staff`:
// members only, id-free rows, consumed by the frontend's `useAmbassadorMap`.
@ApiTags('Platform Ambassadors')
@ApiCookieAuth()
@Controller('platform/ambassadors')
@UseGuards(ActiveMemberGuard)
export class PlatformAmbassadorsController {
  constructor(private readonly ambassadorStatus: AmbassadorStatusService) {}

  @ApiOperation({
    summary: 'List the active QueerPulse Ambassadors who show their tag.',
  })
  @ApiOkResponse({
    description:
      'Slug, focus area and start date for every active, visible ambassador on an active account.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get()
  list(): Promise<PlatformAmbassadorRowDTO[]> {
    return this.ambassadorStatus.listVisibleRoster();
  }
}
