/** Fake restaurants in a made-up neighborhood. Nothing here is real pricing. */

export interface MockItem {
  slug: string;
  name: string;
  /** Per-app name override, to exercise fuzzy menu matching. */
  altName?: string;
  price: number;
  category: string;
  tags?: string[];
  modifiers?: { name: string; required?: boolean; options: [name: string, delta: number][] }[];
}

export interface MockRestaurant {
  slug: string;
  name: string;
  /** Name as the second app lists it. */
  altName?: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
  cuisines: string[];
  description?: string;
  rating: number;
  ratingCount: number;
  eta: number;
  pickup: boolean;
  /** Which mock apps list it. */
  on: ("mockeats" | "mockdash")[];
  /** If set, that app's checkout hides tax until the last step, so the quote is an estimate. */
  taxHiddenOn?: "mockeats" | "mockdash";
  items: MockItem[];
}

const size = { name: "Size", required: true, options: [['12" Small', 0], ['16" Large', 600]] as [string, number][] };

export const RESTAURANTS: MockRestaurant[] = [
  {
    slug: "luigis", name: "Luigi's Pizzeria", altName: "Luigis Pizzeria - Court St",
    address: "123 Court Street, Brooklyn, NY 11201", lat: 40.6895, lng: -73.9925, phone: "(718) 555-0101",
    cuisines: ["pizza", "italian"], rating: 4.6, ratingCount: 1200, eta: 30, pickup: true, on: ["mockeats", "mockdash"],
    items: [
      { slug: "margherita", name: "Margherita Pizza", altName: "Pizza Margherita", price: 1600, category: "Pizza", tags: ["vegetarian"], modifiers: [size] },
      { slug: "pepperoni", name: "Pepperoni Pizza", price: 1800, category: "Pizza", modifiers: [size] },
      { slug: "knots", name: "Garlic Knots", altName: "Garlic Knots (6 pc)", price: 600, category: "Sides", tags: ["vegetarian"] },
      { slug: "caesar", name: "Caesar Salad", price: 1100, category: "Salads" },
    ],
  },
  {
    slug: "thai-orchid", name: "Thai Orchid", altName: "Thai Orchid Restaurant",
    address: "88 Smith St, Brooklyn, NY 11201", lat: 40.6878, lng: -73.9903, phone: "(718) 555-0102",
    cuisines: ["thai", "noodles", "asian"], rating: 4.7, ratingCount: 860, eta: 35, pickup: true, on: ["mockeats", "mockdash"],
    items: [
      {
        slug: "pad-thai", name: "Pad Thai", altName: "Phad Thai Noodles", price: 1500, category: "Noodles",
        modifiers: [
          { name: "Protein", required: true, options: [["Chicken", 0], ["Tofu", 0], ["Shrimp", 300]] },
          { name: "Spice Level", options: [["Mild", 0], ["Medium", 0], ["Thai Hot", 0]] },
        ],
      },
      { slug: "green-curry", name: "Green Curry", price: 1600, category: "Curries", tags: ["gluten_free"], modifiers: [{ name: "Protein", required: true, options: [["Chicken", 0], ["Tofu", 0], ["Shrimp", 300]] }] },
      { slug: "spring-rolls", name: "Vegetable Spring Rolls", altName: "Crispy Veggie Spring Rolls", price: 700, category: "Starters", tags: ["vegan", "vegetarian"] },
      { slug: "thai-tea", name: "Thai Iced Tea", price: 500, category: "Drinks", tags: ["vegetarian"] },
    ],
  },
  {
    slug: "burger-barn", name: "Burger Barn",
    address: "240 Atlantic Ave, Brooklyn, NY 11201", lat: 40.6884, lng: -73.9891, phone: "(718) 555-0103",
    cuisines: ["burgers", "american"], rating: 4.4, ratingCount: 540, eta: 25, pickup: true, on: ["mockeats"],
    items: [
      { slug: "classic", name: "Classic Cheeseburger", price: 1300, category: "Burgers", modifiers: [{ name: "Add-ons", options: [["Bacon", 250], ["Avocado", 200]] }] },
      { slug: "veggie", name: "Veggie Burger", price: 1250, category: "Burgers", tags: ["vegetarian"] },
      { slug: "fries", name: "French Fries", price: 500, category: "Sides", tags: ["vegan", "vegetarian"] },
    ],
  },
  {
    slug: "green-bowl", name: "Green Bowl", altName: "Green Bowl Salads & Grains",
    address: "15 Bergen St, Brooklyn, NY 11201", lat: 40.6869, lng: -73.9912, phone: "(718) 555-0104",
    cuisines: ["salads", "healthy", "vegan"], rating: 4.5, ratingCount: 410, eta: 20, pickup: true, on: ["mockeats", "mockdash"], taxHiddenOn: "mockdash",
    items: [
      { slug: "harvest", name: "Harvest Grain Bowl", price: 1400, category: "Bowls", tags: ["vegan", "vegetarian"] },
      { slug: "kale-caesar", name: "Kale Caesar", price: 1300, category: "Salads", tags: ["vegetarian"] },
      { slug: "lentil-soup", name: "Lentil Soup", price: 700, category: "Soups", tags: ["vegan", "vegetarian", "gluten_free"] },
    ],
  },
  {
    slug: "sakura", name: "Sakura Sushi", altName: "Sakura Sushi (Boerum Hill)",
    address: "301 Hoyt St, Brooklyn, NY 11231", lat: 40.6836, lng: -73.9905, phone: "(718) 555-0105",
    cuisines: ["sushi", "japanese", "asian"], rating: 4.8, ratingCount: 2100, eta: 45, pickup: false, on: ["mockeats", "mockdash"],
    items: [
      { slug: "salmon-roll", name: "Salmon Avocado Roll", price: 900, category: "Rolls" },
      { slug: "spicy-tuna", name: "Spicy Tuna Roll", price: 950, category: "Rolls" },
      { slug: "edamame", name: "Edamame", price: 600, category: "Starters", tags: ["vegan", "vegetarian", "gluten_free"] },
      { slug: "miso", name: "Miso Soup", price: 400, category: "Starters" },
    ],
  },
  // Three delivery-only brands sharing one commissary address: the ghost-kitchen case.
  {
    slug: "wing-mania", name: "Wing Mania",
    address: "500 Industrial Way, Unit 4, Brooklyn, NY 11232", lat: 40.6601, lng: -74.0012,
    cuisines: ["wings", "american"], rating: 4.1, ratingCount: 95, eta: 28, pickup: false, on: ["mockeats", "mockdash"],
    items: [
      { slug: "wings-10", name: "10 Piece Wings", price: 1400, category: "Wings", modifiers: [{ name: "Sauce", required: true, options: [["Buffalo", 0], ["BBQ", 0], ["Lemon Pepper", 0]] }] },
      { slug: "fries", name: "Seasoned Fries", price: 500, category: "Sides", tags: ["vegetarian"] },
    ],
  },
  {
    slug: "pasqually", name: "Pasqually's Pizza & Wings",
    address: "500 Industrial Way, Brooklyn, NY 11232", lat: 40.6601, lng: -74.0012,
    cuisines: ["pizza", "wings"], rating: 4.0, ratingCount: 60, eta: 30, pickup: false, on: ["mockeats", "mockdash"],
    items: [
      { slug: "cheese", name: "Cheese Pizza", price: 1300, category: "Pizza", tags: ["vegetarian"] },
      { slug: "pepperoni", name: "Pepperoni Pizza", price: 1500, category: "Pizza" },
    ],
  },
  {
    slug: "pasta-planet", name: "Pasta Planet", description: "Delivery only. Fresh pasta bowls made to order.",
    address: "500 Industrial Way, Brooklyn, NY 11232", lat: 40.6601, lng: -74.0012,
    cuisines: ["pasta", "italian"], rating: 4.2, ratingCount: 70, eta: 32, pickup: false, on: ["mockdash"],
    items: [
      { slug: "alfredo", name: "Fettuccine Alfredo", price: 1400, category: "Pasta", tags: ["vegetarian"] },
      { slug: "bolognese", name: "Spaghetti Bolognese", price: 1500, category: "Pasta" },
    ],
  },
];

