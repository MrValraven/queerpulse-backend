import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { DraftsService } from './drafts.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@ApiTags('Drafts')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('me/drafts')
@UseGuards(ActiveMemberGuard)
export class DraftsController {
  constructor(private readonly draftsService: DraftsService) {}

  @Get()
  @ApiOperation({ summary: 'List your drafts (paginated).' })
  @ApiOkResponse({ description: 'A page of drafts.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.draftsService.list(user.userId, page);
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft.' })
  @ApiCreatedResponse({ description: 'The created draft.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateDraftDto) {
    return this.draftsService.create(user.userId, dto);
  }

  // `:id` is the caller-supplied opaque draft id (not a uuid) — no
  // ParseUUIDPipe here, unlike most other owned-resource routes.
  @Patch(':id')
  @ApiOperation({ summary: 'Update a draft.' })
  @ApiOkResponse({ description: 'The updated draft.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateDraftDto,
  ) {
    return this.draftsService.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft.' })
  @ApiNoContentResponse({ description: 'The draft was deleted.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  remove(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.draftsService.remove(user.userId, id);
  }
}
