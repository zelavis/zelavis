import type { CouponRepository } from "../contracts/repositories.js";
import type { Coupon } from "../domain/entities.js";

export interface CreateCouponInput {
  code: string;
  description?: string;
  discountType: Coupon["discountType"];
  discountValue: number;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

export class CouponService {
  constructor(private readonly repository: CouponRepository) {}

  async create(input: CreateCouponInput): Promise<Coupon> {
    if (!input.code) {
      throw new TypeError("Coupon creation requires a code.");
    }

    if (input.discountValue < 0) {
      throw new TypeError("Coupon discountValue must be zero or greater.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getByCode(code: string): Promise<Coupon | null> {
    return this.repository.findByCode(code);
  }

  async list(): Promise<Coupon[]> {
    return this.repository.list();
  }
}
