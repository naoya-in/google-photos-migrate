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

// Global variable to manage the time zone offset (in hours)
// For JST (UTC+9), set this to 9. For other time zones, adjust accordingly.
const timeZoneOffsetHours = 9;  // You can modify this value to suit your needs

// Helper function to format the time zone offset as a string (e.g., "+09:00")
function formatTimeZoneOffset(offsetHours: number): string {
  const sign = offsetHours >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetHours);
  const hours = String(Math.floor(absOffset)).padStart(2, '0');
  const minutes = String((absOffset % 1) * 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export async function applyMetaFile(
  mediaFile: MediaFile,
  migCtx: MigrationContext,
): Promise<ApplyMetaError | null> {
  const metaJson = (await readFile(mediaFile.jsonPath)).toString();
  const meta: GoogleMetadata | undefined = JSON.parse(metaJson);

  // UTC time from the JSON metadata
  const timeTakenTimestamp = meta?.photoTakenTime?.timestamp;
  if (timeTakenTimestamp === undefined)
    return new MissingMetaError(mediaFile, 'photoTakenTime');
  const timeTaken = new Date(parseInt(timeTakenTimestamp) * 1000);

  // Default time zone offset
  const defaultTimeZoneOffset = formatTimeZoneOffset(timeZoneOffsetHours);

  // EXIF データから SubSecDateTimeOriginal を取得してタイムゾーン情報を確認
  let timeZoneOffset: string | null = null;
  let timeTakenLocal: string | null = null;

  try {
    // Use exiftool to get SubSecDateTimeOriginal with quotes around the file path
    console.log(`Running exiftool for file: ${mediaFile.path}`);
    const exifOutput = execSync(`exiftool -SubSecDateTimeOriginal "${mediaFile.path}"`).toString();
    console.log(`Exif output: ${exifOutput}`);
  
    // Match patterns with or without time zone information
    const match = exifOutput.match(/(\d{4}:\d{2}:\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+\-]\d{2}:\d{2})?/);
  
    if (match) {
      let datePart = match[1];  // Date part (YYYY:MM:DD)
      let timePart = match[2];  // Time part (HH:MM:SS.SSS or HH:MM:SS)
      timeZoneOffset = match[3] || defaultTimeZoneOffset;  // Use the extracted time zone offset, or fall back to default

      console.log(`Parsed datePart: ${datePart}, timePart: ${timePart}, timeZoneOffset: ${timeZoneOffset}`);
  
      // Convert 'YYYY:MM:DD' to 'YYYY-MM-DD'
      datePart = datePart.replace(/:/g, '-');
  
      // Manually create the date string to be written to EXIF
      const exifDateTime = `${datePart} ${timePart}${timeZoneOffset}`;
      console.log(`EXIF DateTime to be written: ${exifDateTime}`);
  
      timeTakenLocal = exifDateTime;
    } else {
      console.error('Failed to match SubSecDateTimeOriginal format, using default time zone');
    }
  } catch (error) {
    console.error('Failed to retrieve EXIF data, using default time zone', error);
  }

  // If SubSecDateTimeOriginal wasn't available, use the default time zone
  if (!timeTakenLocal) {
    const adjustedTime = new Date(timeTaken.getTime() + timeZoneOffsetHours * 60 * 60 * 1000);  // Adjust UTC time
    const adjustedTimeString = adjustedTime.toISOString().split('.')[0];  // Remove milliseconds
    timeTakenLocal = adjustedTimeString.replace('T', ' ') + defaultTimeZoneOffset;  // Convert to 'YYYY-MM-DD HH:MM:SS+09:00'
    console.log(`Using default time zone for DateTime: ${timeTakenLocal}`);
  }

  const tags: WriteTags = {};

  if (timeTakenLocal) {
    // If time zone information is available
    tags.SubSecDateTimeOriginal = timeTakenLocal;
    tags.SubSecCreateDate = timeTakenLocal;
    tags.SubSecModifyDate = timeTakenLocal;
  }

  switch (mediaFile.ext.metaType) {
    case MetaType.EXIF:
      tags.SubSecDateTimeOriginal = timeTakenLocal;
      tags.SubSecCreateDate = timeTakenLocal;
      tags.SubSecModifyDate = timeTakenLocal;
      break;
    case MetaType.QUICKTIME:
      tags.DateTimeOriginal = timeTakenLocal;
      tags.CreateDate = timeTakenLocal;
      tags.ModifyDate = timeTakenLocal;
      tags.TrackCreateDate = timeTakenLocal;
      tags.TrackModifyDate = timeTakenLocal;
      tags.MediaCreateDate = timeTakenLocal;
      tags.MediaModifyDate = timeTakenLocal;
      break;
    case MetaType.NONE:
      break;
    default:
      exhaustiveCheck(mediaFile.ext.metaType);
  }

  tags.ModifyDate = timeTakenLocal;

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
