import {
  STUDIO_SUPPORT_PLATFORMS,
  StudioSupportPlatform,
} from './studio.constants';

/** The wire shape, the same as `SocialLinkDTO`. */
export interface StudioSupportLink {
  platform: StudioSupportPlatform;
  urlOrHandle: string;
}

/** The columns of a `subprofile_social_links` row this reads. */
export interface SupportLinkSource {
  platform: string;
  urlOrHandle: string;
  position: number;
}

export function isStudioSupportPlatform(
  platform: string,
): platform is StudioSupportPlatform {
  return (STUDIO_SUPPORT_PLATFORMS as readonly string[]).includes(platform);
}

/** The persona's Bandcamp, Ko-fi and Patreon links, in its own link order.
 *  Outbound only; nothing counts a click. */
export function toStudioSupportLinks(
  links: SupportLinkSource[],
): StudioSupportLink[] {
  return [...links]
    .sort((leftLink, rightLink) => leftLink.position - rightLink.position)
    .flatMap((link) =>
      isStudioSupportPlatform(link.platform)
        ? [{ platform: link.platform, urlOrHandle: link.urlOrHandle }]
        : [],
    );
}
