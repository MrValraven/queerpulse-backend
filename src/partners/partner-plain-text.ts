import { toStoredPlainText } from '../communities/community-plain-text';
import type {
  PartnerAtGlance,
  PartnerContact,
  PartnerJointWork,
  PartnerSection,
  PartnerStat,
  PartnerTimelineItem,
} from './entities/partner.entity';

/**
 * Write-boundary plain-text normalisation for everything an organisation (or a
 * staff member on its behalf) types into a partner profile (PRD-263).
 *
 * Every string here is rendered verbatim on `/about/partners` and
 * `/about/partners/:slug`, both of which are `@Public()` and answer a
 * logged-out visitor, and none of them is rich text. So the rule this repo
 * already follows applies unchanged: strip markup ONCE, where the value is
 * persisted, rather than at each of the dozen render sites — see
 * `communities/community-plain-text.ts`, which owns the actual stripping, and
 * `housing-listings.service.ts` for the same pattern on the same kind of
 * member-authored listing text.
 *
 * Applied on BOTH write paths (submit and edit) so a profile cannot be
 * laundered through the one that was missed.
 *
 * NOT sanitised here: `contact.email` and `contact.website`, which are already
 * constrained to their own grammars by `@IsEmail()` / `@IsSafeExternalUrl()`,
 * and would only be damaged by an HTML strip.
 */
function storedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const stored = toStoredPlainText(value);
  return stored.length ? stored : null;
}

export function toStoredPartnerContact(
  contact: PartnerContact,
): PartnerContact {
  return {
    phone: storedOrNull(contact.phone),
    phoneNote: storedOrNull(contact.phoneNote),
    email: contact.email,
    website: contact.website,
    address: storedOrNull(contact.address),
  };
}

export function toStoredStats(stats: PartnerStat[]): PartnerStat[] {
  return stats.map((stat) => ({
    value: toStoredPlainText(stat.value),
    label: toStoredPlainText(stat.label),
  }));
}

export function toStoredSections(sections: PartnerSection[]): PartnerSection[] {
  return sections.map((section) => ({
    heading: toStoredPlainText(section.heading),
    body: toStoredPlainText(section.body),
  }));
}

export function toStoredJointWork(
  entries: PartnerJointWork[],
): PartnerJointWork[] {
  return entries.map((entry) => ({
    kicker: toStoredPlainText(entry.kicker),
    title: toStoredPlainText(entry.title),
    dek: toStoredPlainText(entry.dek),
    footLeft: toStoredPlainText(entry.footLeft),
    footRight: toStoredPlainText(entry.footRight),
  }));
}

export function toStoredTimeline(
  entries: PartnerTimelineItem[],
): PartnerTimelineItem[] {
  return entries.map((entry) => ({
    date: toStoredPlainText(entry.date),
    title: toStoredPlainText(entry.title),
    body: toStoredPlainText(entry.body),
  }));
}

export function toStoredAtGlance(
  entries: PartnerAtGlance[],
): PartnerAtGlance[] {
  return entries.map((entry) => ({
    label: toStoredPlainText(entry.label),
    value: toStoredPlainText(entry.value),
  }));
}

export function toStoredLines(lines: string[]): string[] {
  return lines.map((line) => toStoredPlainText(line));
}
