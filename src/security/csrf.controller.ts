import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';

@Public()
@Controller('csrf-token')
export class CsrfController {
  constructor(private readonly config: ConfigService) {}

  // GET is a safe method, so CsrfGuard lets it through; @Public skips JwtAuthGuard.
  @Get()
  issue(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const token = randomBytes(32).toString('hex');
    res.cookie('csrf_token', token, {
      httpOnly: false, // the SPA must read it to echo in the X-CSRF-Token header
      secure: this.config.get<string>('app.nodeEnv') === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return { csrfToken: token };
  }
}
