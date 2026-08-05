import { BadRequestException } from '@nestjs/common';
import { LandingCopy, LandingSection } from './entities/landing-feature.entity';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

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

  // Community — blurb optional.
  return isNonEmptyString(source.blurb) ? { blurb: source.blurb.trim() } : {};
}
