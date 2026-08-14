import { Type } from 'class-transformer';
import { IsNumber, IsString, Max, Min, ValidateNested } from 'class-validator';

export class CropRectDto {
  @IsNumber() @Min(0) @Max(1) x!: number;
  @IsNumber() @Min(0) @Max(1) y!: number;
  @IsNumber() @Min(0) @Max(1) width!: number;
  @IsNumber() @Min(0) @Max(1) height!: number;
  @IsString() aspect!: string;
}

export class SaveCropDto {
  @IsString() key!: string;

  @ValidateNested()
  @Type(() => CropRectDto)
  crop!: CropRectDto;
}
