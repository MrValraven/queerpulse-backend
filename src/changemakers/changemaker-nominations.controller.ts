import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ChangemakerNominationsService } from './changemaker-nominations.service';
import { CreateChangemakerNominationDto } from './dto/create-changemaker-nomination.dto';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// The Change Makers page (`ChangemakersPage.tsx`) profiles curated change
// makers with no server-backed directory of its own. The one genuine piece
// of member-submitted data on the page is the "Nominate them" form — this
// controller is that, and only that.
@Feature('community')
@ApiTags('Changemakers')
@ApiCookieAuth()
@Controller('changemakers')
@UseGuards(ActiveMemberGuard)
export class ChangemakerNominationsController {
  constructor(
    private readonly changemakerNominationsService: ChangemakerNominationsService,
  ) {}

  @Post('nominations')
  @ApiOperation({ summary: 'Nominate someone as a changemaker.' })
  @ApiCreatedResponse({
    description: 'The nomination was recorded; echoes the submitted nominee.',
  })
  @ApiBadRequestResponse({ description: 'The nomination payload is invalid.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateChangemakerNominationDto,
  ) {
    return this.changemakerNominationsService.create(user.userId, dto);
  }
}
