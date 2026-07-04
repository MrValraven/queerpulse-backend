import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: exposes req.rawBody for HMAC-verified webhooks (Mux).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  // Security middleware before routes.
  app.use(cookieParser());
  app.use(helmet());

  const frontendUrl = configService.get<string>(
    'app.frontendUrl',
    'http://localhost:5173',
  );
  const origins = Array.from(new Set([frontendUrl, 'http://localhost:5173']));
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port);
}
bootstrap();
