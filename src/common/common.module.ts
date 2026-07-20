import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { setImageUrlBase } from './image-url';

// Global so nothing has to import it. Its only job is to hand the statically
// configured API origin to `image-url.ts` once, at startup.
@Global()
@Module({})
export class CommonModule {
  constructor(private readonly config: ConfigService) {
    setImageUrlBase(
      this.config.get<string>('app.apiUrl', 'http://localhost:3000'),
    );
  }
}
