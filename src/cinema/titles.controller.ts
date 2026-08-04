import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CinemaService } from './cinema.service';
import { ListTitlesQuery } from './dto/list-titles.query';
import { ReportProgressDto } from './dto/report-progress.dto';
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

@Feature('cinema')
@ApiTags('Cinema')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('cinema/titles')
@UseGuards(ActiveMemberGuard)
export class TitlesController {
  constructor(private readonly cinema: CinemaService) {}

  @Get()
  @ApiOperation({
    summary: 'List published cinema titles (or all titles for moderators).',
  })
  @ApiOkResponse({
    description:
      "Visible titles with the caller's watch progress; admin fields when all=true.",
  })
  @ApiForbiddenResponse({
    description: 'all=true requires a moderator or admin role.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListTitlesQuery) {
    return this.cinema.listTitles(user, query.all === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single visible cinema title by id.' })
  @ApiOkResponse({ description: "The title with the caller's watch progress." })
  @ApiBadRequestResponse({ description: 'Malformed title id.' })
  @ApiNotFoundResponse({ description: 'No visible title exists for this id.' })
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cinema.getTitle(user, id);
  }

  // Responses embed short-TTL signed URLs — never cacheable.
  @Post(':id/playback')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Start a playback session (signed Mux tokens + resume position).',
  })
  @ApiOkResponse({
    description:
      'Signed playback tokens with the resume position and duration.',
  })
  @ApiBadRequestResponse({ description: 'Malformed title id.' })
  @ApiNotFoundResponse({ description: 'No playable title exists for this id.' })
  @ApiConflictResponse({ description: 'The title has no playable asset.' })
  playback(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cinema.createPlaybackSession(user, id);
  }

  @Put(':id/progress')
  @ApiOperation({ summary: 'Report watch progress for a title.' })
  @ApiOkResponse({
    description: 'The saved position and whether this call counted a view.',
  })
  @ApiBadRequestResponse({
    description: 'Malformed id or a position beyond the title duration.',
  })
  @ApiNotFoundResponse({ description: 'No playable title exists for this id.' })
  progress(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportProgressDto,
  ) {
    return this.cinema.reportProgress(user, id, dto.positionSeconds);
  }
}