export interface MockAppConfig {
  id: "mockeats" | "mockdash";
  displayName: string;
  membershipName: string;
  /** Menu price multiplier. Delivery apps often mark up menu prices differently. */
  markup: number;
  deliveryFee: number;
  servicePct: number;
  serviceMin: number;
  smallOrderUnder: number;
  smallOrderFee: number;
  etaOffset: number;
  promo?: { label: string; minSubtotal: number; amount: number };
  membership: { freeDeliveryOver: number; servicePct: number };
}

export const APPS: Record<"mockeats" | "mockdash", MockAppConfig> = {
  mockeats: {
    id: "mockeats", displayName: "MockEats (demo)", membershipName: "MockEats One", markup: 1.0,
    deliveryFee: 299, servicePct: 15, serviceMin: 200, smallOrderUnder: 1200, smallOrderFee: 200, etaOffset: 0,
    membership: { freeDeliveryOver: 1500, servicePct: 10 },
  },
  mockdash: {
    id: "mockdash", displayName: "MockDash (demo)", membershipName: "MockPass", markup: 1.08,
    deliveryFee: 99, servicePct: 12, serviceMin: 150, smallOrderUnder: 1500, smallOrderFee: 250, etaOffset: 5,
    promo: { label: "$5 off orders $30+", minSubtotal: 3000, amount: 500 },
    membership: { freeDeliveryOver: 1200, servicePct: 5 },
  },
};

export const TAX_RATE_PCT = 8.875;
