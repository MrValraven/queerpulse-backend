import { validateEmailTemplateLocales } from './email-template-validation';
import { emailTemplatesSeed } from './email-templates.seed';

describe('emailTemplatesSeed', () => {
  it.each(emailTemplatesSeed.map((seed) => [seed.label, seed]))(
    '%s passes the write-boundary validator unchanged',
    (_label, seed) => {
      const result = validateEmailTemplateLocales(seed.locales, seed.purpose);
      expect(result).toEqual({ isValid: true, locales: seed.locales });
    },
  );

  it('ships a Portuguese version of every starter template', () => {
    for (const seed of emailTemplatesSeed)
      expect(seed.locales.pt).toBeDefined();
  });
});
