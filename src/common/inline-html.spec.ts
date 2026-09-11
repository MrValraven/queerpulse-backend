import { inlineHtmlToPlainText, sanitizeInlineHtml } from './inline-html';

describe('sanitizeInlineHtml', () => {
  it('keeps em, strong and br', () => {
    expect(sanitizeInlineHtml('<em>a</em> <strong>b</strong><br>')).toBe(
      '<em>a</em> <strong>b</strong><br />',
    );
  });

  it('drops script and style content entirely', () => {
    const output = sanitizeInlineHtml(
      'safe<script>alert(1)</script><style>p{}</style>text',
    );
    expect(output).toBe('safetext');
  });

  it('drops javascript: and protocol-relative hrefs', () => {
    const javascriptLink = sanitizeInlineHtml(
      '<a href="javascript:alert(1)">x</a>',
    );
    const protocolRelativeLink = sanitizeInlineHtml(
      '<a href="//evil.example">y</a>',
    );
    expect(javascriptLink).not.toContain('javascript:');
    expect(protocolRelativeLink).not.toContain('evil.example');
  });

  it('forces rel and target on a safe link', () => {
    expect(
      sanitizeInlineHtml('<a href="https://sns.gov.pt" rel="x">SNS</a>'),
    ).toBe(
      '<a href="https://sns.gov.pt" rel="noopener noreferrer" target="_blank">SNS</a>',
    );
  });
});

describe('inlineHtmlToPlainText', () => {
  it('turns <br> into a newline and strips tags', () => {
    expect(inlineHtmlToPlainText('One<br />two <strong>three</strong>')).toBe(
      'One\ntwo three',
    );
  });

  it('decodes entities exactly once', () => {
    expect(inlineHtmlToPlainText('Tom &amp; Jerry &amp;lt;b&amp;gt;')).toBe(
      'Tom & Jerry &lt;b&gt;',
    );
  });

  it('turns non-breaking spaces into spaces and trims', () => {
    expect(inlineHtmlToPlainText('&nbsp;hi&nbsp;there ')).toBe('hi there');
  });
});
