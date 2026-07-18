import { IsArray, IsIn, IsString, MinLength } from 'class-validator';

export type ExportFormat = 'json' | 'csv' | 'both';

export class RequestExportDto {
  @IsArray()
  @IsString({ each: true })
  categories: string[];

  @IsIn(['json', 'csv', 'both'])
  format: ExportFormat;

  // Required, matching DeactivateDto/RequestDeletionDto. An Art. 20 export is a
  // complete dump of everything we hold on a person, so it gets the same
  // step-up gate as the destructive flows rather than riding on the session
  // cookie alone. (The out-of-band emailed-link verification the UI copy
  // describes does not exist — there is no mail service — so this token is the
  // only real gate on the route.)
  @IsString()
  @MinLength(1)
  reauthToken: string;
}
