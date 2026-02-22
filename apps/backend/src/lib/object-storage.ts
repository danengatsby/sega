import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { env } from '../config/env.js';
import { HttpError } from './http-error.js';

export interface ObjectStorageLocation {
  bucket: string;
  key: string;
}

let s3Client: S3Client | null = null;
const ensuredBuckets = new Set<string>();

function normalizeStorageError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Eroare necunoscută object storage.';
}

function isBucketAlreadyExistsError(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}

function getS3Client(): S3Client {
  if (!env.MINIO_ACCESS_KEY || !env.MINIO_SECRET_KEY) {
    throw HttpError.conflict('Object storage neconfigurat: setează MINIO_ACCESS_KEY și MINIO_SECRET_KEY.');
  }

  if (s3Client) {
    return s3Client;
  }

  s3Client = new S3Client({
    endpoint: env.MINIO_ENDPOINT,
    region: env.MINIO_REGION,
    forcePathStyle: env.MINIO_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.MINIO_ACCESS_KEY,
      secretAccessKey: env.MINIO_SECRET_KEY,
    },
  });

  return s3Client;
}

async function ensureBucketExists(bucket: string): Promise<void> {
  if (ensuredBuckets.has(bucket)) {
    return;
  }

  const client = getS3Client();

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    ensuredBuckets.add(bucket);
    return;
  } catch (headError) {
    if (!env.MINIO_AUTO_CREATE_BUCKETS) {
      throw new HttpError(502, `Bucket-ul ${bucket} nu este accesibil (${normalizeStorageError(headError)}).`, {
        expose: true,
      });
    }
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (createError) {
    if (!isBucketAlreadyExistsError(createError)) {
      throw new HttpError(502, `Nu am putut crea bucket-ul ${bucket} (${normalizeStorageError(createError)}).`, {
        expose: true,
      });
    }
  }

  ensuredBuckets.add(bucket);
}

export function buildS3Uri(location: ObjectStorageLocation): string {
  return `s3://${location.bucket}/${location.key}`;
}

export function parseS3Uri(value: string): ObjectStorageLocation | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('s3://')) {
    return null;
  }

  const payload = trimmed.slice('s3://'.length);
  const slashIndex = payload.indexOf('/');
  if (slashIndex <= 0 || slashIndex === payload.length - 1) {
    return null;
  }

  const bucket = payload.slice(0, slashIndex).trim();
  const key = payload.slice(slashIndex + 1).trim();
  if (!bucket || !key) {
    return null;
  }

  return { bucket, key };
}

export async function putObjectText(
  location: ObjectStorageLocation,
  body: string,
  contentType: string,
): Promise<void> {
  await ensureBucketExists(location.bucket);

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        Body: body,
        ContentType: contentType,
      }),
    );
  } catch (error) {
    throw new HttpError(
      502,
      `Nu am putut salva fișierul în object storage (${location.bucket}/${location.key}): ${normalizeStorageError(error)}`,
      { expose: true },
    );
  }
}

async function streamToUtf8(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function getObjectText(location: ObjectStorageLocation): Promise<string> {
  try {
    const output = await getS3Client().send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
      }),
    );

    const body = output.Body as
      | Readable
      | Uint8Array
      | string
      | {
          transformToString?: (encoding?: string) => Promise<string>;
        }
      | null
      | undefined;

    if (!body) {
      throw HttpError.notFound('Fișierul nu a fost găsit în object storage.');
    }

    if (typeof body === 'string') {
      return body;
    }

    if (body instanceof Uint8Array) {
      return Buffer.from(body).toString('utf8');
    }

    if (body instanceof Readable) {
      return streamToUtf8(body);
    }

    if (typeof body === 'object' && typeof body.transformToString === 'function') {
      return body.transformToString('utf-8');
    }

    throw new HttpError(502, 'Răspuns invalid de la object storage.', { expose: true });
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    const name = (error as { name?: string })?.name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      throw HttpError.notFound('Fișierul nu există în object storage.');
    }

    throw new HttpError(502, `Nu am putut citi fișierul din object storage: ${normalizeStorageError(error)}`, {
      expose: true,
    });
  }
}
