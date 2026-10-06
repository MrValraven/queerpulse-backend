import { isBareProfessionName, personaTitleName } from './persona-title-name';

describe('personaTitleName', () => {
  it('titles a persona named after its EN label as "Owner | Label"', () => {
    expect(
      personaTitleName({
        displayName: 'Art historian',
        kind: 'art_historian',
        ownerName: 'Alina C.',
      }),
    ).toBe('Alina C. | Art historian');
  });

  it('reads the PT label as bare whatever its case and accents, and titles with the EN label', () => {
    expect(
      personaTitleName({
        displayName: '  HISTORIA   DA ARTE ',
        kind: 'art_historian',
        ownerName: ' Alina C. ',
      }),
    ).toBe('Alina C. | Art historian');
  });

  it('keeps a chosen name unchanged', () => {
    expect(
      personaTitleName({
        displayName: ' Alina Writes ',
        kind: 'art_historian',
        ownerName: 'Alina C.',
      }),
    ).toBe('Alina Writes');
  });

  it('keeps a bare name when no owner name is known', () => {
    for (const ownerName of [undefined, null, '', '   ']) {
      expect(
        personaTitleName({
          displayName: 'Art historian',
          kind: 'art_historian',
          ownerName,
        }),
      ).toBe('Art historian');
    }
  });

  it('keeps an extra search word as a chosen name', () => {
    expect(
      isBareProfessionName({ displayName: 'DM', kind: 'game_master' }),
    ).toBe(false);
    expect(
      personaTitleName({
        displayName: 'DM',
        kind: 'game_master',
        ownerName: 'Alina C.',
      }),
    ).toBe('DM');
  });
});
