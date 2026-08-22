import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { GeocodeAddressDto } from './dto/geocode-address.dto';
import { ResolveLinkDto } from './dto/resolve-link.dto';
import { GeocodeService } from './geocode.service';
import { RetryAfterInterceptor } from './retry-after.interceptor';
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
// Adds `Retry-After` to the 503 the process-wide Nominatim queue raises.
@UseInterceptors(RetryAfterInterceptor)
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

  // Free-text street address → coordinates (item #1). Same tighter throttle as
  // `resolve-link`: it makes a server-side outbound geocoder fetch, the same
  // cost/SSRF-amplification surface worth capping.
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post('address')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a typed street address to coordinates' })
  @ApiOkResponse({ description: 'The resolved latitude/longitude.' })
  @ApiUnprocessableEntityResponse({
    description: 'The address could not be resolved to coordinates.',
  })
  @ApiServiceUnavailableResponse({
    description: 'The upstream geocoding fetch failed.',
  })
  resolveAddress(@Body() dto: GeocodeAddressDto) {
    return this.geocodeService.resolveAddress(dto.address);
  }
}
