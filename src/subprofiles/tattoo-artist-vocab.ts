// Tattoo artist persona vocabulary. The shared block below is mirrored by
// `queerpulse/src/features/subprofiles/skins/tattoo/tattooVocab.data.ts`:
// same names, same order, same values. This file imports nothing.

// The seven new SubprofileSection values (enum migration).
export const TATTOO_NEW_SECTIONS = [
  'cover_ups',
  'scar_work',
  'in_progress',
  'wanna_dos',
  'guest_spots',
  'flash_days',
  'shop',
] as const;

// KIND_SECTIONS.tattoo_artist, in this order ('gallery' is appended by
// sectionsForKind as for every kind).
export const TATTOO_KIND_SECTIONS = [
  'flash',
  'healed',
  'wanna_dos',
  'in_progress',
  'cover_ups',
  'scar_work',
  'aftercare',
  'credentials',
  'guest_spots',
  'flash_days',
  'shop',
] as const;

// Sections whose items carry tattoo `structured` keys.
export const TATTOO_ITEM_SECTIONS = [
  'flash',
  'healed',
  'wanna_dos',
  'in_progress',
  'cover_ups',
  'scar_work',
  'guest_spots',
  'flash_days',
  'shop',
] as const;

// Body-photo sections: consent rule, blur flags, no collaborators, no feed import.
export const TATTOO_BODY_PHOTO_SECTIONS = [
  'healed',
  'in_progress',
  'cover_ups',
  'scar_work',
] as const;

export const TATTOO_BOOKS_STATUSES = ['open', 'waitlist', 'closed'] as const;
export type TattooBooksStatus = (typeof TATTOO_BOOKS_STATUSES)[number];

export const TATTOO_BOOKING_ROUTES = [
  'message',
  'email',
  'form_link',
  'instagram',
] as const;
export type TattooBookingRoute = (typeof TATTOO_BOOKING_ROUTES)[number];

export const TATTOO_WHAT_TO_SEND = [
  'idea',
  'placement',
  'size',
  'references',
  'budget',
  'dates',
] as const;
export type TattooWhatToSend = (typeof TATTOO_WHAT_TO_SEND)[number];

export const TATTOO_CONSULTATIONS = [
  'in_person',
  'video',
  'both',
  'none',
] as const;
export type TattooConsultation = (typeof TATTOO_CONSULTATIONS)[number];

export const TATTOO_COLOURS = ['colour', 'black_grey', 'both'] as const;
export type TattooColour = (typeof TATTOO_COLOURS)[number];

export const TATTOO_STYLES = [
  'fine_line',
  'blackwork',
  'neo_traditional',
  'american_traditional',
  'japanese',
  'realism',
  'dotwork',
  'ornamental',
  'geometric',
  'lettering',
  'illustrative',
  'watercolour',
  'handpoke',
  'stick_and_poke',
] as const;
export type TattooStyle = (typeof TATTOO_STYLES)[number];

export const TATTOO_COMFORT_OPTIONS = [
  'chosen_name_pronouns',
  'private_room',
  'breaks_any_time',
  'numbing_cream_welcome',
  'bring_someone',
  'trauma_informed',
  'sensory_friendly',
  'body_neutral_size_inclusive',
  'step_free_access',
  'gender_neutral_toilet',
] as const;
export type TattooComfortOption = (typeof TATTOO_COMFORT_OPTIONS)[number];

export const TATTOO_HYGIENE_PRACTICES = [
  'single_use_needles',
  'licensed_studio',
  'autoclave_sterilisation',
  'vegan_inks',
  'bloodborne_pathogens_training',
] as const;
export type TattooHygienePractice = (typeof TATTOO_HYGIENE_PRACTICES)[number];

export const TATTOO_SCAR_WORK_TYPES = [
  'top_surgery',
  'areola',
  'self_harm',
  'stretch_marks',
  'other',
] as const;
export type TattooScarWorkType = (typeof TATTOO_SCAR_WORK_TYPES)[number];

export const TATTOO_FLASH_AVAILABILITIES = [
  'available',
  'claimed',
  'repeatable',
] as const;
export type TattooFlashAvailability =
  (typeof TATTOO_FLASH_AVAILABILITIES)[number];

export const TATTOO_SKIN_TONES = ['light', 'medium', 'deep'] as const;
export type TattooSkinTone = (typeof TATTOO_SKIN_TONES)[number];

export const TATTOO_COVER_UP_TYPES = ['cover_up', 'rework'] as const;
export type TattooCoverUpType = (typeof TATTOO_COVER_UP_TYPES)[number];

export const TATTOO_GUEST_SPOT_TYPES = ['guest_spot', 'convention'] as const;
export type TattooGuestSpotType = (typeof TATTOO_GUEST_SPOT_TYPES)[number];

export const TATTOO_SHOP_PRODUCT_TYPES = [
  'print',
  'flash_sheet',
  'sticker',
  'merch',
  'other',
] as const;
export type TattooShopProductType = (typeof TATTOO_SHOP_PRODUCT_TYPES)[number];

export const TATTOO_LIMITS = {
  // items (structured)
  sessionsMax: 12,
  sessionNoteMax: 280,
  placementsMax: 8,
  placementMax: 40,
  sizeMax: 40,
  healedForMax: 40,
  healedPlacementMax: 80,
  causeMax: 120,
  // skinData
  waitNoteMax: 200,
  emailMax: 254,
  formUrlMax: 1000,
  replyTimeMax: 80,
  stylesMax: 20,
  styleCustomMax: 40,
  minSizeMax: 40,
  doesNotDoMax: 12,
  doesNotDoLineMax: 80,
  depositNoteMax: 300,
  cancellationMax: 2000,
  touchUpMonthsMax: 24,
  comfortNoteMax: 1000,
  scarIntroMax: 2000,
  reducedPriceNoteMax: 300,
  cityMax: 80,
  trainedWithMax: 200,
  apprenticeNoteMax: 500,
  teachesMax: 10,
  teachesLineMax: 120,
  tattooingSinceMin: 1900, // max is the current year
  faqMax: 12,
  faqQuestionMax: 200,
  faqAnswerMax: 1000, // FE-enforced, see skinData
} as const;

// Euro amount as a digit string, capped at 6 integer digits. "" means not set.
export const TATTOO_PRICE_PATTERN = /^\d{1,6}(?:[.,]\d{0,2})?$/;
// Calendar date, checked as a real date too.
export const TATTOO_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const TATTOO_STATUS_TO_AVAILABILITY = {
  open: 'open_to_collabs',
  waitlist: 'booking',
  closed: 'not_available',
} as const;
export const AVAILABILITY_TO_TATTOO_STATUS = {
  open_to_collabs: 'open',
  booking: 'waitlist',
  not_available: 'closed',
} as const;

// Backend-only helpers.
export const isTattooItemSection = (section: string): boolean =>
  (TATTOO_ITEM_SECTIONS as readonly string[]).includes(section);

export const isTattooBodyPhotoSection = (section: string): boolean =>
  (TATTOO_BODY_PHOTO_SECTIONS as readonly string[]).includes(section);

/** True for a `YYYY-MM-DD` string that names a real calendar day. */
export const isCalendarDate = (value: string): boolean => {
  if (!TATTOO_ISO_DATE_PATTERN.test(value)) return false;
  const parts = value.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};
