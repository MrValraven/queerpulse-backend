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

  it('resolves a freguesia of Cascais, Oeiras or the south bank of the Tejo', () => {
    expect(resolveAreaCentroid('Lisboa', 'Cascais e Estoril')).toEqual({
      latitude: 38.71502,
      longitude: -9.45905,
    });
    expect(resolveAreaCentroid('Lisboa', 'Barreiro e Lavradio')).toEqual({
      latitude: 38.66876,
      longitude: -9.05583,
    });
    expect(resolveAreaCentroid('Lisboa', 'Laranjeiro e Feijó')).not.toBeNull();
    expect(resolveAreaCentroid('Lisboa', 'alcochete')).not.toBeNull();
    expect(resolveAreaCentroid('Lisboa', 'Sado')).toEqual({
      latitude: 38.4951,
      longitude: -8.80302,
    });
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
