import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HandleCheck, HandlesService } from './handles.service';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@ApiTags('Handles')
@ApiCookieAuth('access_token')
@Controller('handles')
export class HandlesController {
  constructor(private readonly handlesService: HandlesService) {}

  // Live availability check for the username/handle fields (design plan PART C /
  // UC4). Active members only — an unauthenticated visitor has no reason to probe
  // the namespace. Returns the shared `HandleCheck` shape the frontend consumes.
  @Get('check')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Check whether a username/handle is available' })
  @ApiOkResponse({
    description: 'Availability result with a reason when unavailable.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated as an active member.',
  })
  check(@Query('name') name: string): Promise<HandleCheck> {
    return this.handlesService.check(name ?? '');
  }
}
