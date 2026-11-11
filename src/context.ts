import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserSessions } from "./browser/sessions.js";
import { ConfirmationService } from "./core/confirm.js";
import type { Cart, MenuItem, Quote, Restaurant, TipInput } from "./core/types.js";
import { buildRegistry, type ProviderRegistry } from "./providers/registry.js";
import { EncryptedStore } from "./storage/encryptedStore.js";
import { KeychainKeyProvider, type KeyProvider } from "./storage/keys.js";
import { PrefsStore } from "./storage/prefs.js";
import { SessionStore } from "./storage/sessions.js";
import { createLogger, type Logger } from "./util/logger.js";
import { Throttle, TtlCache } from "./util/throttle.js";

export interface Config {
  dataDir: string;
  enableMock: boolean;
  /** Feature flag for place_order. Off unless MUNCH_ENABLE_PLACE_ORDER=1. */
  enablePlaceOrder: boolean;
  /** Unfinished providers switched on with MUNCH_EXPERIMENTAL=ubereats,... */
  experimental: string[];
}

export function defaultDataDir(): string {
  if (process.env.MUNCH_DATA_DIR) return process.env.MUNCH_DATA_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "munch");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "munch");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "munch");
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: defaultDataDir(),
    // Phase 1 ships only demo providers, so they are on by default. Set MUNCH_MOCK=0 to hide them.
    enableMock: env.MUNCH_MOCK !== "0",
    enablePlaceOrder: env.MUNCH_ENABLE_PLACE_ORDER === "1",
    experimental: (env.MUNCH_EXPERIMENTAL ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export interface CartRecord {
  cart: Cart;
  restaurant?: Restaurant;
  lastQuote?: Quote;
  lastTip?: TipInput;
}

export interface AppContext {
  config: Config;
  log: Logger;
  registry: ProviderRegistry;
  browsers: BrowserSessions;
  store: EncryptedStore;
  prefs: PrefsStore;
  sessions: SessionStore;
  confirm: ConfirmationService;
  throttle: Throttle;
  menuCache: TtlCache<MenuItem[]>;
  searchCache: TtlCache<Restaurant[]>;
  /** In-memory only. Carts and quotes do not outlive the process. */
  carts: Map<string, CartRecord>;
  quotes: Map<string, Quote>;
  /** Restaurants seen in searches this run, with ghost-kitchen and match info. */
  seen: Map<string, Restaurant>;
}

export function createContext(overrides: Partial<Config> & { keys?: KeyProvider; log?: Logger } = {}): AppContext {
  const config = { ...configFromEnv(), ...overrides };
  const store = new EncryptedStore(config.dataDir, overrides.keys ?? new KeychainKeyProvider());
  const sessions = new SessionStore(store);
  const browsers = new BrowserSessions(join(config.dataDir, "profiles"));
  return {
    config,
    log: overrides.log ?? createLogger(),
    registry: buildRegistry({ sessions, browsers, enableMock: config.enableMock, experimental: config.experimental }),
    browsers,
    store,
    prefs: new PrefsStore(store),
    sessions,
    confirm: new ConfirmationService(),
    // Real sites get a few seconds between page loads. Demo providers need none.
    throttle: new Throttle((key) => (key.startsWith("mock") ? 0 : 2500)),
    menuCache: new TtlCache(10 * 60 * 1000),
    searchCache: new TtlCache(5 * 60 * 1000),
    carts: new Map(),
    quotes: new Map(),
    seen: new Map(),
  };
}
