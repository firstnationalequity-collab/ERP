// File storage behind one interface (decision Q17): local disk now, an S3-compatible driver in M10.
// Keys are generated here (random), never derived from user file names, so no path can escape the root.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';

export interface FileStorage {
  readonly driver: 'local' | 's3';
  /** Store bytes under a new random key; returns the key. */
  put(bytes: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
}

const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}$/;

export class LocalDiskStorage implements FileStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathOf(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Invalid storage key ${key}`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Storage key escapes the storage root');
    return full;
  }

  async put(bytes: Buffer): Promise<string> {
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const full = this.pathOf(key);
    await mkdir(path.dirname(full), { recursive: true });
    // 'wx': never overwrite an existing file.
    await writeFile(full, bytes, { flag: 'wx' });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }
}

let current: FileStorage | undefined;

/** The configured storage. M10 switches on env to the S3 driver. */
export function storage(): FileStorage {
  current ??= new LocalDiskStorage(env.STORAGE_DIR);
  return current;
}
