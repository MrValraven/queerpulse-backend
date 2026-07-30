import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ResolveLinkDto } from './dto/resolve-link.dto';
import { GeocodeService } from './geocode.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

@ApiTags('Geocoding')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('geocode')
@UseGuards(ActiveMemberGuard)
export class GeocodeController {
  constructor(private readonly geocodeService: GeocodeService) {}

  // Tighter than the global throttle: this makes a server-side outbound fetch
  // to resolve the link, so it's a cost/SSRF-amplification surface worth capping.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('resolve-link')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a Google Maps link to coordinates' })
  @ApiOkResponse({ description: 'The resolved latitude/longitude.' })
  @ApiBadRequestResponse({
    description: 'The URL is not a supported Google Maps link.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'The link could not be resolved to coordinates.',
  })
  @ApiServiceUnavailableResponse({
    description: 'The upstream geocoding fetch failed.',
  })
  resolveLink(@Body() dto: ResolveLinkDto) {
    return this.geocodeService.resolveLink(dto.url);
  }
}
