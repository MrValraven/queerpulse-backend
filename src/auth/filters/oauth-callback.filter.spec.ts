import { ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuthCallbackFilter } from './oauth-callback.filter';
import { OAuthCallbackError } from '../errors/oauth-callback.error';

describe('OAuthCallbackFilter', () => {
  it('redirects an OAuth failure to the frontend login with the error code', () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('https://app.example.com'),
    };
    const filter = new OAuthCallbackFilter(config as unknown as ConfigService);
    const redirect = jest.fn();
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ redirect }) }),
    } as unknown as ArgumentsHost;

    filter.catch(new OAuthCallbackError('access_denied'), host);

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/login?error=access_denied',
    );
  });
});
