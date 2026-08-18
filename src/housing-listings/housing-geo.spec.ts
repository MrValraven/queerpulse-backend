import { resolveAreaCentroid } from './housing-geo';

describe('resolveAreaCentroid', () => {
  it('resolves a Lisbon freguesia, accent- and case-insensitively', () => {
    expect(resolveAreaCentroid('Lisboa', 'Alvalade')).toEqual({
      latitude: 38.75423,
      longitude: -9.13886,
    });
    expect(resolveAreaCentroid('Lisboa', 'alvalade')).not.toBeNull();
  });

  it('resolves a freguesia name with diacritics case-insensitively', () => {
    expect(resolveAreaCentroid('Lisboa', 'Misericórdia')).not.toBeNull();
    expect(resolveAreaCentroid('Lisboa', 'misericordia')).not.toBeNull();
  });

  it('still resolves a Porto neighbourhood (untouched by the Lisbon swap)', () => {
    expect(resolveAreaCentroid('Porto', 'Cedofeita')).not.toBeNull();
  });

  it('falls back to the city centroid for an unknown area', () => {
    expect(resolveAreaCentroid('Lisboa', 'Nowhere')).toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
    });
  });

  it('returns null when neither area nor city is known', () => {
    expect(resolveAreaCentroid('Nowhere', 'Nowhere')).toBeNull();
  });
});
