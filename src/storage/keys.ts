import { randomBytes } from "node:crypto";

/** Supplies the 32-byte key that encrypts everything we store on disk. */
export interface KeyProvider {
  /** Returns undefined when no secure place to keep a key is available. */
  getKey(): Promise<Buffer | undefined>;
  readonly description: string;
}

const SERVICE = "munch-food-concierge";
const ACCOUNT = "data-encryption-key";

/** Key lives in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
export class KeychainKeyProvider implements KeyProvider {
  readonly description = "OS keychain";
  private cached?: Buffer;

  async getKey(): Promise<Buffer | undefined> {
    if (this.cached) return this.cached;
    try {
      const { Entry } = await import("@napi-rs/keyring");
      const entry = new Entry(SERVICE, ACCOUNT);
      let b64 = entry.getPassword();
      if (!b64) {
        b64 = randomBytes(32).toString("base64");
        entry.setPassword(b64);
      }
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) return undefined;
      this.cached = key;
      return key;
    } catch {
      return undefined;
    }
  }
}

/** Fixed key, for tests. */
export class StaticKeyProvider implements KeyProvider {
  readonly description = "static key (tests)";
  constructor(private key: Buffer = randomBytes(32)) {}
  async getKey(): Promise<Buffer> {
    return this.key;
  }
}
