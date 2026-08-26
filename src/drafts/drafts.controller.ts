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
  @ApiConflictResponse({
    description:
      'A draft with this id already exists for the caller. Ids are client-minted, so a reused one is a bug or a retry — it never overwrites the existing draft.',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateDraftDto) {
    return this.draftsService.create(user.userId, dto);
  }

  // Declared BEFORE `@Patch(':id')` purely for readability; Nest routes by
  // method + path, so ordering between different verbs never matters.
  // `:id` is the caller-supplied opaque draft id (not a uuid) — no
  // ParseUUIDPipe on any of these three, unlike most other owned-resource
  // routes.
  @Get(':id')
  @ApiOperation({ summary: 'Get one of your drafts by its id.' })
  @ApiOkResponse({ description: 'The draft.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  get(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.draftsService.get(user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a draft.' })
  @ApiOkResponse({ description: 'The updated draft.' })
  @ApiNotFoundResponse({ description: 'No draft with that id for the caller.' })
  @ApiConflictResponse({
    description:
      'The draft changed since this client read it (another tab saved). Send the `version` from the latest read as `expectedVersion`; reload before saving again.',
  })
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
