import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { StudioCursorQuery } from './dto/studio-cursor.query';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPage, StudioReleaseCard } from './studio-response';
import { StudioSceneCard, StudioSceneResponse } from './studio-scene-response';
import { StudioScenesService } from './studio-scenes.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/scenes')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioScenesController {
  constructor(private readonly scenes: StudioScenesService) {}

  @Get()
  @ApiOperation({ summary: 'Active scenes, in home row order.' })
  @ApiOkResponse({ description: '`{ items: StudioSceneCard[] }`.' })
  listScenes(): Promise<{ items: StudioSceneCard[] }> {
    return this.scenes.listScenes();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'One scene with its artists and upcoming events.' })
  @ApiOkResponse({ description: '`StudioScene`.' })
  @ApiNotFoundResponse({ description: '`studio_scene_not_found`.' })
  getScene(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<StudioSceneResponse> {
    return this.scenes.getScene(user.userId, slug);
  }

  @Get(':slug/releases')
  @ApiOperation({ summary: 'Listenable releases of a scene, newest first.' })
  @ApiOkResponse({ description: '`StudioPage<StudioReleaseCard>`.' })
  @ApiNotFoundResponse({ description: '`studio_scene_not_found`.' })
  listSceneReleases(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: StudioCursorQuery,
  ): Promise<StudioPage<StudioReleaseCard>> {
    return this.scenes.listSceneReleases(user.userId, slug, query.cursor);
  }
}
