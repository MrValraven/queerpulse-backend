import { IsBoolean, IsNotEmpty, IsString } from 'class-validator';

// `POST /account/email-preferences` persists ONE category toggle at a time —
// matches `updateEmailPreference(category, email)` in
// `features/settings/api/account.api.ts`, which posts `{ category, email }`
// (a single upsert), not a `Record<string, boolean>` map.
export class UpdateEmailPreferenceDto {
  @IsString()
  @IsNotEmpty()
  category: string;

  @IsBoolean()
  email: boolean;
}
