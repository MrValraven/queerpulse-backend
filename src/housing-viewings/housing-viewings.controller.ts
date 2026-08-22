import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { RequestHousingViewingDto } from './dto/request-housing-viewing.dto';
import {
  AcceptHousingViewingDto,
  DeclineHousingViewingDto,
  ProposeHousingViewingDto,
} from './dto/respond-housing-viewing.dto';
import { HousingViewingsService } from './housing-viewings.service';

/**
 * Viewing scheduling for member housing listings. All routes are active-member
 * gated; every transition additionally checks the caller is a participant and
 * the viewing is in the right state (in the service).
 *
 * Every `:id` runs through `ParseUUIDPipe` (BE-HSG-10). Without it a non-UUID
 * segment reached `findOne({ where: { id } })`, Postgres rejected the
 * comparison against a `uuid` column with SQLSTATE 22P02, and TypeORM's
 * `QueryFailedError` (not an `HttpException`) fell through
 * `AllExceptionsFilter` as a 500 logged as a server error. Now it is a 400,
 * matching `HousingSavedSearchesController.remove`'s existing precedent.
 */
@Feature('housingListings')
@ApiTags('Housing viewings')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
@Controller('housing-viewings')
@UseGuards(ActiveMemberGuard)
export class HousingViewingsController {
  constructor(private readonly service: HousingViewingsService) {}

  @Post()
  @ApiOperation({ summary: 'Request a viewing on a live listing' })
  @ApiCreatedResponse({ description: 'The created viewing request.' })
  request(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: RequestHousingViewingDto,
  ) {
    return this.service.request(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({
    summary: "The caller's viewings, as requester and as lister",
  })
  @ApiOkResponse({ description: 'Every viewing the caller is part of.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.service.listMine(user.userId);
  }

  @Post(':id/accept')
  @ApiOperation({ summary: 'Accept one of the proposed times' })
  @ApiOkResponse({ description: 'The accepted viewing.' })
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptHousingViewingDto,
  ) {
    return this.service.accept(id, user.userId, dto);
  }

  @Post(':id/propose')
  @ApiOperation({ summary: 'Propose alternative times' })
  @ApiOkResponse({ description: 'The viewing with the new proposed times.' })
  propose(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProposeHousingViewingDto,
  ) {
    return this.service.propose(id, user.userId, dto);
  }

  @Post(':id/decline')
  @ApiOperation({ summary: 'Decline the viewing request' })
  @ApiOkResponse({ description: 'The declined viewing.' })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineHousingViewingDto,
  ) {
    return this.service.decline(id, user.userId, dto);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a pending viewing' })
  @ApiOkResponse({ description: 'The cancelled viewing.' })
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(id, user.userId);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Mark an accepted viewing as completed' })
  @ApiOkResponse({ description: 'The completed viewing.' })
  complete(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.complete(id, user.userId);
  }
}
