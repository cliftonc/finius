import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Content-addressed blob storage for imported transcript files. Local-filesystem now; an
// R2/S3-backed implementation can satisfy the same interface for a Cloudflare deployment.
export interface BlobStore {
  save(key: string, bytes: string | Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  async save(key: string, bytes: string | Buffer): Promise<void> {
    const path = join(this.dir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  async read(key: string): Promise<Buffer | null> {
    const path = join(this.dir, key);
    return existsSync(path) ? readFileSync(path) : null;
  }
}
