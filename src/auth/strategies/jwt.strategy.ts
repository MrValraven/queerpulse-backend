import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';
import { CurrentUserData } from '../decorators/current-user.decorator';

const cookieExtractor: JwtFromRequestFunction = (req: Request) =>
  req?.cookies?.['access_token'] ?? null;

export interface AccessTokenPayload {
  sub: string;
  email: string;
  status: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
    });
  }

  validate(payload: AccessTokenPayload): CurrentUserData {
    // Signature + access-secret already verified by passport-jwt. This is a
    // shape check: reject anything missing the full access-token claim set so a
    // refresh token (only `{ sub, jti }`) — or any other token minted for a
    // different purpose — can never be replayed as an access token even if the
    // secrets were ever misconfigured to overlap.
    if (
      !payload?.sub ||
      !payload?.email ||
      !payload?.status ||
      !payload?.role
    ) {
      throw new UnauthorizedException('Malformed access token payload');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      status: payload.status,
      role: payload.role,
    };
  }
}
