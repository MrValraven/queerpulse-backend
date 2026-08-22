import { ArticleBlock } from './entities/magazine-article.entity';
import {
  sanitizeArticleBlocks,
  sanitizeArticleHtml,
} from './article-html-sanitizer';

describe('sanitizeArticleHtml (M3 write-boundary sanitizer)', () => {
  it('keeps the allowlisted inline tags', () => {
    expect(sanitizeArticleHtml('<em>a</em> and <strong>b</strong><br />')).toBe(
      '<em>a</em> and <strong>b</strong><br />',
    );
  });

  it('drops a <script> tag and its content', () => {
    const output = sanitizeArticleHtml('safe<script>alert(1)</script>text');
    expect(output).not.toContain('script');
    expect(output).not.toContain('alert(1)');
    expect(output).toContain('safe');
    expect(output).toContain('text');
  });

  it('strips an <img onerror=...> payload entirely', () => {
    const output = sanitizeArticleHtml(
      '<p>hi<img src=x onerror="alert(1)"></p>',
    );
    expect(output).not.toContain('img');
    expect(output).not.toContain('onerror');
    expect(output).not.toContain('alert(1)');
    expect(output).toContain('hi');
  });

  it('drops a javascript: href', () => {
    const output = sanitizeArticleHtml(
      '<a href="javascript:alert(1)">click</a>',
    );
    expect(output).not.toContain('javascript:');
    expect(output).not.toContain('alert(1)');
    expect(output).toContain('click');
  });

  it('drops a data: href', () => {
    const output = sanitizeArticleHtml(
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    );
    expect(output).not.toContain('data:');
    expect(output).not.toContain('script');
  });

  it('keeps an http/https/mailto href and forces rel + target', () => {
    for (const href of [
      'https://example.com',
      'http://example.com',
      'mailto:hi@example.com',
    ]) {
      const output = sanitizeArticleHtml(`<a href="${href}">link</a>`);
      expect(output).toContain(`href="${href}"`);
      expect(output).toContain('rel="noopener noreferrer"');
      expect(output).toContain('target="_blank"');
    }
  });

  it('overrides an attacker-supplied rel/target with the forced values', () => {
    const output = sanitizeArticleHtml(
      '<a href="https://x.test" rel="opener" target="_self" onclick="steal()">x</a>',
    );
    expect(output).not.toContain('onclick');
    expect(output).not.toContain('opener"');
    expect(output).not.toContain('_self');
    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('target="_blank"');
  });

  it('strips styling and other non-allowlisted tags but keeps their text', () => {
    const output = sanitizeArticleHtml(
      '<div style="x"><b>bold</b> <i>italic</i></div>',
    );
    expect(output).not.toContain('div');
    expect(output).not.toContain('style');
    expect(output).not.toContain('<b>');
    expect(output).not.toContain('<i>');
    expect(output).toContain('bold');
    expect(output).toContain('italic');
  });
});

describe('sanitizeArticleBlocks (M3)', () => {
  it('sanitizes every rich-text field: paragraph/heading/quote html, qa q+html, image caption', () => {
    const blocks: ArticleBlock[] = [
      {
        id: '1',
        kind: 'paragraph',
        html: 'lead<script>alert(1)</script><em>ok</em>',
      },
      { id: '2', kind: 'heading', html: '<img src=x onerror="alert(1)">Title' },
      {
        id: '3',
        kind: 'qa',
        q: '<a href="javascript:alert(1)">Q?</a>',
        html: '<strong>A</strong><iframe></iframe>',
        who: 'Someone',
      },
      {
        id: '4',
        kind: 'image',
        alt: 'alt',
        caption: 'cap<script>alert(1)</script>',
        credit: 'credit',
        rights: 'commissioned',
        tint: 'coral',
        crop: '16:9',
        focal: { x: 0.5, y: 0.5 },
        src: 'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
      },
    ];

    const sanitized = sanitizeArticleBlocks(blocks);
    const paragraph = sanitized[0] as Extract<
      ArticleBlock,
      { kind: 'paragraph' }
    >;
    const heading = sanitized[1] as Extract<ArticleBlock, { kind: 'heading' }>;
    const qa = sanitized[2] as Extract<ArticleBlock, { kind: 'qa' }>;
    const image = sanitized[3] as Extract<ArticleBlock, { kind: 'image' }>;

    expect(paragraph.html).not.toContain('script');
    expect(paragraph.html).toContain('<em>ok</em>');
    expect(heading.html).not.toContain('img');
    expect(heading.html).toContain('Title');
    expect(qa.q).not.toContain('javascript:');
    expect(qa.html).not.toContain('iframe');
    expect(qa.html).toContain('<strong>A</strong>');
    // Non-rich-text fields are untouched: the image src key is preserved as-is.
    expect(image.src).toBe(
      'avatars/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.jpg',
    );
    expect(image.caption).not.toContain('script');
    expect(image.caption).toContain('cap');
  });

  it('leaves a stats block untouched (no rich-text field)', () => {
    const stats: ArticleBlock = {
      id: '5',
      kind: 'stats',
      items: [{ value: '42', label: 'answers' }],
    };
    expect(sanitizeArticleBlocks([stats])[0]).toEqual(stats);
  });
});
