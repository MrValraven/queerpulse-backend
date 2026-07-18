import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateWorkshopDto } from './dto/create-workshop.dto';
import { ListWorkshopsQuery } from './dto/list-workshops.query';
import { UpdateWorkshopDto } from './dto/update-workshop.dto';
import { WorkshopsService } from './workshops.service';

/**
 * Member-hosted, multi-week workshops — the catalogue behind the frontend's
 * Skills & learning page (`SkillsPage` -> `WorkshopsSection`) and each
 * workshop's own page (`WorkshopPage`). FE: `workshops.api.ts`.
 *
 * `list` takes the viewer so block/mute filtering can run inside the query
 * (see `WorkshopsService.list`); `update`/`remove` are host-gated in the
 * service, mirroring `jobs`' poster gating.
 */
@Feature('workshops')
@Controller('workshops')
@UseGuards(ActiveMemberGuard)
export class WorkshopsController {
  constructor(private readonly workshopsService: WorkshopsService) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListWorkshopsQuery,
  ) {
    return this.workshopsService.list(user.userId, query);
  }

  @Get(':slug')
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.workshopsService.getBySlug(slug, user.userId);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateWorkshopDto) {
    return this.workshopsService.create(user.userId, dto);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateWorkshopDto,
  ) {
    return this.workshopsService.update(slug, user.userId, dto);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.workshopsService.remove(slug, user.userId);
  }
}
