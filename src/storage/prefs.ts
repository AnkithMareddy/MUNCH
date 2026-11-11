import { UserPreferences } from "../core/types.js";
import type { EncryptedStore } from "./encryptedStore.js";

export class PrefsStore {
  constructor(private store: EncryptedStore) {}

  async get(): Promise<UserPreferences> {
    const parsed = UserPreferences.safeParse((await this.store.get("preferences")) ?? {});
    return parsed.success ? parsed.data : {};
  }

  /** Merges a partial update. A null value clears that preference. */
  async update(patch: Record<string, unknown>): Promise<UserPreferences> {
    const next: Record<string, unknown> = { ...(await this.get()) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else if (v !== undefined) next[k] = k === "memberships" ? { ...(next.memberships as object), ...(v as object) } : v;
    }
    const valid = UserPreferences.parse(next);
    await this.store.set("preferences", valid);
    return valid;
  }
}
