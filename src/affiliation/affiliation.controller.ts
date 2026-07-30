import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { AffiliationService } from './affiliation.service';
import { SetAffiliationDto } from './dto/set-affiliation.dto';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * The caller's own employer affiliation (plan Task 2.4; spec §3 Tier 2
 * "affiliation"). FE: `features/economy/api/affiliation.api.ts`. At most one
 * per member — the resource is always "mine", so no `:id`/`:slug` in the path.
 */
@ApiTags('Affiliations')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/affiliation')
@UseGuards(ActiveMemberGuard)
export class AffiliationController {
  constructor(private readonly affiliationService: AffiliationService) {}

  /** `GET /me/affiliation` — the caller's affiliation, or `null`. */
  @ApiOperation({ summary: "Get the caller's employer affiliation, or null." })
  @ApiOkResponse({ description: 'The affiliation, or null if none.' })
  @ApiNotFoundResponse({
    description: "The affiliated company no longer exists.",
  })
  @Get()
  get(@CurrentUser() user: CurrentUserData) {
    return this.affiliationService.myAffiliation(user.userId);
  }

  /** `POST /me/affiliation` — set/claim (or replace) the caller's affiliation. */
  @ApiOperation({ summary: "Set or replace the caller's employer affiliation." })
  @ApiCreatedResponse({ description: 'The saved affiliation.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'Company not found.' })
  @Post()
  set(@CurrentUser() user: CurrentUserData, @Body() dto: SetAffiliationDto) {
    return this.affiliationService.setAffiliation(user.userId, dto);
  }

  /** `DELETE /me/affiliation` — drop the caller's affiliation. */
  @ApiOperation({ summary: "Drop the caller's employer affiliation." })
  @ApiNoContentResponse({ description: 'Affiliation removed.' })
  @ApiNotFoundResponse({ description: 'Affiliation not found.' })
  @Delete()
  @HttpCode(204)
  remove(@CurrentUser() user: CurrentUserData) {
    return this.affiliationService.removeAffiliation(user.userId);
  }
}
