import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { TakedownStudioReleaseDto } from './dto/takedown-studio-release.dto';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioModerationService } from './studio-moderation.service';
import { StudioReleaseResponse } from './studio-response';

// The reports queue's Studio actions. No Studio grant needed: staff read and
// act on reported releases whether or not they listen in Studio.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/releases')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioReleasesController {
  constructor(
    private readonly catalog: StudioCatalogService,
    private readonly moderation: StudioModerationService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Any release, for the reports queue.' })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  getRelease(
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.catalog.getReleaseForStaff(releaseId);
  }

  @Post(':id/takedown')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a release down, with a reason.' })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  takedown(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: TakedownStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    return this.moderation.takedown(user.userId, releaseId, body.reason);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a taken-down release.' })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  restore(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.moderation.restore(user.userId, releaseId);
  }
}
