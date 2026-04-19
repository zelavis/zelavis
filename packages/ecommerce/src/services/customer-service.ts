import type { CustomerRepository } from "../contracts/repositories.js";
import type { Customer } from "../domain/entities.js";

export interface CreateCustomerInput {
  id: string;
  accountId?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, unknown>;
}

export class CustomerService {
  constructor(private readonly repository: CustomerRepository) {}

  async create(input: CreateCustomerInput): Promise<Customer> {
    if (!input.id) {
      throw new TypeError("Customer creation requires an id.");
    }

    if (!input.email) {
      throw new TypeError("Customer creation requires an email.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getById(id: string): Promise<Customer | null> {
    return this.repository.findById(id);
  }

  async list(): Promise<Customer[]> {
    return this.repository.list();
  }
}
