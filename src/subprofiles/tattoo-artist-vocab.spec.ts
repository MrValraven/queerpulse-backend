import {
  AVAILABILITY_TO_TATTOO_STATUS,
  TATTOO_BODY_PHOTO_SECTIONS,
  TATTOO_BOOKS_STATUSES,
  TATTOO_ITEM_SECTIONS,
  TATTOO_KIND_SECTIONS,
  TATTOO_NEW_SECTIONS,
  TATTOO_STATUS_TO_AVAILABILITY,
  isCalendarDate,
  isTattooBodyPhotoSection,
  isTattooItemSection,
} from './tattoo-artist-vocab';
import {
  clientConsentRequired,
  flashDayEventNotEligible,
  flashDayEventUnlinkedPersona,
  tattooItemInvalid,
  tattooSkinInvalid,
} from './tattoo-artist-errors';
import { KIND_SECTIONS, sectionsForKind } from './subprofile-kinds';
import { SubprofileSection } from './entities/subprofile-item.entity';
import { SubprofileKind } from './entities/subprofile.entity';
import { AVAILABILITY_KEYS } from './subprofile-validation';

describe('tattoo artist vocabulary', () => {
  it('mirrors KIND_SECTIONS.tattoo_artist in order', () => {
    expect(KIND_SECTIONS.tattoo_artist).toEqual([...TATTOO_KIND_SECTIONS]);
    const sections = sectionsForKind(SubprofileKind.TattooArtist);
    expect(sections[sections.length - 1]).toBe('gallery');
  });

  it('adds the seven new values to the section enum', () => {
    const enumValues = Object.values(SubprofileSection) as string[];
    for (const section of TATTOO_NEW_SECTIONS) {
      expect(enumValues).toContain(section);
    }
  });

  it('nests the section lists', () => {
    for (const section of TATTOO_BODY_PHOTO_SECTIONS) {
      expect(TATTOO_ITEM_SECTIONS as readonly string[]).toContain(section);
    }
    for (const section of TATTOO_ITEM_SECTIONS) {
      expect(TATTOO_KIND_SECTIONS as readonly string[]).toContain(section);
    }
    expect(isTattooItemSection('gallery')).toBe(false);
    expect(isTattooItemSection('flash')).toBe(true);
    expect(isTattooBodyPhotoSection('wanna_dos')).toBe(false);
    expect(isTattooBodyPhotoSection('healed')).toBe(true);
  });

  it('maps books status and availability both ways', () => {
    expect(TATTOO_STATUS_TO_AVAILABILITY.waitlist).toBe('booking');
    for (const status of TATTOO_BOOKS_STATUSES) {
      const availability = TATTOO_STATUS_TO_AVAILABILITY[status];
      expect(AVAILABILITY_KEYS as readonly string[]).toContain(availability);
      expect(AVAILABILITY_TO_TATTOO_STATUS[availability]).toBe(status);
    }
  });

  it('reads only real calendar dates', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-2-1')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
  });

  it('builds each error body with its code and fields', () => {
    const itemError = tattooItemInvalid(3, 'structured.sessions.3.imageUrl');
    expect(itemError.getStatus()).toBe(400);
    expect(itemError.getResponse()).toMatchObject({
      code: 'TATTOO_ITEM_INVALID',
      itemIndex: 3,
      field: 'structured.sessions.3.imageUrl',
    });
    const consentError = clientConsentRequired(2);
    expect(consentError.getStatus()).toBe(400);
    expect(consentError.getResponse()).toMatchObject({
      code: 'CLIENT_CONSENT_REQUIRED',
      itemIndex: 2,
    });
    const unlinkedError = flashDayEventUnlinkedPersona(1);
    expect(unlinkedError.getStatus()).toBe(400);
    expect(unlinkedError.getResponse()).toMatchObject({
      code: 'FLASH_DAY_EVENT_UNLINKED_PERSONA',
      itemIndex: 1,
    });
    const notEligibleError = flashDayEventNotEligible(0);
    expect(notEligibleError.getStatus()).toBe(400);
    expect(notEligibleError.getResponse()).toMatchObject({
      code: 'FLASH_DAY_EVENT_NOT_ELIGIBLE',
      itemIndex: 0,
    });
    const skinError = tattooSkinInvalid('tattooPrices.deposit.amount');
    expect(skinError.getStatus()).toBe(400);
    expect(skinError.getResponse()).toMatchObject({
      code: 'TATTOO_SKIN_INVALID',
      path: 'tattooPrices.deposit.amount',
    });
  });
});
