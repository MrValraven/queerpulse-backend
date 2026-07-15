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

/**
 * The caller's own employer affiliation (plan Task 2.4; spec §3 Tier 2
 * "affiliation"). FE: `features/economy/api/affiliation.api.ts`. At most one
 * per member — the resource is always "mine", so no `:id`/`:slug` in the path.
 */
@Controller('me/affiliation')
@UseGuards(ActiveMemberGuard)
export class AffiliationController {
  constructor(private readonly affiliationService: AffiliationService) {}

  /** `GET /me/affiliation` — the caller's affiliation, or `null`. */
  @Get()
  get(@CurrentUser() user: CurrentUserData) {
    return this.affiliationService.myAffiliation(user.userId);
  }

  /** `POST /me/affiliation` — set/claim (or replace) the caller's affiliation. */
  @Post()
  set(@CurrentUser() user: CurrentUserData, @Body() dto: SetAffiliationDto) {
    return this.affiliationService.setAffiliation(user.userId, dto);
  }

  /** `DELETE /me/affiliation` — drop the caller's affiliation. */
  @Delete()
  @HttpCode(204)
  remove(@CurrentUser() user: CurrentUserData) {
    return this.affiliationService.removeAffiliation(user.userId);
  }
}
