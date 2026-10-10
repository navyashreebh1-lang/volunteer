import { randomBytes } from 'node:crypto';
import { badRequest } from '../errors.js';
import { Photo } from '../models.js';

export interface PhotoStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const SIGNATURES: { contentType: string; ext: string; matches: (b: Buffer) => boolean }[] = [
  { contentType: 'image/jpeg', ext: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    contentType: 'image/png',
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    contentType: 'image/webp',
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Decides the file type from the bytes themselves; the client-supplied
 * filename and MIME type are ignored. Returns a server-generated storage key.
 */
export function inspectPhoto(data: Buffer, maxBytes: number): { key: string; contentType: string } {
  if (data.length === 0) throw badRequest('Profile photo is empty', { photo: 'The uploaded file is empty' });
  if (data.length > maxBytes) throw badRequest('Profile photo is too large', { photo: 'Photo is too large' });
  const type = SIGNATURES.find((s) => data.length >= 12 && s.matches(data));
  if (!type) throw badRequest('Unsupported profile photo', { photo: 'Photo must be a JPEG, PNG or WebP image' });
  return { key: `${randomBytes(16).toString('hex')}.${type.ext}`, contentType: type.contentType };
}

/**
 * Profile photos live in the `photos` collection of the application's MongoDB
 * database (they are capped at a few megabytes, well inside the document
 * limit), so the database is the only persistent store the app needs.
 */
export class MongoPhotoStorage implements PhotoStorage {
  async put(key: string, data: Buffer, contentType: string) {
    await Photo.create({ key, data, contentType });
  }

  async get(key: string) {
    const photo = await Photo.findOne({ key });
    return photo ? Buffer.from(photo.data) : null;
  }

  async remove(key: string) {
    await Photo.deleteOne({ key });
  }
}

export class MemoryPhotoStorage implements PhotoStorage {
  private files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}

export function createPhotoStorage(): PhotoStorage {
  return new MongoPhotoStorage();
}
