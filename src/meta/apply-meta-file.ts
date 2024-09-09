import { WriteTags } from 'exiftool-vendored';
import { readFile, utimes } from 'fs/promises';
import { MigrationContext } from '../dir/migrate-flat';
import { MediaFile } from '../media/MediaFile';
import { exhaustiveCheck } from '../ts';
import { GoogleMetadata } from './GoogleMeta';
import { MetaType } from './MetaType';
import {
  ApplyMetaError,
  ExifToolError,
  MissingMetaError,
  WrongExtensionError,
} from './apply-meta-errors';
import { execSync } from 'child_process';

export async function applyMetaFile(
  mediaFile: MediaFile,
  migCtx: MigrationContext,
): Promise<ApplyMetaError | null> {
  const metaJson = (await readFile(mediaFile.jsonPath)).toString();
  const meta: GoogleMetadata | undefined = JSON.parse(metaJson);

  // UTC time
  const timeTakenTimestamp = meta?.photoTakenTime?.timestamp;
  if (timeTakenTimestamp === undefined)
    return new MissingMetaError(mediaFile, 'photoTakenTime');
  const timeTaken = new Date(parseInt(timeTakenTimestamp) * 1000);

  // EXIF データから SubSecDateTimeOriginal を取得してタイムゾーン情報を確認
  let timeZoneOffset: string | null = null;
  let timeTakenLocal: string | null = null;

  try {
    // Use exiftool to get SubSecDateTimeOriginal with quotes around the file path
    console.log(`Running exiftool for file: ${mediaFile.path}`);
    const exifOutput = execSync(`exiftool -SubSecDateTimeOriginal "${mediaFile.path}"`).toString();
    console.log(`Exif output: ${exifOutput}`);
  
    const match = exifOutput.match(/(\d{4}:\d{2}:\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})([+\-]\d{2}:\d{2})/);
  
    if (match) {
      let datePart = match[1];  // Date part (YYYY:MM:DD)
      let timePart = match[2];  // Time part (HH:MM:SS.SSS)
      const timeZoneOffset = match[3];  // Time zone offset
  
      console.log(`Parsed datePart: ${datePart}, timePart: ${timePart}, timeZoneOffset: ${timeZoneOffset}`);
  
      // Convert 'YYYY:MM:DD' to 'YYYY-MM-DD' and append 'T' between date and time
      datePart = datePart.replace(/:/g, '-');
      const isoDateTime = `${datePart}T${timePart}${timeZoneOffset}`;
  
      // Manually create the date string to be written to EXIF
      const exifDateTime = `${match[1]} ${match[2]}${timeZoneOffset}`;
      console.log(`EXIF DateTime to be written: ${exifDateTime}`);
  
      if (exifDateTime) {
        // Write the manually created date string with time zone to EXIF
        timeTakenLocal = exifDateTime;
      } else {
        console.error('Invalid Date parsed from EXIF data');
      }
    } else {
      console.error('Failed to match SubSecDateTimeOriginal format');
    }
  } catch (error) {
    console.error('Failed to retrieve EXIF data', error);
  }

  const tags: WriteTags = {};

  if (timeTakenLocal) {
    // If time zone information is available
    tags.SubSecDateTimeOriginal = timeTakenLocal;
    tags.SubSecCreateDate = timeTakenLocal;
    tags.SubSecModifyDate = timeTakenLocal;
  } else {
    // If time zone information is not available, use UTC
    const timeTakenUTC = timeTaken.toISOString();
    tags.SubSecDateTimeOriginal = timeTakenUTC;
    tags.SubSecCreateDate = timeTakenUTC;
    tags.SubSecModifyDate = timeTakenUTC;
  }

  switch (mediaFile.ext.metaType) {
    case MetaType.EXIF:
      tags.SubSecDateTimeOriginal = timeTakenLocal || timeTaken.toISOString();
      tags.SubSecCreateDate = timeTakenLocal || timeTaken.toISOString();
      tags.SubSecModifyDate = timeTakenLocal || timeTaken.toISOString();
      break;
    case MetaType.QUICKTIME:
      tags.DateTimeOriginal = timeTakenLocal || timeTaken.toISOString();
      tags.CreateDate = timeTakenLocal || timeTaken.toISOString();
      tags.ModifyDate = timeTakenLocal || timeTaken.toISOString();
      tags.TrackCreateDate = timeTakenLocal || timeTaken.toISOString();
      tags.TrackModifyDate = timeTakenLocal || timeTaken.toISOString();
      tags.MediaCreateDate = timeTakenLocal || timeTaken.toISOString();
      tags.MediaModifyDate = timeTakenLocal || timeTaken.toISOString();
      break;
    case MetaType.NONE:
      break;
    default:
      exhaustiveCheck(mediaFile.ext.metaType);
  }

  tags.ModifyDate = timeTakenLocal || timeTaken.toISOString();

  // description
  const description = meta?.description;
  tags.Description = description;
  tags['Caption-Abstract'] = description;
  tags.ImageDescription = description;

  // gps
  const [alt, lat, lon] = [
    meta?.geoData?.altitude,
    meta?.geoData?.latitude,
    meta?.geoData?.longitude,
  ];
  if (![alt, lat, lon].some((axis) => axis === undefined)) {
    tags.GPSAltitude = alt;
    tags.GPSAltitudeRef = `${alt}`;
    tags.GPSLatitude = lat;
    tags.GPSLatitudeRef = `${lat}`;
    tags.GPSLongitude = lon;
    tags.GPSLongitudeRef = `${lon}`;
  }

  try {
    await migCtx.exiftool.write(mediaFile.path, tags, [
      '-overwrite_original',
      '-api',
      'quicktimeutc',
      '-api',
      'largefilesupport=1',
    ]);

    // Set file modification times to the photo taken timestamp
    await utimes(mediaFile.path, timeTaken, timeTaken);
  } catch (e) {
    if (e instanceof Error) {
      const wrongExtMatch = e.message.match(
        /Not a valid (?<current>\w+) \(looks more like a (?<actual>\w+)\)/,
      );
      const current = wrongExtMatch?.groups?.['current'];
      const actual = wrongExtMatch?.groups?.['actual'];
      if (current !== undefined && actual !== undefined) {
        return new WrongExtensionError(
          mediaFile,
          `.${current.toLowerCase()}`,
          `.${actual.toLowerCase()}`,
        );
      }
      return new ExifToolError(mediaFile, e);
    }
    return new ExifToolError(mediaFile, new Error(`${e}`));
  }

  return null;
}
