import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';

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

  validate(payload: AccessTokenPayload) {
    return {
      userId: payload.sub,
      email: payload.email,
      status: payload.status,
      role: payload.role,
    };
  }
}
