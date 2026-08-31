import {
  COMMUNITY_TAGS,
  type CommunityTag,
} from '../communities/community-tags';

/**
 * What the Interests pane's three "do not show me this" switches actually
 * exclude from the feed (PRD-10).
 *
 * ---------------------------------------------------------------------------
 * The defect this closes
 * ---------------------------------------------------------------------------
 * The three switches shipped as placeholders: `defaultChecked`, disabled,
 * badged coming-soon, with no stored field and no filter anywhere. For this
 * audience "do not show me mental-health content" is a real need rather than a
 * nice-to-have, so the choice is now stored on `member_preferences` and read
 * here, on the feed's candidate queries.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLASSIFICATION LIVES IN A `Record` OVER `CommunityTag`
 * ---------------------------------------------------------------------------
 * A hand-curated list sitting beside a taxonomy it mirrors is invisible drift:
 * somebody adds a tag to the taxonomy, nobody remembers this file, and a
 * filter a member is relying on silently stops covering the thing they asked
 * to be spared. That has already cost this platform once.
 *
 * So this is not a list of tags. It is an EXHAUSTIVE map keyed by
 * `CommunityTag` itself, which means the compiler owns the relationship:
 *
 *   - add a tag to `COMMUNITY_TAGS` and this file stops compiling until
 *     somebody decides which sensitivity it carries, or explicitly decides it
 *     carries none;
 *   - remove or rename a tag and this file stops compiling too, instead of
 *     quietly keeping a predicate that can never match again.
 *
 * `null` is a real answer here, and it is the most common one. It means "this
 * tag is not one of these three themes", which is a decision on the record
 * rather than an omission.
 *
 * ---------------------------------------------------------------------------
 * WHAT A MEMBER IS ACTUALLY ASKING FOR
 * ---------------------------------------------------------------------------
 * Two different needs, both real, and the filter has to serve them together:
 *
 *   1. "This subject is hard for me right now." Somebody in a bad stretch
 *      turning mental-health content down, so the home screen stops handing
 *      them other people's crises.
 *   2. "My feed has to be safe to have on screen." Somebody whose laptop is
 *      visible at work, or whose phone gets picked up at home, wanting a home
 *      screen that does not announce their sexuality or gender to whoever
 *      glances at it. The pane's own helper copy is what makes this workable:
 *      turning a filter off never touches community access, so their rooms,
 *      their messages and every direct link keep working exactly as before.
 *      Only the feed goes quiet.
 *
 * The second need is why `sexuality_identity` covers the identity rooms
 * themselves rather than only the coming-out material. A card headed "Trans &
 * Non-Binary Network" is the exact thing that member is asking not to have on
 * their screen, and a filter that leaves it there while calling itself
 * "sexuality and identity" has not done the job.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY LEFT UNCLASSIFIED
 * ---------------------------------------------------------------------------
 *   - `bipoc-led`, `disability-chronic-illness`, `neurodivergent`,
 *     `deaf-hard-of-hearing`, `elders-50-plus`, `youth-18-24`: identity, and
 *     none of it sexuality or gender. Members must not be able to use a
 *     content-sensitivity switch to filter disabled or racialised members out
 *     of their feed, so these three switches cannot reach them.
 *   - `hiv-wellness` and `trans-health-medical`: healthcare people actively
 *     need. Sorting HIV wellness under a mental-health switch would be
 *     stigmatising, and a content filter should never be the reason somebody
 *     misses trans healthcare information.
 *   - `sex-worker-allies`: solidarity and labour organising. Filing it under
 *     dating would be a judgement about sex workers rather than a description
 *     of the content.
 *   - `sober-substance-free`: a format for events, so it stays out of the
 *     mental-health filter; `twelve-step-recovery`, which is recovery content
 *     rather than a venue rule, is in it.
 */
export enum ContentSensitivity {
  Dating = 'dating',
  MentalHealth = 'mental_health',
  SexualityIdentity = 'sexuality_identity',
}

/**
 * Every tag in the community taxonomy, classified. Exhaustive by type: see the
 * module docstring for why that is the whole point of this shape.
 *
 * Ordered exactly as `COMMUNITY_TAGS` orders them, including its section
 * comments, so the two files can be read side by side and a reviewer can see
 * at a glance that nothing was skipped.
 */
export const COMMUNITY_TAG_SENSITIVITY: Record<
  CommunityTag,
  ContentSensitivity | null
