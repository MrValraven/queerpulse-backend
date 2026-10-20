import {
  isTypedAnswerMatch,
  isWithinOneEdit,
  normaliseAnswerText,
  typedAnswerCandidates,
} from './quizshow-answer-normaliser';

describe('Pulse Live typed answer matching', () => {
  it('matches across case, accents and punctuation', () => {
    expect(isTypedAnswerMatch('stonewall inn!', ['Stonewall Inn'])).toBe(true);
    expect(isTypedAnswerMatch('sao paulo', ['São Paulo'])).toBe(true);
    expect(isTypedAnswerMatch('RU PAUL', ['RuPaul'])).toBe(true);
  });

  it('allows one typo from five letters up', () => {
    expect(isTypedAnswerMatch('Prto', ['Porto'])).toBe(true);
    expect(isTypedAnswerMatch('Conchitta', ['Conchita'])).toBe(true);
    expect(isTypedAnswerMatch('Lisbao', ['Lisboa'])).toBe(true);
    expect(isTypedAnswerMatch('Parta', ['Porto'])).toBe(false);
  });

  it('allows no typo under five letters', () => {
    expect(isTypedAnswerMatch('Abab', ['ABBA'])).toBe(false);
    expect(isTypedAnswerMatch('abba', ['ABBA'])).toBe(true);
  });

  it('ignores blank candidates and a blank submission', () => {
    expect(isTypedAnswerMatch('', ['x'])).toBe(false);
    expect(isTypedAnswerMatch('abc', ['', '  '])).toBe(false);
  });

  it('checks both languages and the accepted answers', () => {
    const candidates = typedAnswerCandidates(
      { text: { en: 'Netherlands', pt: 'Países Baixos' } },
      ['Holland'],
    );
    expect(isTypedAnswerMatch('paises baixos', candidates)).toBe(true);
    expect(isTypedAnswerMatch('holland', candidates)).toBe(true);
    expect(isTypedAnswerMatch('netherlands', candidates)).toBe(true);
  });

  it('normalises to lowercase words separated by single spaces', () => {
    expect(normaliseAnswerText('  Ça  va, Zoë?! ')).toBe('ca va zoe');
  });

  it('measures one substitution, one adjacent swap or one insertion as one edit', () => {
    expect(isWithinOneEdit('porto', 'porto')).toBe(true);
    expect(isWithinOneEdit('parto', 'porto')).toBe(true);
    expect(isWithinOneEdit('lisbao', 'lisboa')).toBe(true);
    expect(isWithinOneEdit('prto', 'porto')).toBe(true);
    expect(isWithinOneEdit('porto', 'prto')).toBe(true);
    expect(isWithinOneEdit('parta', 'porto')).toBe(false);
    expect(isWithinOneEdit('pto', 'porto')).toBe(false);
    expect(isWithinOneEdit('abcd', 'badc')).toBe(false);
  });
});
