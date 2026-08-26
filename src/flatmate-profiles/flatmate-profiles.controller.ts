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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { SayHelloDto } from './dto/say-hello.dto';
import { UpsertFlatmateProfileDto } from './dto/upsert-flatmate-profile.dto';
import { FlatmateProfilesService } from './flatmate-profiles.service';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/** A member's own flatmate profile (one per member) + "say hello". `/mine` is a
 * literal segment; the only `:slug` route is `POST /:slug/hello` (distinct verb
 * + depth), so no route collision. */
@Feature('flatmateProfiles')
@ApiTags('Flatmates')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('flatmate-profiles')
@UseGuards(ActiveMemberGuard)
export class FlatmateProfilesController {
  constructor(private readonly service: FlatmateProfilesService) {}

  @Put('mine')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: "Create or replace the caller's flatmate profile" })
  @ApiOkResponse({ description: 'The saved flatmate profile.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique slug for the new profile.',
  })
  upsertMine(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpsertFlatmateProfileDto,
  ) {
    return this.service.upsertMine(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "Get the caller's own flatmate profile" })
  @ApiOkResponse({
    description: "The caller's flatmate profile, or null if none exists.",
  })
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.service.getMine(user.userId);
  }

  @Delete('mine')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete the caller's flatmate profile (idempotent)",
  })
  @ApiNoContentResponse({ description: 'Profile deleted (or none existed).' })
  deleteMine(@CurrentUser() user: CurrentUserData) {
    return this.service.deleteMine(user.userId);
  }

  @Post(':slug/hello')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: "Say hello to a flatmate profile's owner (opens a conversation)",
  })
  @ApiCreatedResponse({
    description: 'Greeting delivered; returns the conversation id.',
  })
  @ApiBadRequestResponse({
    description: 'You cannot say hello to your own profile.',
  })
  @ApiNotFoundResponse({ description: 'Flatmate profile not found.' })
  sayHello(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: SayHelloDto,
  ) {
    return this.service.sayHello(slug, user.userId, dto);
  }
}
