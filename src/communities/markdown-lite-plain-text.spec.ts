import { markdownLitePlainText } from './markdown-lite-plain-text';

describe('markdownLitePlainText', () => {
  it('leaves plain text untouched', () => {
    expect(markdownLitePlainText('just words here')).toBe('just words here');
  });

  it('removes bold marks', () => {
    expect(markdownLitePlainText('this is **so good** honestly')).toBe(
      'this is so good honestly',
    );
  });

  it('removes italic marks', () => {
    expect(markdownLitePlainText('this is *quietly* good')).toBe(
      'this is quietly good',
    );
  });

  it('keeps an inner single asterisk inside a bold run literal', () => {
    expect(markdownLitePlainText('**a *b* c**')).toBe('a *b* c');
  });

  it('keeps a lone asterisk someone typed', () => {
    expect(markdownLitePlainText('5 * 3 is fifteen')).toBe('5 * 3 is fifteen');
  });

  it('turns a heading line into its words', () => {
    expect(markdownLitePlainText('**Saturday plans**\nmeet at noon')).toBe(
      'Saturday plans\nmeet at noon',
    );
  });

  it('turns an indented heading line into its words', () => {
    expect(markdownLitePlainText('  **Saturday plans**  ')).toBe(
      'Saturday plans',
    );
  });

  it('removes dash and asterisk bullets at line starts', () => {
    expect(markdownLitePlainText('- snacks\n* drinks\n  - music')).toBe(
      'snacks\ndrinks\nmusic',
    );
  });

  it('keeps an italic run at the start of a line as its words', () => {
    expect(markdownLitePlainText('*soft* start')).toBe('soft start');
  });

  it('removes ordered list numbers at line starts', () => {
    expect(markdownLitePlainText('1. arrive\n2. dance\n10. leave')).toBe(
      'arrive\ndance\nleave',
    );
  });

  it('leaves a dash in the middle of a line alone', () => {
    expect(markdownLitePlainText('a well-loved spot - truly')).toBe(
      'a well-loved spot - truly',
    );
  });

  it('removes quote marks with and without the space', () => {
    expect(markdownLitePlainText('> be kind\n>always')).toBe('be kind\nalways');
  });

  it('turns a markdown link into its text', () => {
    expect(
      markdownLitePlainText(
        'read [the guide](https://example.org/guide) first',
      ),
    ).toBe('read the guide first');
  });

  it('keeps a link with a non-http target as typed', () => {
    expect(markdownLitePlainText('[click](javascript:alert)')).toBe(
      '[click](javascript:alert)',
    );
  });

  it('keeps a bare URL as typed, asterisks included', () => {
    expect(
      markdownLitePlainText('see https://example.org/a*b*c for details'),
    ).toBe('see https://example.org/a*b*c for details');
  });

  it('keeps mentions as typed', () => {
    expect(markdownLitePlainText('thanks @sam and c/book-club')).toBe(
      'thanks @sam and c/book-club',
    );
  });

  it('keeps newlines and blank lines', () => {
    expect(markdownLitePlainText('first\n\nsecond')).toBe('first\n\nsecond');
  });

  it('strips block and inline marks on the same line', () => {
    expect(
      markdownLitePlainText(
        '> **heads up** read [this](https://example.org) *now*',
      ),
    ).toBe('heads up read this now');
  });

  it('strips a whole toolbar-written body', () => {
    const body = [
      '**Picnic on Sunday**',
      'Bring something to share with @alex',
      '- a blanket',
      '- *something sweet*',
      '1. meet at the gate',
      '2. walk to the lake',
      '> rain moves it to Monday',
      'Map: [here](https://maps.example.org/park) or https://example.org/park',
    ].join('\n');
    expect(markdownLitePlainText(body)).toBe(
      [
        'Picnic on Sunday',
        'Bring something to share with @alex',
        'a blanket',
        'something sweet',
        'meet at the gate',
        'walk to the lake',
        'rain moves it to Monday',
        'Map: here or https://example.org/park',
      ].join('\n'),
    );
  });
});
