import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { ReplaceStudioPaymentMethodsDto } from './dto/replace-studio-payment-methods.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPaymentMethodsService } from './studio-payment-methods.service';
import { StudioPaymentMethods } from './studio-purchases-response';

/** An artist persona's ways to get paid (contract 2.2 and 2.3), for its
 *  members. */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPaymentMethodsController {
  constructor(private readonly paymentMethods: StudioPaymentMethodsService) {}

  @Get(':subprofileId/payment-methods')
  @ApiOperation({ summary: "The artist's ways to get paid." })
  @ApiOkResponse({ description: '`StudioPaymentMethods`.' })
  @ApiNotFoundResponse({ description: '`studio_persona_not_found`.' })
  getMethods(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioPaymentMethods> {
    return this.paymentMethods.getMethods(user.userId, subprofileId);
  }

  @Put(':subprofileId/payment-methods')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: "Replaces the artist's ways to get paid, in array order.",
  })
  @ApiOkResponse({ description: '`StudioPaymentMethods`, freshly saved.' })
  @ApiBadRequestResponse({
    description:
      '`studio_payment_methods_limit`, `studio_payment_link_invalid`, `studio_payment_mbway_invalid` or `studio_payment_iban_invalid` (each with `index`).',
  })
  @ApiForbiddenResponse({
    description: '`studio_persona_kind_not_allowed` or `ACCOUNT_RESTRICTED`.',
  })
  @ApiNotFoundResponse({ description: '`studio_persona_not_found`.' })
  @ApiConflictResponse({
    description: '`studio_payment_methods_needed_for_sale`.',
  })
  replaceMethods(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Body() body: ReplaceStudioPaymentMethodsDto,
  ): Promise<StudioPaymentMethods> {
    return this.paymentMethods.replaceMethods(user.userId, subprofileId, body);
  }
}
