# TLC robot shopper

Synthetic checkout monitor for thelasercraft.co. Every 30 minutes it takes the
top products through the Design Center on a phone and a laptop, uploads art,
taps Add to cart, confirms the storefront cart loads with the item, then clicks
Checkout and requires the Shopify checkout page to answer HTTP 200 with a
checkout form and the cart's subtotal. The full catalog runs nightly, plus the
**bulk-quote pay check**: it POSTs `/api/bulk-quote/<token>/pay` for the internal
test quote `BQ-ROBOTPAY` (no email on it; token in the `ROBOT_BULK_QUOTE_TOKEN`
secret). The server re-runs the catalogue rebuild + Shopify draft-order update,
which fails if the quote's variant ids have gone stale, and the robot loads the
Shopify invoice checkout it redirects to. It never pays or places an order.
Failures there alert right away (it has already retried once in-run), and stay
open until the next nightly run passes.

- Identifies itself with a `tlc_robot` cookie so its designs are auto-deleted
  and its clicks are excluded from analytics (design-center `src/lib/robot-shopper.ts`).
- Blocks every ad/analytics pixel, so it never counts as a shopper.
- A failure is retried once; two in a row opens a `robot-down` issue and emails
  hello@thelasercraft.co. Recovery closes the issue and sends one all-clear.

Products live in `products.json`. Local run: `npm ci && npx playwright install chromium && ROBOT_ONLY=drinkware node robot.mjs`
