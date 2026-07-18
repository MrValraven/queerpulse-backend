import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { DeletionRequest } from '../account/entities/deletion-request.entity';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { UsersModule } from '../users/users.module';
import { MembershipModule } from '../membership/membership.module';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthMaintenanceService } from './auth-maintenance.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    MembershipModule,
    PassportModule,
    // User: JwtStrategy re-reads status/role per request so bans take effect
    // immediately rather than lagging by the access-token TTL.
    // EmailSuppression: the erasure suppression list, consulted on the
    // new-account signup path. Owned by `src/account` (which writes it during
    // erasure); registered here read-side only, the same way `AccountModule`
    // registers `RefreshToken`.
    // AccountDeactivation / DeletionRequest: the reactivate-on-sign-in path
    // (`AuthService.reactivateIfDeactivated`) needs to tell a reversible
    // pause apart from a pending erasure — only the former is undone by
    // signing in. Read-side registration, same pattern as EmailSuppression.
    TypeOrmModule.forFeature([
      RefreshToken,
      User,
      EmailSuppression,
      AccountDeactivation,
      DeletionRequest,
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtAccessSecret'),
        signOptions: {
          expiresIn: config.get<string>(
            'auth.jwtAccessTtl',
            '15m',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthMaintenanceService, GoogleStrategy, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
