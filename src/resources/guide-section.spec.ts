import { parseGuideSections } from './guide-section';

describe('parseGuideSections', () => {
  it('carries html on formatted kinds', () => {
    const parsed = parseGuideSections([
      {
        id: 'routes',
        heading: 'Routes',
        blocks: [
          { kind: 'paragraph', text: 'Hi there', html: 'Hi <em>there</em>' },
          { kind: 'note', text: 'Call 112', html: 'Call <strong>112</strong>' },
        ],
      },
    ]);
    expect(parsed).toEqual([
      {
        id: 'routes',
        heading: 'Routes',
        blocks: [
          { kind: 'paragraph', text: 'Hi there', html: 'Hi <em>there</em>' },
          { kind: 'note', text: 'Call 112', html: 'Call <strong>112</strong>' },
        ],
      },
    ]);
  });

  it('drops html on a subheading', () => {
    const parsed = parseGuideSections([
      {
        id: 'a',
        heading: 'A',
        blocks: [
          { kind: 'subheading', text: 'Getting there', html: '<em>x</em>' },
        ],
      },
    ]);
    expect(parsed[0]?.blocks[0]).toEqual({
      kind: 'subheading',
      text: 'Getting there',
    });
  });

  it('leaves a block without html untouched', () => {
    const parsed = parseGuideSections([
      {
        id: 'a',
        heading: 'A',
        blocks: [{ kind: 'listItem', text: 'Bring ID' }],
      },
    ]);
    expect(parsed[0]?.blocks[0]).toEqual({
      kind: 'listItem',
      text: 'Bring ID',
    });
  });
});
