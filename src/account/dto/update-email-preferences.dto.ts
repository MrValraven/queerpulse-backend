import { IsBoolean, IsIn, IsString } from 'class-validator';
import { DEFAULT_EMAIL_PREFERENCES } from '../account.constants';

// `POST /account/email-preferences` persists ONE category toggle at a time —
// matches `updateEmailPreference(category, email)` in
// `features/settings/api/account.api.ts`, which posts `{ category, email }`
// (a single upsert), not a `Record<string, boolean>` map.
export class UpdateEmailPreferenceDto {
  // Range-checked against the default matrix rather than accepting any
  // non-empty string: `updateEmailPreference` upserts a row for whatever
  // arrives, and an unknown category is a row nothing ever reads back
  // (`getEmailPreferences` only walks `DEFAULT_EMAIL_PREFERENCES`) — i.e.
  // unbounded table growth from one account, with no user-visible effect.
  @IsString()
  @IsIn(Object.keys(DEFAULT_EMAIL_PREFERENCES))
  category!: string;

  @IsBoolean()
  email!: boolean;
}
