import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { AddCollectionItemDto } from './dto/add-collection-item.dto';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { CollectionsService } from './collections.service';

// Named groupings of a member's saved items (P2-11). Owner-scoped: every route
// keys off `CurrentUser().userId`, so a collection is only ever visible to its
// creator. `:id` is always a real uuid → `ParseUUIDPipe`; item `:ref` is the
// composite `<kind>:<subjectId>` (a slug may not be a uuid) → parsed, not piped.
@ApiTags('Collections')
@ApiCookieAuth('access_token')
@Controller('me/collections')
@UseGuards(ActiveMemberGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @ApiOperation({ summary: "List the member's collections." })
  @ApiOkResponse({ description: 'The collections, newest-updated first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.collectionsService.list(user.userId);
  }

  // Declared before `:id` — a literal segment must be matched first, or Nest
  // would route this into `getOne` with id="filed-refs" and 400 on the uuid pipe.
  @ApiOperation({
    summary: "List every saved-item ref filed in any of the member's collections.",
  })
  @ApiOkResponse({ description: 'The filed refs, e.g. ["article:my-slug"].' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get('filed-refs')
  listFiledRefs(@CurrentUser() user: CurrentUserData) {
    return this.collectionsService.listFiledRefs(user.userId);
  }

  @ApiOperation({ summary: 'Create a new (empty) collection.' })
  @ApiCreatedResponse({ description: 'The created collection.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateCollectionDto,
  ) {
    return this.collectionsService.create(user.userId, body);
  }

  @ApiOperation({ summary: 'Get one collection with its items.' })
  @ApiOkResponse({ description: 'The collection and its hydrated items.' })
  @ApiNotFoundResponse({ description: 'No such collection for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Get(':id')
  getOne(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.collectionsService.getOne(user.userId, id);
  }

  @ApiOperation({ summary: 'Rename / re-cover a collection.' })
  @ApiOkResponse({ description: 'The updated collection.' })
  @ApiNotFoundResponse({ description: 'No such collection for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Patch(':id')
  rename(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCollectionDto,
  ) {
    return this.collectionsService.rename(user.userId, id, body);
  }

  @ApiOperation({ summary: 'Delete a collection (its items cascade).' })
  @ApiNoContentResponse({ description: 'The collection was deleted.' })
  @ApiNotFoundResponse({ description: 'No such collection for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.collectionsService.remove(user.userId, id);
  }

  @ApiOperation({ summary: 'Add a saved item to a collection.' })
  @ApiNoContentResponse({ description: 'The item is filed in the collection.' })
  @ApiBadRequestResponse({ description: 'Malformed item ref.' })
  @ApiNotFoundResponse({ description: 'No such collection for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Post(':id/items')
  @HttpCode(HttpStatus.NO_CONTENT)
  addItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddCollectionItemDto,
  ) {
    return this.collectionsService.addItem(user.userId, id, body.ref);
  }

  @ApiOperation({ summary: 'Remove an item from a collection.' })
  @ApiNoContentResponse({ description: 'The item is no longer filed.' })
  @ApiBadRequestResponse({ description: 'Malformed item ref.' })
  @ApiNotFoundResponse({ description: 'No such collection for this member.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @Delete(':id/items/:ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('ref') ref: string,
  ) {
    return this.collectionsService.removeItem(user.userId, id, ref);
  }
}
