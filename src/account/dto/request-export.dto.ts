import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export type ExportFormat = 'json' | 'csv' | 'both';

export class RequestExportDto {
  @IsArray()
  @IsString({ each: true })
  categories: string[];

  @IsIn(['json', 'csv', 'both'])
  format: ExportFormat;

  // Optional — Art. 20 export is verified out-of-band by an emailed link in
  // the real flow, so a step-up token isn't required here (mirrors the
  // frontend's `RequestExportDto.reauthToken?`).
  @IsOptional()
  @IsString()
  reauthToken?: string;
}
