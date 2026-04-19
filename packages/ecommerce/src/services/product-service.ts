import type { ProductRepository } from "../contracts/repositories.js";
import type { Product } from "../domain/entities.js";

export interface CreateProductInput {
  id: string;
  slug: string;
  title: string;
  description?: string;
  price: Product["price"];
  metadata?: Record<string, unknown>;
}

export class ProductService {
  constructor(private readonly repository: ProductRepository) {}

  async create(input: CreateProductInput): Promise<Product> {
    if (!input.id) {
      throw new TypeError("Product creation requires an id.");
    }

    if (!input.slug) {
      throw new TypeError("Product creation requires a slug.");
    }

    if (!input.title) {
      throw new TypeError("Product creation requires a title.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getById(id: string): Promise<Product | null> {
    return this.repository.findById(id);
  }

  async list(): Promise<Product[]> {
    return this.repository.list();
  }
}
