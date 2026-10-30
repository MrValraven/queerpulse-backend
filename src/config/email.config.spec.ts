import emailConfig from './email.config';

const EMAIL_VARIABLES = [
  'NODE_ENV',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'RESEND_SIGNIN_TEMPLATE_ID_EN',
  'RESEND_SIGNIN_TEMPLATE_ID_PT',
  'RESEND_SIGNUP_TEMPLATE_ID_EN',
  'RESEND_SIGNUP_TEMPLATE_ID_PT',
  'RESEND_WELCOME_TEMPLATE_ID_EN',
  'RESEND_WELCOME_TEMPLATE_ID_PT',
  'EMAIL_CODE_SECRET',
  'EMAIL_CODE_DEV_LOG',
] as const;

const RESEND_CONFIGURED = {
  RESEND_API_KEY: 're_test_key',
  RESEND_SIGNIN_TEMPLATE_ID_EN: 'template-en',
  RESEND_SIGNIN_TEMPLATE_ID_PT: 'template-pt',
};

describe('email config', () => {
  const saved: Partial<Record<string, string>> = {};

  function loadWith(values: Partial<Record<string, string>>) {
    for (const name of EMAIL_VARIABLES) delete process.env[name];
    Object.assign(process.env, values);
    return emailConfig();
  }

  beforeAll(() => {
    for (const name of EMAIL_VARIABLES) saved[name] = process.env[name];
  });

  afterAll(() => {
    for (const name of EMAIL_VARIABLES) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('reads the welcome template ids without changing enabled', () => {
    const config = loadWith({
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_test_key',
      RESEND_WELCOME_TEMPLATE_ID_EN: 'welcome-en',
      RESEND_WELCOME_TEMPLATE_ID_PT: 'welcome-pt',
    });
    expect(config.welcomeTemplateIdEn).toBe('welcome-en');
    expect(config.welcomeTemplateIdPt).toBe('welcome-pt');
    expect(config.enabled).toBe(false);
  });

  it('reads the signup template ids without changing enabled', () => {
    const withoutSignIn = loadWith({
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_test_key',
      RESEND_SIGNUP_TEMPLATE_ID_EN: 'signup-en',
      RESEND_SIGNUP_TEMPLATE_ID_PT: 'signup-pt',
    });
    expect(withoutSignIn.signUpTemplateIdEn).toBe('signup-en');
    expect(withoutSignIn.signUpTemplateIdPt).toBe('signup-pt');
    expect(withoutSignIn.enabled).toBe(false);

    const withSignIn = loadWith({
      NODE_ENV: 'production',
      ...RESEND_CONFIGURED,
    });
    expect(withSignIn.signUpTemplateIdEn).toBeUndefined();
    expect(withSignIn.enabled).toBe(true);
  });

  it('is enabled in production when the key and both template ids are set', () => {
    const config = loadWith({ NODE_ENV: 'production', ...RESEND_CONFIGURED });
    expect(config.enabled).toBe(true);
    expect(config.devLog).toBe(false);
  });

  it.each([
    'RESEND_API_KEY',
    'RESEND_SIGNIN_TEMPLATE_ID_EN',
    'RESEND_SIGNIN_TEMPLATE_ID_PT',
  ] as const)('is disabled in production when %s is missing', (missing) => {
    const values: Partial<Record<string, string>> = {
      NODE_ENV: 'production',
      ...RESEND_CONFIGURED,
    };
    delete values[missing];
    expect(loadWith(values).enabled).toBe(false);
    expect(loadWith({ ...values, [missing]: '' }).enabled).toBe(false);
  });

  it('is disabled in production with no Resend variable at all', () => {
    expect(loadWith({ NODE_ENV: 'production' }).enabled).toBe(false);
  });

  it('ignores EMAIL_CODE_DEV_LOG in production', () => {
    const config = loadWith({
      NODE_ENV: 'production',
      EMAIL_CODE_DEV_LOG: 'true',
    });
    expect(config.devLog).toBe(false);
    expect(config.enabled).toBe(false);
  });

  it('is disabled in development without Resend or EMAIL_CODE_DEV_LOG', () => {
    const config = loadWith({ NODE_ENV: 'development' });
    expect(config.devLog).toBe(false);
    expect(config.enabled).toBe(false);
  });

  it('turns the dev log and the feature on in development with EMAIL_CODE_DEV_LOG=true', () => {
    const config = loadWith({
      NODE_ENV: 'development',
      EMAIL_CODE_DEV_LOG: 'true',
    });
    expect(config.devLog).toBe(true);
    expect(config.enabled).toBe(true);
  });

  it('keeps the dev log off for any EMAIL_CODE_DEV_LOG value other than true', () => {
    for (const value of ['false', '1', 'yes', '']) {
      const config = loadWith({
        NODE_ENV: 'test',
        EMAIL_CODE_DEV_LOG: value,
      });
      expect(config.devLog).toBe(false);
      expect(config.enabled).toBe(false);
    }
  });

  it('falls back to the default sender when RESEND_FROM is unset', () => {
    expect(loadWith({ ...RESEND_CONFIGURED }).from).toBe(
      'QueerPulse <hello@queerpulse.com>',
    );
  });
});
