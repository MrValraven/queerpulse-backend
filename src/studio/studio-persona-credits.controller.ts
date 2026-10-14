import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateStudioPersonaCreditDto } from './dto/create-studio-persona-credit.dto';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioCreditCandidate,
  StudioPersonaCreditOwnerRow,
} from './studio-persona-credit-response';
import { StudioPersonaCreditsService } from './studio-persona-credits.service';

// The track routes here match `studio/tracks/<id>/`, which
// `isStudioListeningRequest` already keeps out of the request log, the
// HTTP metrics and Sentry. The candidate lookup is logged as usual.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: '`studio_access_required` or `studio_not_persona_owner`.',
})
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPersonaCreditsController {
  constructor(private readonly credits: StudioPersonaCreditsService) {}

  @Get('credit-candidates/:handle')
  @ApiOperation({ summary: 'The public card of the persona holding a handle.' })
  @ApiOkResponse({ description: '`StudioCreditCandidate`.' })
  @ApiNotFoundResponse({ description: '`studio_credit_candidate_not_found`.' })
  findCandidate(
    @CurrentUser() user: CurrentUserData,
    @Param('handle') handle: string,
  ): Promise<StudioCreditCandidate> {
    return this.credits.findCandidate(user.userId, handle);
  }

  @Get('tracks/:id/persona-credits')
  @ApiOperation({ summary: "A track's persona credits, for its editor." })
  @ApiOkResponse({ description: '`{ items: StudioPersonaCreditOwnerRow[] }`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  listForTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<{ items: StudioPersonaCreditOwnerRow[] }> {
    return this.credits.listForTrack(user.userId, trackId);
  }

  @Post('tracks/:id/persona-credits')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Credit a persona on a track; it starts pending.' })
  @ApiCreatedResponse({ description: '`StudioPersonaCreditOwnerRow`.' })
  @ApiNotFoundResponse({ description: 'Track not found.' })
  @ApiConflictResponse({
    description:
      '`studio_release_not_draft`, `studio_credit_already_requested` or `studio_credit_limit`.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`studio_credit_persona_not_creditable` or `studio_credit_self_persona`.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: CreateStudioPersonaCreditDto,
  ): Promise<StudioPersonaCreditOwnerRow> {
    return this.credits.create(user.userId, trackId, body);
  }

  @Delete('tracks/:id/persona-credits/:creditId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a persona credit from a track.' })
  @ApiNoContentResponse({ description: 'Removed, or dismissed if declined.' })
  @ApiNotFoundResponse({ description: '`studio_credit_not_found`.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
  ): Promise<void> {
    return this.credits.removeFromTrack(user.userId, trackId, creditId);
  }
}
