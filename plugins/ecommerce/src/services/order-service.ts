import type { OrderRepository } from "../contracts/repositories.js";
import type { Order } from "../domain/entities.js";

export interface CreateOrderInput {
  id: string;
  customerId: string;
  items: Order["items"];
  couponCodes?: string[];
  totals: Order["totals"];
  metadata?: Record<string, unknown>;
}

export class OrderService {
  constructor(private readonly repository: OrderRepository) {}

  async create(input: CreateOrderInput): Promise<Order> {
    if (!input.id) {
      throw new TypeError("Order creation requires an id.");
    }

    if (!input.customerId) {
      throw new TypeError("Order creation requires a customerId.");
    }

    if (input.items.length === 0) {
      throw new TypeError("Order creation requires at least one line item.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      couponCodes: input.couponCodes ?? [],
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  }

  async getById(id: string): Promise<Order | null> {
    return this.repository.findById(id);
  }

  async list(): Promise<Order[]> {
    return this.repository.list();
  }
}
