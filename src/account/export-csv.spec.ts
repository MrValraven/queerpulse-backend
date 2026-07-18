import { UTF8_BOM, toCsv } from './export-csv';

// Strips the BOM and splits on the RFC 4180 record separator, so assertions can
// talk about rows rather than about byte offsets.
function rows(csv: string): string[] {
  expect(csv.startsWith(UTF8_BOM)).toBe(true);
  const body = csv.slice(UTF8_BOM.length);
  return body === '' ? [] : body.replace(/\r\n$/, '').split('\r\n');
}

describe('toCsv', () => {
  describe('framing', () => {
    it('prefixes a UTF-8 BOM so Excel does not mangle non-ASCII names', () => {
      // Without the BOM Excel on Windows decodes as the system ANSI codepage
      // and the seed data's `Anika Kovač` renders as `Anika KovaÄ`.
      const csv = toCsv([{ name: 'Anika Kovač' }, { name: 'Céu Marques' }]);
      expect(csv.startsWith('\uFEFF')).toBe(true);
      expect(csv).toContain('Anika Kovač');
      expect(csv).toContain('Céu Marques');
    });

    it('terminates records with CRLF', () => {
      expect(toCsv([{ a: '1' }])).toBe(`${UTF8_BOM}a\r\n1\r\n`);
    });

    it('renders an empty category as the BOM alone', () => {
      // Deliberate: with zero rows there is no column set to invent. Inside the
      // zip, "file absent" means the category was not requested and "file
      // empty" means it was requested and had no rows.
      expect(toCsv([])).toBe(UTF8_BOM);
      expect(toCsv(null)).toBe(UTF8_BOM);
      expect(toCsv(undefined)).toBe(UTF8_BOM);
    });

    it('renders a single record (the `profile` category) as one data row', () => {
      const csv = rows(toCsv({ email: 'a@b.com', verified: true }));
      expect(csv).toEqual(['email,verified', 'a@b.com,true']);
    });
  });

  describe('escaping', () => {
    it('quotes and doubles-up embedded commas, quotes and newlines', () => {
      const csv = toCsv([{ body: 'hello, "friend"\nnext line' }]);
      expect(csv).toBe(`${UTF8_BOM}body\r\n"hello, ""friend""\nnext line"\r\n`);
    });

    it('quotes cells with leading or trailing whitespace', () => {
      expect(rows(toCsv([{ a: '  padded  ' }]))[1]).toBe('"  padded  "');
    });

    it('renders null and undefined as empty cells, not the strings', () => {
      const csv = rows(toCsv([{ a: null, b: undefined, c: 'x' }]));
      expect(csv).toEqual(['a,b,c', ',,x']);
    });
  });

  describe('flattening', () => {
    it('expands a nested object into one column per leaf', () => {
      // The failure this guards: a `sender` object rendered as `[object
      // Object]`, which is worse than no CSV at all.
      const csv = rows(
        toCsv([{ id: 'm1', sender: { id: 'u2', name: 'Zoë' } }]),
      );
      expect(csv).toEqual(['id,sender.id,sender.name', 'm1,u2,Zoë']);
      expect(csv.join()).not.toContain('[object Object]');
    });

    it('joins scalar arrays into one cell rather than exploding columns', () => {
      // `tags`/`identities`/`lookingFor` are tag-like sets; one column per
      // element would make the header a function of the widest row.
      const csv = rows(toCsv([{ tags: ['poly', 'queer, trans'] }]));
      // The `, ` inside an element is what forces the cell to be quoted; the
      // `; ` separator is ours.
      expect(csv).toEqual(['tags', '"poly; queer, trans"']);
    });

    it('indexes object arrays so their fields land in separate columns', () => {
      const csv = rows(
        toCsv({
          openTo: [
            { label: 'coffee', blurb: 'anytime' },
            { label: 'gigs', blurb: null },
          ],
        }),
      );
      expect(csv).toEqual([
        'openTo[0].label,openTo[0].blurb,openTo[1].label,openTo[1].blurb',
        'coffee,anytime,gigs,',
      ]);
    });

    it('renders empty arrays and empty objects as empty cells', () => {
      expect(rows(toCsv([{ a: [], b: {}, c: 'x' }]))).toEqual(['a,b,c', ',,x']);
    });

    it('never emits a stringified object for any nesting depth', () => {
      const csv = toCsv([
        { deep: { a: { b: { c: [{ d: 'leaf' }] } } } },
        { deep: { a: { b: { c: [] } } } },
      ]);
      expect(csv).not.toContain('[object Object]');
      expect(csv).toContain('deep.a.b.c[0].d');
    });
  });

  describe('columns', () => {
    it('unions keys across mixed-shape rows and keeps them aligned', () => {
      // `posts` really does interleave two shapes: `thread` and `reply`.
      const csv = rows(
        toCsv([
          { type: 'thread', id: 't1', title: 'Hi' },
          { type: 'reply', id: 'p1', body: 'ok' },
        ]),
      );
      expect(csv).toEqual([
        'type,id,title,body',
        'thread,t1,Hi,',
        'reply,p1,,ok',
      ]);
    });

    it('is deterministic — the same payload twice produces identical bytes', () => {
      const payload = [
        { id: 1, x: null },
        { id: 2, y: 'q' },
      ];
      expect(toCsv(payload)).toBe(toCsv(payload));
    });

    it('preserves authored field order rather than sorting alphabetically', () => {
      const csv = rows(
        toCsv([{ id: 'm1', conversationId: 'c1', body: 'hi', sentAt: 'z' }]),
      );
      expect(csv[0]).toBe('id,conversationId,body,sentAt');
    });
  });

  describe('formula injection', () => {
    it('neutralises cells a spreadsheet would evaluate as a formula', () => {
      // Message bodies and vouch notes are attacker-authored; `=HYPERLINK(...)`
      // in one would otherwise execute when the member opens their own export.
      const csv = rows(
        toCsv([{ a: '=HYPERLINK("http://evil","x")', b: '+1', c: '@sum' }]),
      );
      expect(csv[1]).toBe(`"'=HYPERLINK(""http://evil"",""x"")",'+1,'@sum`);
    });

    it('leaves negative numbers alone', () => {
      // `-5` is a value, not an operator; prefixing it would break every
      // numeric column for no security gain.
      expect(rows(toCsv([{ score: -5, ratio: -1.5 }]))[1]).toBe('-5,-1.5');
    });
  });
});
