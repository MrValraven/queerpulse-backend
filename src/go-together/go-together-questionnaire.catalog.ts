import { NEIGHBOURHOODS } from '../profiles/neighbourhoods';

/**
 * The Go together questionnaire, server side. Every id here is a stable wire
 * value: the frontend renders labels from `goTogether:questionnaire.*` i18n
 * keys named after these ids, and stored answers reference them. Renaming an
 * id orphans every stored answer that used it, so add new ids and retire old
 * ones through `QUESTIONNAIRE_VERSION` instead.
 */
export const QUESTIONNAIRE_VERSION = 1;

/** The oldest answer version the matcher still accepts without a refresh. */
export const MIN_ACCEPTED_QUESTIONNAIRE_VERSION = 1;

export const VALUE_ITEM_IDS = [
  'community',
  'creativity',
  'family',
  'fun',
  'career',
  'spirituality',
] as const;
export type ValueItemId = (typeof VALUE_ITEM_IDS)[number];

/** Each option names a humour style; the i18n catalog holds one short example
 *  line per style and pair, so the member picks the line they find funnier. */
export const HUMOUR_PAIRS = [
  { id: 'h1', a: 'absurd', b: 'dry' },
  { id: 'h2', a: 'camp', b: 'wordplay' },
  { id: 'h3', a: 'dark', b: 'wholesome' },
  { id: 'h4', a: 'selfDeprecating', b: 'observational' },
  { id: 'h5', a: 'absurd', b: 'camp' },
  { id: 'h6', a: 'dry', b: 'dark' },
  { id: 'h7', a: 'wordplay', b: 'observational' },
  { id: 'h8', a: 'wholesome', b: 'selfDeprecating' },
] as const;
export type HumourPairId = (typeof HUMOUR_PAIRS)[number]['id'];
export type HumourPick = 'a' | 'b';

/** The pairs shown in the current version. The rest of the bank waits for a
 *  version bump so a refresh can rotate them in. */
export const ACTIVE_HUMOUR_PAIR_IDS: readonly HumourPairId[] = [
  'h1',
  'h2',
  'h3',
  'h4',
];

/** Interest tags grouped by gathering family (see `events/gathering-family.ts`). */
export const INTEREST_TAGS_BY_FAMILY = {
  meet: [
    'coffeeChats',
    'boardGames',
    'quizNights',
    'languageExchange',
    'bookClubs',
    'walksAndTalks',
    'brunch',
  ],
  eat: [
    'cooking',
    'supperClubs',
    'plantBased',
    'baking',
    'streetFood',
    'cafes',
    'wineAndVinho',
  ],
  party: [
    'dragShows',
    'karaoke',
    'clubNights',
    'queerBars',
    'festivals',
    'ballroom',
    'liveGigs',
  ],
  make: [
    'crafts',
    'zines',
    'photography',
    'drawing',
    'knitting',
    'pottery',
    'writing',
  ],
  learn: [
    'queerHistory',
    'museums',
    'workshops',
    'science',
    'philosophy',
    'tech',
  ],
  watch: [
    'cinema',
    'theatre',
    'standUp',
    'tvSeries',
    'anime',
    'dancePerformance',
  ],
  move: [
    'hiking',
    'running',
    'yoga',
    'swimming',
    'cycling',
    'climbing',
    'beach',
    'teamSports',
  ],
  care: ['meditation', 'wellbeingCircles', 'plants', 'pets', 'tarot'],
  organise: [
    'activism',
    'volunteering',
    'prideOrganising',
    'mutualAid',
    'politics',
  ],
} as const;
export type InterestTagId =
  (typeof INTEREST_TAGS_BY_FAMILY)[keyof typeof INTEREST_TAGS_BY_FAMILY][number];
export const INTEREST_TAG_IDS: readonly InterestTagId[] = Object.values(
  INTEREST_TAGS_BY_FAMILY,
).flat();
export const MAX_INTEREST_TAGS = 8;

export const MUSIC_TAG_IDS = [
  'pop',
  'indie',
  'rock',
  'electronic',
  'techno',
  'house',
  'hipHop',
  'rnb',
  'jazz',
  'classical',
  'fado',
  'brazilian',
  'afrobeats',
  'latin',
  'metal',
  'punk',
  'folk',
  'soul',
  'disco',
  'kpop',
  'hyperpop',
  'ambient',
  'musicals',
  'country',
  'funk',
] as const;
export type MusicTagId = (typeof MUSIC_TAG_IDS)[number];
export const MAX_MUSIC_TAGS = 5;

/** 1 = listener, calm chat, spontaneous. 5 = talker, dancing till late, planner. */
export const ENERGY_ITEM_IDS = ['talker', 'nightShape', 'planner'] as const;
export type EnergyItemId = (typeof ENERGY_ITEM_IDS)[number];

export const INTENTS = ['closeFriends', 'activityBuddies', 'both'] as const;
export type Intent = (typeof INTENTS)[number];

export const MEET_FREQUENCIES = [
  'monthly',
  'fewTimesAMonth',
  'weekly',
] as const;
export type MeetFrequency = (typeof MEET_FREQUENCIES)[number];

/** Mirrors the profile languages (`profiles.languages`). */
export const CHAT_LANGUAGES = ['pt', 'en', 'es', 'fr', 'de'] as const;
export type ChatLanguage = (typeof CHAT_LANGUAGES)[number];

export const DRINKING_OPTIONS = [
  'soberGroup',
  'eitherWay',
  'willDrink',
] as const;
export type DrinkingOption = (typeof DRINKING_OPTIONS)[number];

export const AGE_BRACKETS = [
  '18-24',
  '25-34',
  '35-44',
  '45-54',
  '55+',
] as const;
export type AgeBracket = (typeof AGE_BRACKETS)[number];

export const AGE_PREFERENCES = ['similar', 'any'] as const;
export type AgePreference = (typeof AGE_PREFERENCES)[number];

/** Lisbon neighbourhoods reuse the profile vocabulary; the three wide areas
 *  cover everyone else. `elsewhere` never counts as a shared area. */
export const WIDE_AREAS = ['lisbonMetro', 'porto', 'elsewhere'] as const;
export type AreaId =
  (typeof NEIGHBOURHOODS)[number] | (typeof WIDE_AREAS)[number];
export const AREA_IDS: readonly AreaId[] = [...NEIGHBOURHOODS, ...WIDE_AREAS];

export const LENSES = ['transNonBinary', 'womenFemmes', 'queerPoc'] as const;
export type Lens = (typeof LENSES)[number];

/** A 1 to 5 answer. */
export type Scale5 = 1 | 2 | 3 | 4 | 5;

export interface FriendMatchAnswers {
  values: Record<ValueItemId, Scale5>;
  humour: Partial<Record<HumourPairId, HumourPick>>;
  interests: InterestTagId[];
  music: MusicTagId[];
  energy: Record<EnergyItemId, Scale5>;
  intent: Intent;
  meetFrequency: MeetFrequency;
  languages: ChatLanguage[];
  drinking: DrinkingOption;
  ageBracket: AgeBracket;
  agePreference: AgePreference;
  area: AreaId | null;
}

/** Host questions: at most 2 per gathering, 2 to 4 options each. */
export const MAX_HOST_QUESTIONS = 2;
export const MIN_HOST_OPTIONS = 2;
export const MAX_HOST_OPTIONS = 4;
export const MAX_HOST_PROMPT_LENGTH = 80;
export const MAX_HOST_OPTION_LENGTH = 40;
export const MAX_MEETING_POINT_LENGTH = 200;

export interface HostQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
}

/** questionId -> optionId */
export type HostAnswers = Record<string, string>;
