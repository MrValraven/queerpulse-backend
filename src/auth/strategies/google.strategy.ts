import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { GoogleUserInput } from '../auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('auth.googleClientId'),
      clientSecret: config.getOrThrow<string>('auth.googleClientSecret'),
      callbackURL: config.getOrThrow<string>('auth.googleCallbackUrl'),
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const { id, name, emails, photos } = profile;
    const email = emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account has no email'), undefined);
      return;
    }
    const result: GoogleUserInput = {
      googleId: id,
      email,
      firstName: name?.givenName ?? email.split('@')[0],
      lastName: name?.familyName ?? '',
      avatarUrl: photos?.[0]?.value ?? null,
    };
    done(null, result);
  }
}
