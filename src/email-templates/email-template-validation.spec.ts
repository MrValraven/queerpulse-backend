import { EMAIL_LIMITS } from './email-template-content';
import { placeholdersIn } from './email-template-purposes';
import { validateEmailTemplateLocales } from './email-template-validation';

function validLocale(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Your QueerPulse invite is ready',
    mode: 'blocks',
    blocks: [
      { id: 'heading-1', type: 'heading', text: 'Welcome, {name}', level: 1 },
      {
        id: 'button-1',
        type: 'button',
        label: 'Join QueerPulse',
        href: '{inviteLink}',
      },
    ],
    html: null,
    ...overrides,
  };
}

function errorsOf(value: unknown, purpose: 'invite_approved' | 'general') {
  const result = validateEmailTemplateLocales(value, purpose);
  return result.isValid ? [] : result.errors;
}

describe('placeholdersIn', () => {
  it('lists tokens once, in order, and ignores CSS braces', () => {
    expect(
      placeholdersIn(
        '{name} <style>p{margin:0} a{ color: red }</style> {name} {inviteLink}',
      ),
    ).toEqual(['name', 'inviteLink']);
  });
});

describe('validateEmailTemplateLocales', () => {
  it('accepts valid content, trims text and drops unknown fields', () => {
    const result = validateEmailTemplateLocales(
      {
        en: validLocale({ subject: '  Hello  ', extra: 'dropped' }),
        pt: validLocale(),
      },
      'invite_approved',
    );
    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.locales.en.subject).toBe('Hello');
    expect(result.locales.en).not.toHaveProperty('extra');
    expect(result.locales.pt?.blocks).toHaveLength(2);
  });

  it('treats a null pt as no Portuguese version', () => {
    const result = validateEmailTemplateLocales(
      { en: validLocale(), pt: null },
      'invite_approved',
    );
    expect(result.isValid && result.locales.pt).toBeUndefined();
  });

  it('requires English', () => {
    expect(errorsOf({ pt: validLocale() }, 'invite_approved')).toContain(
      'locales.en: English is required',
    );
  });

  it('rejects a language the platform does not ship', () => {
    expect(
      errorsOf({ en: validLocale(), fr: validLocale() }, 'invite_approved'),
    ).toContain('locales.fr: unsupported language');
  });

  it('names an unknown placeholder and the language it is in', () => {
    const errors = errorsOf(
      { en: validLocale({ subject: 'Hi {firstName}' }) },
      'invite_approved',
    );
    expect(errors).toEqual([
      'en: {firstName} is not a placeholder for invite_approved. Allowed: {name}, {inviteLink}, {expiresOn}',
    ]);
  });

  it('rejects every token on a general template', () => {
    const errors = errorsOf({ en: validLocale() }, 'general');
    expect(errors[0]).toContain('{name} is not a placeholder for general');
    expect(errors[0]).toContain('Allowed: none');
  });

  it('checks stored blocks even while the language is in HTML mode', () => {
    const errors = errorsOf(
      {
        en: validLocale({ mode: 'html', html: '<p>Hello</p>' }),
      },
      'general',
    );
    expect(errors.some((error) => error.includes('{name}'))).toBe(true);
  });

  it('accepts only https URLs or a whole placeholder on a button', () => {
    for (const href of [
      'http://example.com',
      'javascript:alert(1)',
      'go {inviteLink}',
    ]) {
      const errors = errorsOf(
        {
          en: validLocale({
            blocks: [{ id: 'button-1', type: 'button', label: 'Go', href }],
          }),
        },
        'invite_approved',
      );
      expect(
        errors.some((error) => error.startsWith('en.blocks[0].href')),
      ).toBe(true);
    }
  });

  it('rejects a non-https link inside a paragraph', () => {
    const errors = errorsOf(
      {
        en: validLocale({
          blocks: [
            {
              id: 'p-1',
              type: 'paragraph',
              text: 'Read [this](http://example.com)',
            },
          ],
        }),
      },
      'invite_approved',
    );
    expect(errors).toContain(
      'en.blocks[0].text: links must use an https:// address or a placeholder',
    );
  });

  it('rejects script, event handlers and javascript: URLs in HTML', () => {
    const cases: Array<[string, string]> = [
      ['<script>alert(1)</script>', '<script>'],
      ['<a href="#" onclick="steal()">x</a>', 'inline event handlers'],
      ['<a href="javascript:alert(1)">x</a>', 'javascript: URLs'],
      ['<iframe src="https://x.test"></iframe>', '<iframe>'],
      ['<form action="https://x.test"></form>', '<form>'],
    ];
    for (const [html, named] of cases) {
      const errors = errorsOf(
        { en: validLocale({ mode: 'html', html }) },
        'invite_approved',
      );
      expect(
        errors.some(
          (error) => error.startsWith('en.html') && error.includes(named),
        ),
      ).toBe(true);
    }
  });

  it('lints an HTML block the same way', () => {
    const errors = errorsOf(
      {
        en: validLocale({
          blocks: [{ id: 'html-1', type: 'html', html: '<script></script>' }],
        }),
      },
      'invite_approved',
    );
    expect(errors.some((error) => error.startsWith('en.blocks[0].html'))).toBe(
      true,
    );
  });

  it('requires HTML in html mode and a block in blocks mode', () => {
    expect(
      errorsOf(
        { en: validLocale({ mode: 'html', html: '  ' }) },
        'invite_approved',
      ),
    ).toContain('en.html: is required');
    expect(
      errorsOf({ en: validLocale({ blocks: [] }) }, 'invite_approved'),
    ).toContain('en.blocks: add at least one block');
  });

  it('caps the number of blocks', () => {
    const blocks = Array.from(
      { length: EMAIL_LIMITS.blocksPerLocale + 1 },
      (_value, index) => ({
        id: `divider-${index}`,
        type: 'divider',
      }),
    );
    expect(
      errorsOf({ en: validLocale({ blocks }) }, 'invite_approved'),
    ).toContain(`en.blocks: at most ${EMAIL_LIMITS.blocksPerLocale} blocks`);
  });

  it('validates image fields', () => {
    const errors = errorsOf(
      {
        en: validLocale({
          blocks: [
            {
              id: 'img-1',
              type: 'image',
              src: 'http://x.test/a.png',
              alt: '',
              width: 900,
            },
          ],
        }),
      },
      'invite_approved',
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'en.blocks[0].src: must be an https:// address',
        'en.blocks[0].alt: is required',
        `en.blocks[0].width: must be a whole number from 1 to ${EMAIL_LIMITS.imageWidth}`,
      ]),
    );
  });

  it('rejects an unknown block type', () => {
    expect(
      errorsOf(
        { en: validLocale({ blocks: [{ id: 'x-1', type: 'video' }] }) },
        'invite_approved',
      ),
    ).toContain('en.blocks[0].type: unknown block type');
  });
});
