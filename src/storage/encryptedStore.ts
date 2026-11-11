import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyProvider } from "./keys.js";

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Small JSON documents, AES-256-GCM encrypted on disk, key from the OS keychain.
 * If no keychain is available nothing is written to disk: values live in memory
 * for this run only, and `persistent` is false so callers can tell the user.
 */
export class EncryptedStore {
  private memory = new Map<string, unknown>();
  private keyChecked = false;
  private key: Buffer | undefined;

  constructor(private dir: string, private keys: KeyProvider) {}

  private async loadKey(): Promise<Buffer | undefined> {
    if (!this.keyChecked) {
      this.key = await this.keys.getKey();
      this.keyChecked = true;
    }
    return this.key;
  }

  async persistent(): Promise<boolean> {
    return (await this.loadKey()) !== undefined;
  }

  private file(name: string): string {
    return join(this.dir, `${name.replace(/[^a-z0-9_-]/gi, "_")}.enc`);
  }

  async get<T>(name: string): Promise<T | undefined> {
    const key = await this.loadKey();
    if (!key) return this.memory.get(name) as T | undefined;
    let raw: string;
    try {
      raw = await readFile(this.file(name), "utf8");
    } catch {
      return undefined;
    }
    const env = JSON.parse(raw) as Envelope;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(env.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  }

  async set(name: string, value: unknown): Promise<void> {
    const key = await this.loadKey();
    if (!key) {
      this.memory.set(name, value);
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const env: Envelope = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file(name)}.tmp`;
    await writeFile(tmp, JSON.stringify(env), { mode: 0o600 });
    await rename(tmp, this.file(name));
  }

  async delete(name: string): Promise<void> {
    this.memory.delete(name);
    await rm(this.file(name), { force: true });
  }
}
