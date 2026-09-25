import {
  EMAIL_FEATURE_ITEMS_MAX,
  EMAIL_LIMITS,
} from './email-template-content';
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

describe('validateEmailTemplateLocales: designed blocks', () => {
  function errorsForBlock(block: Record<string, unknown>) {
    return errorsOf(
      { en: validLocale({ blocks: [block] }) },
      'invite_approved',
    );
  }

  function acceptedBlock(block: Record<string, unknown>) {
    const result = validateEmailTemplateLocales(
      { en: validLocale({ blocks: [block] }) },
      'invite_approved',
    );
    expect(result.isValid).toBe(true);
    return result.isValid ? result.locales.en.blocks[0] : undefined;
  }

  const hero = {
    id: 'hero-1',
    type: 'hero',
    eyebrow: "You're in",
    headline: 'Welcome in, *{name}*.',
    text: 'We would love to have you here.',
  };
  const ticket = {
    id: 'ticket-1',
    type: 'ticket',
    label: 'Your invite',
    title: 'Valid until {expiresOn}',
    text: 'This link is yours alone.',
    buttonLabel: 'Join QueerPulse',
    href: '{inviteLink}',
  };
  const featureItem = {
    icon: 'communities',
    title: 'Communities',
    text: 'Find your people.',
  };
  const featureList = {
    id: 'features-1',
    type: 'featureList',
    items: [featureItem],
  };
  const signature = {
    id: 'signature-1',
    type: 'signature',
    name: 'The QueerPulse team',
    role: '',
    note: 'See you inside.',
    photoUrl: '',
  };

  it('accepts a hero, trims it and stores empty optional fields as empty text', () => {
    expect(
      acceptedBlock({
        ...hero,
        eyebrow: '  ',
        text: undefined,
        headline: '  Hi  ',
        extra: 'dropped',
      }),
    ).toEqual({
      id: 'hero-1',
      type: 'hero',
      eyebrow: '',
      headline: 'Hi',
      text: '',
    });
  });

  it('requires a hero headline', () => {
    expect(errorsForBlock({ ...hero, headline: ' ' })).toContain(
      'en.blocks[0].headline: is required',
    );
  });

  it('accepts a ticket with an empty text', () => {
    expect(acceptedBlock({ ...ticket, text: '' })).toEqual({
      ...ticket,
      text: '',
    });
  });

  it('requires the ticket label, title, button label and link', () => {
    const errors = errorsForBlock({
      id: 'ticket-1',
      type: 'ticket',
      text: 'Hello',
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'en.blocks[0].label: must be text',
        'en.blocks[0].title: must be text',
        'en.blocks[0].buttonLabel: must be text',
        'en.blocks[0].href: must be text',
      ]),
    );
  });

  it('holds a ticket link to the same rule as a button', () => {
    expect(errorsForBlock({ ...ticket, href: 'http://example.com' })).toContain(
      'en.blocks[0].href: must be an https:// address or a single placeholder',
    );
  });

  it('accepts a feature list and drops unknown item fields', () => {
    expect(
      acceptedBlock({
        ...featureList,
        items: [{ ...featureItem, colour: 'red' }],
      }),
    ).toEqual(featureList);
  });

  it('rejects a feature icon outside the list', () => {
    const errors = errorsForBlock({
      ...featureList,
      items: [featureItem, { ...featureItem, icon: 'rocket' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^en\.blocks\[0\]\.items\[1\]\.icon: must be one of/,
    );
  });

  it('names a missing feature title by its item', () => {
    expect(
      errorsForBlock({
        ...featureList,
        items: [featureItem, { ...featureItem, title: '' }],
      }),
    ).toContain('en.blocks[0].items[1].title: is required');
  });

  it('holds a feature list to one to four items', () => {
    expect(errorsForBlock({ ...featureList, items: [] })).toContain(
      'en.blocks[0].items: add at least one item',
    );
    expect(
      errorsForBlock({
        ...featureList,
        items: Array.from(
          { length: EMAIL_FEATURE_ITEMS_MAX + 1 },
          () => featureItem,
        ),
      }),
    ).toContain(`en.blocks[0].items: at most ${EMAIL_FEATURE_ITEMS_MAX} items`);
  });

  it('accepts a signature with or without an https photo', () => {
    expect(acceptedBlock(signature)).toEqual(signature);
    const withPhoto = { ...signature, photoUrl: 'https://x.test/kai.png' };
    expect(acceptedBlock(withPhoto)).toEqual(withPhoto);
  });

  it('requires a signature name', () => {
    expect(errorsForBlock({ ...signature, name: '' })).toContain(
      'en.blocks[0].name: is required',
    );
  });

  it('rejects a signature photo that is not an https address', () => {
    for (const photoUrl of ['http://x.test/kai.png', '{inviteLink}']) {
      expect(errorsForBlock({ ...signature, photoUrl })).toContain(
        'en.blocks[0].photoUrl: must be an https:// address',
      );
    }
  });

  it('scans every designed block for placeholders', () => {
    const errors = errorsOf(
      {
        en: validLocale({
          blocks: [
            { ...hero, headline: 'Hi', eyebrow: '{firstName}' },
            { ...featureList, items: [{ ...featureItem, text: '{city}' }] },
          ],
        }),
      },
      'invite_approved',
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('{firstName} is not a placeholder'),
        expect.stringContaining('{city} is not a placeholder'),
      ]),
    );
  });
});

describe('validateEmailTemplateLocales: preheader', () => {
  it('stores a trimmed preheader', () => {
    const result = validateEmailTemplateLocales(
      { en: validLocale({ preheader: '  Your invite is inside.  ' }) },
      'invite_approved',
    );
    expect(result.isValid && result.locales.en.preheader).toBe(
      'Your invite is inside.',
    );
  });

  it('leaves an empty preheader off the stored content', () => {
    const result = validateEmailTemplateLocales(
      { en: validLocale({ preheader: '   ' }) },
      'invite_approved',
    );
    expect(result.isValid).toBe(true);
    if (!result.isValid) return;
    expect(result.locales.en).not.toHaveProperty('preheader');
  });

  it('caps the preheader length', () => {
    expect(
      errorsOf(
        {
          en: validLocale({
            preheader: 'a'.repeat(EMAIL_LIMITS.preheader + 1),
          }),
        },
        'invite_approved',
      ),
    ).toContain(
      `en.preheader: must be at most ${EMAIL_LIMITS.preheader} characters`,
    );
  });

  it('rejects a placeholder in the preheader the purpose does not allow', () => {
    const errors = errorsOf(
      {
        en: validLocale({
          blocks: [{ id: 'divider-1', type: 'divider' }],
          preheader: 'Hello {name}',
        }),
      },
      'general',
    );
    expect(errors).toEqual([
      'en: {name} is not a placeholder for general. Allowed: none',
    ]);
  });
});
