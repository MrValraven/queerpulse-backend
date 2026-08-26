import {
  HOUSING_CITY,
  HOUSING_TIMEZONE,
  isHousingCityName,
  resolveHousingLocation,
} from './housing-city';

describe('housing city (LOC-09)', () => {
  it('is Lisbon, in Europe/Lisbon', () => {
    expect(HOUSING_CITY).toBe('Lisbon');
    expect(HOUSING_TIMEZONE).toBe('Europe/Lisbon');
  });

  describe('isHousingCityName', () => {
    it('accepts the spellings a member or an older client would send', () => {
      expect(isHousingCityName('Lisbon')).toBe(true);
      expect(isHousingCityName('lisbon')).toBe(true);
      expect(isHousingCityName('Lisboa')).toBe(true);
      expect(isHousingCityName('  LISBOA ')).toBe(true);
    });

    it('does not accept a neighbourhood', () => {
      expect(isHousingCityName('Arroios')).toBe(false);
      expect(isHousingCityName('Príncipe Real')).toBe(false);
    });
  });

  describe('resolveHousingLocation', () => {
    it('stores Lisbon for a missing or empty city', () => {
      expect(resolveHousingLocation({}).city).toBe('Lisbon');
      expect(resolveHousingLocation({ city: '' }).city).toBe('Lisbon');
      expect(resolveHousingLocation({ city: '   ' }).city).toBe('Lisbon');
      expect(resolveHousingLocation({ city: null }).city).toBe('Lisbon');
    });

    it('normalises every accepted spelling to the canonical one', () => {
      expect(resolveHousingLocation({ city: 'lisboa' }).city).toBe('Lisbon');
    });

    it('moves a neighbourhood sent as the city into area when area is empty', () => {
      expect(resolveHousingLocation({ city: 'Arroios' })).toEqual({
        city: 'Lisbon',
        area: 'Arroios',
      });
    });

    it('keeps a real area and never lets the city overwrite it', () => {
      expect(
        resolveHousingLocation({ city: 'Arroios', area: 'Alvalade' }),
      ).toEqual({ city: 'Lisbon', area: 'Alvalade' });
    });

    it('leaves the area untouched when the caller sent none', () => {
      expect(resolveHousingLocation({ city: 'Lisbon' }).area).toBeUndefined();
    });

    it('trims what it stores', () => {
      expect(resolveHousingLocation({ area: '  Arroios  ' }).area).toBe(
        'Arroios',
      );
    });
  });
});
