import {
  Body,
  Controller,
  Delete,
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
  ApiCreatedResponse,
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
import { Feature } from '../common/feature.decorator';
import { CreateHousingSavedSearchDto } from './dto/create-housing-saved-search.dto';
import { HousingSavedSearchesService } from './housing-saved-searches.service';

/**
 * A member's saved housing searches — create, list, delete their own. Alerts on
 * a saved search are delivered through the existing notifications/push system by
 * the go-live listener; there is no endpoint for that here.
 */
@Feature('housingListings')
@ApiTags('Housing saved searches')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
@Controller('housing-saved-searches')
@UseGuards(ActiveMemberGuard)
export class HousingSavedSearchesController {
  constructor(private readonly service: HousingSavedSearchesService) {}

  @Post()
  @ApiOperation({ summary: 'Save a housing search for the current member' })
  @ApiCreatedResponse({ description: 'The saved search.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateHousingSavedSearchDto,
  ) {
    return this.service.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the current member's saved searches" })
  @ApiOkResponse({ description: "The member's saved searches, newest first." })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.service.listMine(user.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete one of the current member's saved searches",
  })
  @ApiNoContentResponse({ description: 'The saved search was deleted.' })
  @ApiNotFoundResponse({ description: 'No saved search with that id.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(id, user.userId);
  }
}
