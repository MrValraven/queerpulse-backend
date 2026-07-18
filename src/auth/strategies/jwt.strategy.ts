import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
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
  constructor(
    config: ConfigService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtAccessSecret'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<CurrentUserData> {
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

    // Re-read status/role from the DB rather than trusting the claims. They are
    // baked in at sign time, so a token minted before a ban or a demotion would
    // otherwise carry the old privileges until it expired — moderation would
    // silently lag by the access-token TTL. One indexed PK lookup per request is
    // the cost of making a ban take effect immediately.
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: { id: true, email: true, status: true, role: true },
    });
    if (!user) {
      // Deleted user holding a still-valid token.
      throw new UnauthorizedException('User no longer exists');
    }

    return {
      userId: user.id,
      email: user.email,
      status: user.status,
      role: user.role,
    };
  }
}
