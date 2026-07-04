import { IsBooleanString, IsOptional } from 'class-validator';

export class ListTitlesQuery {
  // ?all=true — moderators/admins only: include drafts/processing/failed.
  @IsOptional()
  @IsBooleanString()
  all?: string;
}
