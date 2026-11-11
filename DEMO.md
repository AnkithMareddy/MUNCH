# Demo: from "I'm hungry" to the checkout handoff

This is a script of one conversation against the **demo providers** (fake data). The wording of the concierge's lines will vary by model. Every number and tool result below is what the server actually returns: run `npm run harness:smoke` to see the same figures.

To try it live: `npm run harness:claude` or `npm run harness:openai` (API key needed), or connect the server to Claude Desktop (see the README).

---

**You:** I'm hungry.

> *tools:* `get_preferences` → nothing saved yet · `list_providers` → MockEats and MockDash, both disconnected

**Concierge:** Let's fix that. First, which delivery apps do you use? I can connect MockEats and MockDash. You'll sign in yourself in a browser window; I never see your password.

**You:** Both.

> *tools:* `connect_provider("mockeats")` → connected · `connect_provider("mockdash")` → connected

**Concierge:** Both connected. What are you in the mood for, and where should it go?

**You:** Thai, delivered to 1 Demo Plaza in Brooklyn. Two of us, around $60 all-in.

**Concierge:** Got it. Two quick things so I price it right: do you have MockEats One or MockPass? And do you want real restaurants only, or should I include ghost kitchens (delivery-only brands) with a label?

**You:** I have MockPass. Real restaurants only.

> *tools:* `save_preferences({ default_address, exclude_ghost_kitchens: true, memberships: { mockdash: true } })`
> `search({ query: "thai" })` → Thai Orchid on MockEats (4.7★, ~35 min) and "Thai Orchid Restaurant" on MockDash (4.6★, ~40 min), same `match_group`

**Concierge:** Saved for next time. **Thai Orchid** is on both apps (4.7★, about 35–40 min). Their menu has Pad Thai, Green Curry, Vegetable Spring Rolls and Thai Iced Tea. What would you like?

**You:** Two pad thai with shrimp and an order of spring rolls.

**Concierge:** And what tip would you like to leave? A percent or a dollar amount works.

**You:** 15%.

> *tools, one app at a time:*
> `build_cart(mockeats, …)` → mapped; note: "spring rolls" matched "Vegetable Spring Rolls" approximately
> `quote_cart(…, tip 15%)` → **$62.71**, verified
> `build_cart(mockdash, …)` → mapped; notes: "pad thai" matched "Phad Thai Noodles" approximately, "spring rolls" matched "Crispy Veggie Spring Rolls" approximately
> `quote_cart(…, tip 15%)` → **$54.86**, verified
> `compare([both], budget $60)`

**Concierge:** Same order on both apps. One note: MockDash calls the dishes "Phad Thai Noodles" and "Crispy Veggie Spring Rolls"; they look like the same items.

| # | App | Restaurant | Subtotal | Fees | Tax | Discounts | Tip | **All-in total** | ETA | Rating | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | MockDash (demo) | Thai Orchid Restaurant | $46.45 | $6.56 | $4.12 | -$9.24 | $6.97 | **$54.86** | ~40 min | 4.6 | Lowest all-in total; $9.24 in discounts applied. |
| 2 | MockEats (demo) | Thai Orchid | $43.00 | $9.44 | $3.82 | — | $6.45 | **$62.71** | ~35 min | 4.7 | $7.85 more than the cheapest; fastest; top rated (4.7); over budget by $2.71. |

**Order from Thai Orchid Restaurant on MockDash: $54.86 all-in, ~40 min. That's $7.85 cheaper than the next best (MockEats).** MockDash's menu prices are higher, but your MockPass and a "$5 off $30+" promo more than make up for it.

**You:** What if I care more about speed?

> *tool:* `compare([both], weights: { total: 0.1, eta: 0.9 })`

**Concierge:** Then MockEats wins: about 5 minutes faster, for $7.85 more ($62.71, which is over your $60 budget).

**You:** Not worth it. Go with MockDash.

**Concierge:** Here's the final total on MockDash:

```
2 × Phad Thai Noodles (Shrimp)    $38.90
1 × Crispy Veggie Spring Rolls     $7.55
Subtotal                          $46.45
Delivery fee                       $0.99
Service fee                        $5.57
Tax                                $4.12
MockPass: $0 delivery fee         -$0.99
MockPass: reduced service fee     -$3.25
$5 off orders $30+                -$5.00
Tip (15% of subtotal)              $6.97
TOTAL                             $54.86
```

Want me to open checkout?

**You:** Yes.

> *tool:* `open_checkout(cart)` → checkout URL

**Concierge:** MockDash's checkout is ready with your cart filled in. Review it there and tap **Place order** yourself. Nothing has been ordered yet, and the app's own total is the final one.

---

## Variations worth trying

- **Ghost kitchens:** ask for "wings" and say you want to see everything. Wing Mania comes back flagged: *"3 different brands deliver from the same address (500 Industrial Way): also Pasqually's Pizza & Wings, Pasta Planet."* Pasqually's is also flagged as a known virtual brand.
- **Estimates:** order a "harvest grain bowl" from Green Bowl. MockDash hides tax for that store, so its total comes back as `~$… (estimate)` with the reason, and the comparison warns about it.
- **No tip given:** skip the tip. Quotes come back "before tip" and the concierge has to ask.
- **Direct ordering:** start the server with `MUNCH_ENABLE_PLACE_ORDER=1` and ask it to place the order. You get a confirmation dialog (or a local confirm page) showing the itemized total; only your yes produces the one-time token.
