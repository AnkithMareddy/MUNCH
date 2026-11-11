import type { ProviderId, ProviderSession } from "../core/types.js";
import type { EncryptedStore } from "./encryptedStore.js";

/** Session metadata per provider. Cookies themselves live in the browser profile (real adapters). */
export class SessionStore {
  constructor(private store: EncryptedStore) {}

  private async all(): Promise<Record<string, ProviderSession>> {
    return (await this.store.get<Record<string, ProviderSession>>("sessions")) ?? {};
  }
  async get(id: ProviderId): Promise<ProviderSession | undefined> {
    return (await this.all())[id];
  }
  async set(s: ProviderSession): Promise<void> {
    await this.store.set("sessions", { ...(await this.all()), [s.provider]: s });
  }
  async delete(id: ProviderId): Promise<void> {
    const all = await this.all();
    delete all[id];
    await this.store.set("sessions", all);
  }
}
