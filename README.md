# TLC robot shopper

Synthetic checkout monitor for thelasercraft.co. Every 30 minutes it takes the
top products through the Design Center on a phone and a laptop, uploads art,
taps Add to cart and confirms the storefront cart loads with the item. The full
catalog runs nightly. It never reaches Shopify checkout and never places an order.

- Identifies itself with a `tlc_robot` cookie so its designs are auto-deleted
  and its clicks are excluded from analytics (design-center `src/lib/robot-shopper.ts`).
- Blocks every ad/analytics pixel, so it never counts as a shopper.
- A failure is retried once; two in a row opens a `robot-down` issue and emails
  hello@thelasercraft.co. Recovery closes the issue and sends one all-clear.

Products live in `products.json`. Local run: `npm ci && npx playwright install chromium && ROBOT_ONLY=drinkware node robot.mjs`
