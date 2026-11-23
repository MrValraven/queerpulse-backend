import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { LinkPreviewFeatureGuard } from './link-preview-feature.guard';
import {
  LINK_PREVIEW_IMAGE_CACHE_CONTROL,
  LINK_PREVIEW_IMAGE_ROUTE,
} from './link-preview.constants';
import { verifyLinkPreviewImageToken } from './link-preview-image-token';
import { LinkPreviewImageService } from './link-preview-image.service';

/** The token does not verify: it was edited, or never minted here. */
export const LINK_PREVIEW_IMAGE_TOKEN_INVALID_CODE =
  'link_preview_image_token_invalid';

/** The image host did not answer with a relayable image (unreachable, a
 *  refused address or port, a type outside the list, over the byte cap, or
 *  bytes that do not match their declared type). */
export const LINK_PREVIEW_IMAGE_UNAVAILABLE_CODE =
  'link_preview_image_unavailable';

/**
 * SEC-23: `GET /link-preview-images/<token>` serves the image of a link
 * preview card, fetched by the server so the reader's browser never contacts
 * the host the sender chose.
 *
 * The token is the only input, and tokens come only from the unfurler
 * (`link-preview-image-token.ts`), which signs the image URL a fetched page
 * named. Whoever controls that page picks the URL, so the fetch is bounded by
 * the SSRF-safe fetcher (`safeFetchImage`: public addresses only, ports 80 and
 * 443, image types, a byte cap and a timeout), and the bytes are checked
 * against their declared image type before they are sent.
 *
 * Behind the same feature gate and active-member check as the unfurl, because
 * the cards it completes are only shown to signed-in members. The global
 * IP-keyed throttler meters it like every other image route.
 *
 * Headers: the verified image type, `nosniff`, a `sandbox` CSP so the address
 * opened on its own renders nothing active, and private caching (the address
 * names one image URL for good). Cross-origin embedding follows the app-wide
 * `same-site` resource policy `main.ts` sets for `/files/*`.
 */
@ApiTags('Link Previews')
@ApiCookieAuth()
@Controller({ path: LINK_PREVIEW_IMAGE_ROUTE, version: VERSION_NEUTRAL })
@UseGuards(LinkPreviewFeatureGuard, ActiveMemberGuard)
export class LinkPreviewImageController {
  constructor(private readonly linkPreviewImages: LinkPreviewImageService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Serve a link preview image through the server' })
  @ApiResponse({ status: 200, description: 'The image bytes.' })
  @ApiUnauthorizedResponse({ description: 'No valid session.' })
  @ApiNotFoundResponse({
    description:
      'The token does not verify, or the image could not be fetched as an image.',
  })
  async image(
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const imageUrl = verifyLinkPreviewImageToken(token);
    if (!imageUrl) {
      throw new NotFoundException({
        message: 'This preview image address is not valid',
        code: LINK_PREVIEW_IMAGE_TOKEN_INVALID_CODE,
      });
    }
    const image = await this.linkPreviewImages.load(imageUrl);
    if (!image) {
      throw new NotFoundException({
        message: 'The linked page did not serve a usable preview image',
        code: LINK_PREVIEW_IMAGE_UNAVAILABLE_CODE,
      });
    }
    response.setHeader('Content-Type', image.contentType);
    response.setHeader('Content-Length', String(image.body.byteLength));
    response.setHeader('Content-Disposition', 'inline');
    response.setHeader('Cache-Control', LINK_PREVIEW_IMAGE_CACHE_CONTROL);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    response.status(200).end(image.body);
  }
}
