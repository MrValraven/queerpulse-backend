import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { SayHelloDto } from './dto/say-hello.dto';
import { UpsertFlatmateProfileDto } from './dto/upsert-flatmate-profile.dto';
import { FlatmateProfilesService } from './flatmate-profiles.service';

/** A member's own flatmate profile (one per member) + "say hello". `/mine` is a
 * literal segment; the only `:slug` route is `POST /:slug/hello` (distinct verb
 * + depth), so no route collision. */
@Feature('flatmateProfiles')
@Controller('flatmate-profiles')
@UseGuards(ActiveMemberGuard)
export class FlatmateProfilesController {
  constructor(private readonly service: FlatmateProfilesService) {}

  @Put('mine')
  upsertMine(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpsertFlatmateProfileDto,
  ) {
    return this.service.upsertMine(user.userId, dto);
  }

  @Get('mine')
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.service.getMine(user.userId);
  }

  @Delete('mine')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMine(@CurrentUser() user: CurrentUserData) {
    return this.service.deleteMine(user.userId);
  }

  @Post(':slug/hello')
  sayHello(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: SayHelloDto,
  ) {
    return this.service.sayHello(slug, user.userId, dto);
  }
}