> = {
  // Identity & community focus
  'trans-nonbinary': ContentSensitivity.SexualityIdentity,
  'sapphic-wlw': ContentSensitivity.SexualityIdentity,
  'gay-men': ContentSensitivity.SexualityIdentity,
  'bisexual-pan': ContentSensitivity.SexualityIdentity,
  'asexual-aromantic': ContentSensitivity.SexualityIdentity,
  'two-spirit': ContentSensitivity.SexualityIdentity,
  intersex: ContentSensitivity.SexualityIdentity,
  'bipoc-led': null,
  'disability-chronic-illness': null,
  neurodivergent: null,
  'deaf-hard-of-hearing': null,
  'elders-50-plus': null,
  'youth-18-24': null,
  'parents-family': null,
  'polyamory-enm': ContentSensitivity.Dating,
  'leather-kink': ContentSensitivity.Dating,
  'bear-cub': ContentSensitivity.SexualityIdentity,
  'drag-performance': null,

  // Format & vibe
  'beginner-friendly': null,
  'in-person-meetups': null,
  'virtual-online': null,
  'local-city-based': null,
  'peer-support': ContentSensitivity.MentalHealth,
  'discussion-group': null,
  'book-club': null,
  'study-group': null,
  'game-night': null,
  'sober-substance-free': null,
  'twelve-step-recovery': ContentSensitivity.MentalHealth,
  'creative-collective': null,
  mentorship: null,

  // Focus & interests
  'mental-health': ContentSensitivity.MentalHealth,
  'coming-out-support': ContentSensitivity.SexualityIdentity,
  'health-wellness': ContentSensitivity.MentalHealth,
  'career-networking': null,
  'housing-roommates': null,
  'legal-immigration': null,
  'faith-spirituality': null,
  'sports-fitness': null,
  'outdoors-hiking': null,
  music: null,
  'film-tv': null,
  'tech-gaming': null,
  'fashion-style': null,
  'food-cooking': null,
  'arts-crafts': null,
  'activism-mutual-aid': null,
  'politics-advocacy': null,
  'nightlife-events': null,

  // Health & identity
  'hiv-wellness': null,
  'trans-health-medical': null,
  'sex-worker-allies': null,
  'accessibility-first': null,
};

/** The three switches, as the feed reads them off a preferences row. Narrow
 *  on purpose so this module stays pure and testable: `MemberPreferences`
 *  satisfies it structurally without this file importing the entity. */
export interface ContentSensitivityChoices {
  hideDatingContent: boolean;
  hideMentalHealthContent: boolean;
  hideSexualityIdentityContent: boolean;
}

/**
 * The tag sets a feed query excludes on.
 *
 * Two sets because the feed matches two different tag spaces, and conflating
 * them would either over-filter or miss half the content:
 *
 *  - `communityTags`: values from the CURATED `COMMUNITY_TAGS` vocabulary,
 *    matched against `communities.tags`. This is the set the classification
 *    above is literally about.
 *  - `itemTags`: the same ids PLUS their hyphen-free spellings, matched
 *    against `forum_thread.tags`, which is freeform text a member typed. A
 *    thread tagged `#mentalhealth` and a community tagged `mental-health` mean
 *    the same thing to the person who asked not to see either. The aliases are
 *    DERIVED from the classified ids rather than listed, so they cannot drift
 *    away from them, and they are what makes the filter reach the `topics`
 *    directory's own slugs (`mentalhealth`) as a side effect.
 */
export interface ExcludedContentTags {
  communityTags: string[];
  itemTags: string[];
}

/** Nothing filtered: what every member gets until they touch a switch. */
export const NO_EXCLUDED_CONTENT_TAGS: ExcludedContentTags = {
  communityTags: [],
  itemTags: [],
};

/** Every tag classified into one of the given sensitivities, in taxonomy
 *  order. Derived from the map, so there is no second list to maintain. */
export function communityTagsFor(
  sensitivities: readonly ContentSensitivity[],
): string[] {
  if (!sensitivities.length) return [];
  const wanted = new Set(sensitivities);
  return COMMUNITY_TAGS.filter((tag) => {
    const sensitivity = COMMUNITY_TAG_SENSITIVITY[tag];
    return sensitivity !== null && wanted.has(sensitivity);
  });
}

/**
 * The freeform-tag spellings a member who opted out of these sensitivities
 * should not be shown: the classified ids, plus each id with its hyphens
 * removed. Deduped, so `music`-shaped single-word ids appear once.
 */
export function itemTagsFor(
  sensitivities: readonly ContentSensitivity[],
): string[] {
  const tags = communityTagsFor(sensitivities);
  return [...new Set(tags.flatMap((tag) => [tag, tag.replace(/-/g, '')]))];
}

/** Which of the three the member has switched off. */
export function optedOutSensitivities(
  choices: ContentSensitivityChoices,
): ContentSensitivity[] {
  const opted: ContentSensitivity[] = [];
  if (choices.hideDatingContent) opted.push(ContentSensitivity.Dating);
  if (choices.hideMentalHealthContent) {
    opted.push(ContentSensitivity.MentalHealth);
  }
  if (choices.hideSexualityIdentityContent) {
    opted.push(ContentSensitivity.SexualityIdentity);
  }
  return opted;
}

/**
 * The one call the feed makes: a member's stored choices in, the tag sets its
 * candidate queries exclude on out.
 *
 * Returns the shared empty value when nothing is switched off, so the common
 * case allocates nothing and every `if (tags.length)` guard in the query
 * builders short-circuits.
 */
export function excludedContentTags(
  choices: ContentSensitivityChoices | null,
): ExcludedContentTags {
  if (!choices) return NO_EXCLUDED_CONTENT_TAGS;
  const sensitivities = optedOutSensitivities(choices);
  if (!sensitivities.length) return NO_EXCLUDED_CONTENT_TAGS;
  return {
    communityTags: communityTagsFor(sensitivities),
    itemTags: itemTagsFor(sensitivities),
  };
}
