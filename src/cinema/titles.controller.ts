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
import { CinemaService } from './cinema.service';
import { ListTitlesQuery } from './dto/list-titles.query';
import { ReportProgressDto } from './dto/report-progress.dto';

@Controller('cinema/titles')
@UseGuards(ActiveMemberGuard)
export class TitlesController {
  constructor(private readonly cinema: CinemaService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListTitlesQuery) {
    return this.cinema.listTitles(user, query.all === 'true');
  }

  @Get(':id')
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
  playback(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.cinema.createPlaybackSession(user, id);
  }

  @Put(':id/progress')
  progress(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportProgressDto,
  ) {
    return this.cinema.reportProgress(user, id, dto.positionSeconds);
  }
}
