import { BadRequestException } from '@nestjs/common';
import { LandingCopy, LandingSection } from './entities/landing-feature.entity';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** Longest kicker line a gathering or story feature may carry. The homepage
 *  renders it in the small uppercase line above the card title, so it has to
 *  stay short enough to read as a label. Mirrored by the admin form's
 *  `LANDING_KICKER_MAX_LENGTH`. */
export const LANDING_KICKER_MAX_LENGTH = 80;

/**
 * Validates and normalizes the admin-authored `copy` payload for a landing
 * feature, per its section's required shape. Unknown keys are stripped.
 * Throws `BadRequestException` when a required field is missing or empty.
 */
export function validateLandingCopy(
  section: LandingSection,
  copy: unknown,
): LandingCopy {
  const source = (copy ?? {}) as Record<string, unknown>;

  if (section === LandingSection.Member) {
    if (!isNonEmptyString(source.quote)) {
      throw new BadRequestException('Member feature requires a quote.');
    }
    return { quote: source.quote.trim() };
  }

  if (section === LandingSection.Changemaker) {
    if (!isNonEmptyString(source.cause) || !isNonEmptyString(source.blurb)) {
      throw new BadRequestException(
        'Changemaker feature requires a cause and a blurb.',
      );
    }
    const tags = Array.isArray(source.tags)
      ? source.tags.filter(isNonEmptyString)
      : undefined;
    return {
      cause: source.cause.trim(),
      blurb: source.blurb.trim(),
      ...(tags && tags.length ? { tags } : {}),
    };
  }

  if (
    section === LandingSection.Gathering ||
    section === LandingSection.Story
  ) {
    if (!isNonEmptyString(source.blurb)) return {};
    const blurb = source.blurb.trim();
    if (blurb.length > LANDING_KICKER_MAX_LENGTH) {
      throw new BadRequestException(
        `The kicker line must be ${LANDING_KICKER_MAX_LENGTH} characters or fewer.`,
      );
    }
    return { blurb };
  }

  // Community — blurb optional.
  return isNonEmptyString(source.blurb) ? { blurb: source.blurb.trim() } : {};
}
