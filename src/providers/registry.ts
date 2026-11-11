import type { ProviderId } from "../core/types.js";
import type { SessionStore } from "../storage/sessions.js";
import type { ProviderAdapter } from "./ProviderAdapter.js";
import type { BrowserSessions } from "../browser/sessions.js";
import { MockAdapter } from "./mock/adapter.js";
import { UberEatsAdapter } from "./ubereats/adapter.js";

/** Apps we plan to support but have not built yet. Listed so the model can tell the user. */
export const PLANNED: { id: ProviderId; displayName: string; membership: string; note: string }[] = [
  { id: "ubereats", displayName: "Uber Eats", membership: "Uber One", note: "Experimental, off by default. The user can switch it on by starting the server with MUNCH_EXPERIMENTAL=ubereats." },
  { id: "doordash", displayName: "DoorDash", membership: "DashPass", note: "Planned (Phase 3)." },
  { id: "grubhub", displayName: "Grubhub", membership: "Grubhub+", note: "Planned (Phase 3)." },
  { id: "postmates", displayName: "Postmates", membership: "Uber One", note: "Planned (Phase 3). Shares inventory with Uber Eats and will be de-duplicated against it." },
];

export class ProviderRegistry {
  private adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }
  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }
  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

/** New providers get registered here. Nothing else in core needs to change. */
export function buildRegistry(opts: { sessions: SessionStore; browsers: BrowserSessions; enableMock: boolean; experimental: string[] }): ProviderRegistry {
  const reg = new ProviderRegistry();
  if (opts.enableMock) {
    reg.register(new MockAdapter("mockeats", opts.sessions));
    reg.register(new MockAdapter("mockdash", opts.sessions));
  }
  // Unfinished adapters stay out unless explicitly switched on.
  if (opts.experimental.includes("ubereats")) reg.register(new UberEatsAdapter(opts.browsers, opts.sessions));
  return reg;
}
