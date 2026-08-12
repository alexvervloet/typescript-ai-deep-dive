/**
 * tsai/orders.ts: the tiny made-up dataset the tool examples and the capstone
 * answer questions about.
 *
 * Eight rows, hard-coded, no database. A toy domain keeps the lessons about
 * TypeScript rather than about SQL, and it means every tool example runs offline
 * with nothing installed and nothing to seed.
 *
 * Notice the `Order` type. In Python this file would be a `@dataclass`, which
 * gives you a constructor, a readable `repr`, and equality for free. A
 * TypeScript `type` gives you none of those: it is a compile-time description of
 * a plain object and it vanishes before the program runs. What you get instead
 * is that any object of the right shape *is* an `Order`, with no class to
 * import, no inheritance, and no conversion when it comes back from `JSON.parse`
 * (once you have validated it). Different trade, not a strictly worse one.
 */

export type OrderStatus = "pending" | "shipped" | "delivered" | "cancelled";

export type Order = {
  id: string;
  customer: string;
  item: string;
  quantity: number;
  status: OrderStatus;
  totalEur: number;
  placedAt: string;
};

export const ORDERS: readonly Order[] = [
  { id: "A-1001", customer: "Rivera", item: "Standing desk", quantity: 1, status: "delivered", totalEur: 429.0, placedAt: "2026-06-02" },
  { id: "A-1002", customer: "Okafor", item: "Monitor arm", quantity: 2, status: "shipped", totalEur: 118.5, placedAt: "2026-06-11" },
  { id: "A-1003", customer: "Rivera", item: "Mechanical keyboard", quantity: 1, status: "pending", totalEur: 149.99, placedAt: "2026-06-14" },
  { id: "A-1004", customer: "Lindqvist", item: "Desk lamp", quantity: 3, status: "delivered", totalEur: 87.0, placedAt: "2026-06-15" },
  { id: "A-1005", customer: "Okafor", item: "Laptop stand", quantity: 1, status: "cancelled", totalEur: 62.0, placedAt: "2026-06-19" },
  { id: "A-1006", customer: "Haddad", item: "Noise-cancelling headphones", quantity: 1, status: "shipped", totalEur: 279.0, placedAt: "2026-06-21" },
  { id: "A-1007", customer: "Lindqvist", item: "Webcam", quantity: 1, status: "pending", totalEur: 94.5, placedAt: "2026-06-23" },
  { id: "A-1008", customer: "Rivera", item: "Cable tray", quantity: 4, status: "delivered", totalEur: 56.0, placedAt: "2026-06-25" },
];

export function findOrder(id: string): Order | undefined {
  const wanted = id.trim().toUpperCase();
  return ORDERS.find((order) => order.id.toUpperCase() === wanted);
}

export function ordersByStatus(status?: OrderStatus, limit = 10): Order[] {
  const matching = status ? ORDERS.filter((order) => order.status === status) : [...ORDERS];
  return matching.slice(0, limit);
}

/** One line per order, the shape a tool hands back to a model. */
export function describeOrder(order: Order): string {
  return (
    `${order.id}: ${order.quantity}x ${order.item} for ${order.customer}, ` +
    `${order.status}, EUR ${order.totalEur.toFixed(2)}, placed ${order.placedAt}`
  );
}
