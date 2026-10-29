import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
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
import { CreateStudioAccessRequestDto } from './dto/studio-access-request.dto';
import { StudioAccessRequestsService } from './studio-access-requests.service';
import { StudioAccessRequestState } from './studio-landing-response';

/**
 * A member asks for Studio access. The controller carries no Studio grant
 * guard because its callers have no grant by definition.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('studio/access-requests')
@UseGuards(ActiveMemberGuard)
export class StudioAccessRequestsController {
  constructor(private readonly accessRequests: StudioAccessRequestsService) {}

  @Post()
  @ApiOperation({ summary: 'Asks for Studio access.' })
  @ApiCreatedResponse({ description: '`StudioAccessRequestState`.' })
  @ApiConflictResponse({
    description:
      '`studio_access_already_granted` or `studio_access_request_exists`.',
  })
  requestAccess(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioAccessRequestDto,
  ): Promise<StudioAccessRequestState> {
    return this.accessRequests.requestAccess(user.userId, body.wantsToRelease);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraws the caller request; idempotent.' })
  @ApiNoContentResponse({ description: 'The request is gone.' })
  cancelRequest(@CurrentUser() user: CurrentUserData): Promise<void> {
    return this.accessRequests.cancelRequest(user.userId);
  }
}
