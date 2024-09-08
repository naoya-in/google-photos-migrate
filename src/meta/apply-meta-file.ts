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
import { execSync } from 'child_process'; // Added to retrieve EXIF data

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

  // Retrieve SubSecDateTimeOriginal from EXIF data to get the time zone information
  let timeZoneOffset: string | null = null;
  let timeTakenLocal: string | null = null;

  try {
    // Use exiftool to get SubSecDateTimeOriginal
    const exifOutput = execSync(`exiftool -SubSecDateTimeOriginal "${mediaFile.path}"`).toString();
    const match = exifOutput.match(/(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}\.\d{3})([+\-]\d{2}:\d{2})/);
  
    if (match) {
      const dateTimeOriginal = match[1];  // DateTime part
      timeZoneOffset = match[2];  // Time zone offset
  
      // Parse the time using the time zone offset
      timeTakenLocal = new Date(`${dateTimeOriginal}${timeZoneOffset}`).toISOString();
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
