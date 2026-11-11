import type { BrowserContext } from "playwright";
import type { SiteLogin } from "../../browser/login.js";
import type { ReportOptions } from "../../browser/recorder.js";

/**
 * What we know about ubereats.com. Items marked CONFIRMED were seen in a real
 * recording (npm run record -- ubereats). Anything marked UNVERIFIED was not.
 */
export const UBEREATS = {
  homeUrl: "https://www.ubereats.com/",
  /** UNVERIFIED: expected to redirect to Uber's sign-in. Falls back to the home page if it doesn't load. */
  loginUrl: "https://www.ubereats.com/login-redirect/",
  /** CONFIRMED: the web app's own JSON calls are POSTs to /_p/api/<name>. */
  apiPattern: /^https:\/\/([a-z0-9-]+\.)?ubereats\.com\/(_p\/)?api\//,
  cookieDomains: ["https://www.ubereats.com", "https://auth.uber.com"],
  /** CONFIRMED: `sid` is set by signing in. */
  loginCookies: ["sid"],
};

export function ubereatsLogin(site = UBEREATS): SiteLogin {
  return {
    provider: "ubereats",
    homeUrl: site.homeUrl,
    loginUrl: site.loginUrl,
    async isLoggedIn(context: BrowserContext): Promise<boolean> {
      const cookies = await context.cookies(site.cookieDomains);
      return cookies.some((c) => site.loginCookies.includes(c.name) && c.value !== "");
    },
  };
}

/**
 * Which recorded data may appear with example values in a recording report.
 * Restaurant, menu and fee data only. Nothing about the account or address.
 */
export const UBEREATS_REPORT: ReportOptions = {
  dropKeys: /tracking|analytics|image|icon|lottie|illustration|seoMeta|metaJson|review|timeWindowPicker|breadcrumbs|exploreMoreStores|categoryLinks|^hours$|groupOrder|storeAd|storyIcon|mapMarker|backgroundColor|upsell|neutralZone|giftInfo|sectionHoursInfo|nutritional/i,
  samples: [
    { endpoint: /getFeedV1$|getSearchFeedV1$|getSearchSuggestionsV1$/, part: "request" },
    { endpoint: /getFeedV1$|getSearchFeedV1$|getSearchSuggestionsV1$/, part: "response", paths: ["data.feedItems", "data.storesMap", "data.diningModes", "data.meta", "data.currencyCode"] },
    { endpoint: /getStoreV1$/, part: "request", paths: ["diningMode", "time", "cbType"] },
    { endpoint: /getStoreV1$/, part: "response" },
    { endpoint: /getMenuItemV1$/, part: "request", paths: ["itemRequestType", "diningMode", "isEditFlow", "cbType"] },
    { endpoint: /getMenuItemV1$/, part: "response" },
    { endpoint: /addItemsToDraftOrderV2$|removeItemsFromDraftOrderV2$|updateItemInDraftOrderV2$|createDraftOrderV2$/, part: "request", paths: ["items", "actionMeta", "shoppingCartItems", "diningMode", "isMulticart"] },
    { endpoint: /addItemsToDraftOrderV2$/, part: "response", paths: ["data.addedItems"] },
    { endpoint: /getDraftOrderByUuidV1$/, part: "response", paths: ["data.shoppingCart.items", "data.state", "data.diningMode", "data.deliveryType", "data.upfrontTipOption", "data.promotionOptions"] },
    {
      endpoint: /getCheckoutPresentationV1$/,
      part: "response",
      paths: ["subtotal", "total", "fareBreakdown", "subTotalFareBreakdown", "eta", "upfrontTipping", "promotion", "passBanner", "basketSizeTracker", "disclaimers", "cartItems", "merchantMembership"].map((k) => `data.checkoutPayloads.${k}`),
    },
    { endpoint: /getCheckoutPresentationV1$/, part: "request", paths: ["payloadTypes", "isGroupOrder"] },
    { endpoint: /getUserV1$/, part: "response", paths: ["data.isLoggedIn", "data.subscriptionMeta"] },
  ],
};
