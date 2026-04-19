---
title: Transactions
description: Atomic multi-operation database transactions with automatic rollback
---

# Transactions

Transactions provide **atomicity** for multiple database operations - either all operations succeed together, or all fail together with automatic rollback. No partial writes, no inconsistent state.

## Quick Start

```typescript
// All operations succeed together or fail together
await db.transaction(async (tx) => {
  const order = await tx.insert(() => ({
    into: "orders",
    values: { userId: 1, amount: 100 },
  }));

  await tx.insert(() => ({
    into: "payments",
    values: { orderId: order.ids[0], status: "paid" },
  }));
  // ✅ Auto-commits on success, auto-rolls back on error
});
```

## The Problem: Partial Failures

**Without transactions:**

```typescript
// 1. Insert order - succeeds ✓
await db.insert(() => ({
  into: "orders",
  values: { userId: 1, amount: 100 },
}));

// 2. Insert payment - fails ✗
await db.insert(() => ({
  into: "payments",
  values: { orderId: 123, status: "paid" },
}));

// Result: Orphaned order exists without payment record
// Data integrity compromised! ❌
```

**With transactions:**

```typescript
await db.transaction(async (tx) => {
  // 1. Insert order - buffered
  await tx.insert(() => ({
    into: "orders",
    values: { userId: 1, amount: 100 },
  }));

  // 2. Insert payment - fails
  await tx.insert(() => ({
    into: "payments",
    values: { orderId: 123, status: "paid" },
  }));

  // Result: Automatic rollback - NO data written
  // Consistency maintained! ✅
});
```

## Core Concepts

### Atomicity

All operations within a transaction form a **single logical unit**:

- **Success**: All operations commit together
- **Failure**: All operations roll back - zero data written
- **No partial writes**: Database never in inconsistent state

### Automatic Lifecycle

```typescript
await db.transaction(async (tx) => {
  // START: Transaction begins automatically

  await tx.insert(/* ... */); // Buffered (not yet committed)
  await tx.insert(/* ... */); // Buffered (not yet committed)

  // END: Transaction commits automatically when callback completes
  // OR: Transaction rolls back automatically if error thrown
});
```

**No manual commit/rollback needed** - the callback pattern handles everything.

### Isolation

Uncommitted changes are invisible outside the transaction:

```typescript
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { amount: 100 } }));

  // Inside transaction - sees uncommitted data
  const inside = await tx.select((c) => ({ from: "orders" }));
  console.log(inside.length); // 1

  // Outside transaction - does NOT see uncommitted data
  const outside = await db.select((c) => ({ from: "orders" }));
  console.log(outside.length); // 0
});

// After commit - everyone sees the data
const after = await db.select((c) => ({ from: "orders" }));
console.log(after.length); // 1
```

## When to Use Transactions

### ✅ Required For

**Multi-step operations that must maintain consistency:**

| Scenario                 | Why Transaction Needed                    |
| ------------------------ | ----------------------------------------- | --------------------------------------------- |
| **Financial Operations** | Money transfers, order + payment creation | Partial completion = money lost or duplicated |
| **Parent-Child Records** | Order + line items, user + profile        | Orphaned children if parent insert fails      |
| **Inventory Management** | Decrement stock + create order            | Overselling if not atomic                     |
| **Multi-Table Updates**  | Update user + update related records      | Inconsistent state across tables              |

**Example - E-commerce Checkout:**

```typescript
await db.transaction(async (tx) => {
  // Must ALL succeed or ALL fail
  const order = await tx.insert(() => ({ into: "orders" /* ... */ }));
  await tx.insert(() => ({ into: "line_items" /* ... */ }));
  await tx.insert(() => ({ into: "payments" /* ... */ }));
  await tx.delete("cart", cartId); // Clear cart
});
```

### ❌ NOT Required For

**Operations that are already atomic or don't need consistency:**

| Scenario                   | Why Transaction NOT Needed         | Better Approach           |
| -------------------------- | ---------------------------------- | ------------------------- |
| **Single Insert/Update**   | Already atomic by default          | Direct `db.insert()`      |
| **Batch Insert (Array)**   | Already atomic (all-or-nothing)    | `db.insert()` with array  |
| **Independent Operations** | Partial success is acceptable      | Sequential operations     |
| **Read-Only Queries**      | No data modification               | Direct `db.select()`      |
| **Logging/Analytics**      | Failures shouldn't block main flow | Separate async operations |

**Example - Blog Post Creation:**

```typescript
// ❌ Unnecessary transaction
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "posts", values: { title: "..." } }));
});

// ✅ Single operation is already atomic
await db.insert(() => ({ into: "posts", values: { title: "..." } }));
```

## API Usage

### Basic Transaction

```typescript
const result = await db.transaction(async (tx) => {
  // All operations on 'tx', not 'db'
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  await tx.insert(() => ({ into: "payments", values: { ... } }));

  return "success"; // Optional return value
});

console.log(result); // "success"
```

### With Error Handling

```typescript
try {
  await db.transaction(async (tx) => {
    await tx.insert(() => ({ into: "orders", values: { ... } }));

    // Validation error triggers rollback
    await tx.insert(() => ({
      into: "payments",
      values: { invalidField: 123 } // Schema error
    }));
  });
} catch (error) {
  console.error("Transaction failed and rolled back:", error);
  // NO data was written - order insert was rolled back
}
```

### Returning Values

```typescript
const orderId = await db.transaction(async (tx) => {
  const result = await tx.insert(() => ({
    into: "orders",
    values: { userId: 1, amount: 100 },
  }));

  return result.ids[0]; // Return created ID
});

// Use the returned value
console.log("Created order:", orderId);
```

### Conditional Logic

```typescript
await db.transaction(async (tx) => {
  const order = await tx.insert(() => ({
    into: "orders",
    values: { userId: 1, amount: 500 },
  }));

  // Query within transaction sees uncommitted data
  const orders = await tx.select((c) => ({ from: "orders" }));

  // Conditional operation based on data
  if (orders[0].amount > 100) {
    await tx.insert(() => ({
      into: "rewards",
      values: { orderId: order.ids[0], points: 50 },
    }));
  }
});
```

### Batch Operations with Additional Steps

Combine batch inserts with other transactional operations:

```typescript
await db.transaction(async (tx) => {
  // 1. Batch insert orders
  const orders = await tx.insert(() => ({
    into: "orders",
    values: [
      { userId: 1, amount: 100 },
      { userId: 2, amount: 200 },
      { userId: 3, amount: 300 },
    ],
  }));

  // 2. Create payment record for each order
  for (const orderId of orders.ids) {
    await tx.insert(() => ({
      into: "payments",
      values: { orderId, status: "pending" },
    }));
  }

  // 3. Update user loyalty points
  await tx.insert(() => ({
    into: "loyalty_points",
    values: { userId: 1, points: 600 },
  }));
});
```

:::note
Array inserts alone don't require transactions - they're already atomic. Use transactions when you need to combine batch inserts with other operations.
:::

### Delete Operations

```typescript
await db.transaction(async (tx) => {
  // Find cancelled orders
  const cancelled = await tx.select((c) => ({
    from: "orders",
    where: c.eq(c.orders.status, "cancelled"),
  }));

  // Delete orders and related records atomically
  for (const order of cancelled) {
    await tx.delete("orders", order.id);
    await tx.delete("line_items", order.lineItemId);
  }
});
```

## Real-World Example

### E-commerce Order Processing

```typescript
interface CartItem {
  productId: string;
  quantity: number;
  price: number;
}

async function processCheckout(
  userId: number,
  items: CartItem[]
): Promise<string> {
  return await db.transaction(async (tx) => {
    // 1. Validate inventory availability
    for (const item of items) {
      const inventory = await tx.select((c) => ({
        from: "inventory",
        where: c.eq(c.inventory.productId, item.productId),
      }));

      if (inventory.length === 0) {
        throw new Error(`Product ${item.productId} not found`);
      }

      if (inventory[0].quantity < item.quantity) {
        throw new Error(
          `Insufficient stock for ${item.productId}. ` +
            `Available: ${inventory[0].quantity}, Requested: ${item.quantity}`
        );
      }
    }

    // 2. Create order
    const total = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const order = await tx.insert(() => ({
      into: "orders",
      values: {
        userId,
        total,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    }));

    const orderId = order.ids[0];

    // 3. Create line items
    for (const item of items) {
      await tx.insert(() => ({
        into: "line_items",
        values: {
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          price: item.price,
          subtotal: item.price * item.quantity,
        },
      }));
    }

    // 4. Update inventory (decrement stock)
    for (const item of items) {
      const current = await tx.select((c) => ({
        from: "inventory",
        where: c.eq(c.inventory.productId, item.productId),
      }));

      await tx.delete("inventory", current[0].id);
      await tx.insert(() => ({
        into: "inventory",
        values: {
          productId: item.productId,
          quantity: current[0].quantity - item.quantity,
          updatedAt: new Date().toISOString(),
        },
      }));
    }

    // 5. Create payment record
    await tx.insert(() => ({
      into: "payments",
      values: {
        orderId,
        amount: total,
        status: "completed",
        paymentMethod: "credit_card",
        processedAt: new Date().toISOString(),
      },
    }));

    // 6. Clear user's cart
    const cartItems = await tx.select((c) => ({
      from: "cart_items",
      where: c.eq(c.cart_items.userId, userId),
    }));

    for (const cartItem of cartItems) {
      await tx.delete("cart_items", cartItem.id);
    }

    return orderId;
  });
}

// Usage
try {
  const orderId = await processCheckout(userId, cartItems);
  console.log(`Order ${orderId} processed successfully`);
} catch (error) {
  console.error("Checkout failed:", error);
  // All changes rolled back - inventory not decremented,
  // order not created, cart not cleared
}
```

## Error Handling

### Automatic Rollback

**Any error triggers immediate rollback:**

```typescript
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } })); // Buffered

  // Error occurs (schema validation, network, etc.)
  await tx.insert(() => ({
    into: "payments",
    values: { invalidField: 123 } // ❌ Throws error
  }));

  // ⚠️ This line never executes
  await tx.insert(() => ({ into: "shipments", values: { ... } }));
});

// Result: ALL operations rolled back
// orders insert NOT committed
// Zero data written to database
```

### Explicit Rollback

**Throw an error to force rollback:**

```typescript
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));

  const inventory = await tx.select((c) => ({ from: "inventory" }));

  // Business logic check
  if (inventory[0].quantity < minimumStock) {
    throw new Error("Insufficient inventory - cannot process order");
    // Transaction automatically rolls back
  }

  await tx.insert(() => ({ into: "shipments", values: { ... } }));
});
```

### Error Recovery Patterns

```typescript
async function createOrderWithRetry(orderData: any, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const orderId = await db.transaction(async (tx) => {
        const order = await tx.insert(() => ({
          into: "orders",
          values: orderData,
        }));

        await tx.insert(() => ({
          into: "audit_log",
          values: {
            action: "order_created",
            orderId: order.ids[0],
            timestamp: new Date().toISOString(),
          },
        }));

        return order.ids[0];
      });

      return { success: true, orderId };
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);

      if (attempt === maxRetries) {
        return {
          success: false,
          error: `Failed after ${maxRetries} attempts`,
        };
      }

      // Wait before retry (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );
    }
  }
}
```

### Complex Multi-Collection Workflow

```typescript
async function migrateUserData(oldUserId: string, newUserId: string) {
  await db.transaction(async (tx) => {
    // 1. Read all data from old user
    const orders = await tx.select((c) => ({
      from: "orders",
      where: c.eq(c.orders.userId, oldUserId),
    }));

    const payments = await tx.select((c) => ({
      from: "payments",
      where: c.eq(c.payments.userId, oldUserId),
    }));

    // 2. Create new records for new user
    for (const order of orders) {
      const newOrder = await tx.insert(() => ({
        into: "orders",
        values: { ...order, userId: newUserId, id: undefined },
      }));

      // Update associated payments
      const orderPayments = payments.filter((p) => p.orderId === order.id);
      for (const payment of orderPayments) {
        await tx.insert(() => ({
          into: "payments",
          values: {
            ...payment,
            orderId: newOrder.ids[0],
            id: undefined,
          },
        }));
      }
    }

    // 3. Delete old records
    for (const order of orders) {
      await tx.delete("orders", order.id);
    }
    for (const payment of payments) {
      await tx.delete("payments", payment.id);
    }
  });
}
```

### Nested Business Logic

```typescript
async function processMonthlyBilling(customerId: number) {
  return await db.transaction(async (tx) => {
    // 1. Get customer's active subscriptions
    const subscriptions = await tx.select((c) => ({
      from: "subscriptions",
      where: c.eq(c.subscriptions.customerId, customerId),
    }));

    let totalAmount = 0;
    const invoiceLineItems = [];

    // 2. Calculate charges for each subscription
    for (const sub of subscriptions) {
      const plan = await tx.select((c) => ({
        from: "plans",
        where: c.eq(c.plans.id, sub.planId),
      }));

      if (plan.length === 0) continue;

      // Check usage if metered
      if (plan[0].type === "metered") {
        const usage = await tx.select((c) => ({
          from: "usage",
          where: c.eq(c.usage.subscriptionId, sub.id),
        }));

        const usageCharge = usage[0].quantity * plan[0].pricePerUnit;
        totalAmount += usageCharge;
        invoiceLineItems.push({
          description: `${plan[0].name} - ${usage[0].quantity} units`,
          amount: usageCharge,
        });
      } else {
        totalAmount += plan[0].price;
        invoiceLineItems.push({
          description: plan[0].name,
          amount: plan[0].price,
        });
      }
    }

    // 3. Create invoice
    const invoice = await tx.insert(() => ({
      into: "invoices",
      values: {
        customerId,
        amount: totalAmount,
        status: "pending",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    }));

    // 4. Add line items
    for (const item of invoiceLineItems) {
      await tx.insert(() => ({
        into: "invoice_line_items",
        values: {
          invoiceId: invoice.ids[0],
          ...item,
        },
      }));
    }

    // 5. Log audit trail
    await tx.insert(() => ({
      into: "audit_log",
      values: {
        action: "invoice_created",
        entityType: "invoice",
        entityId: invoice.ids[0],
        details: JSON.stringify({ amount: totalAmount }),
        timestamp: new Date().toISOString(),
      },
    }));

    return invoice.ids[0];
  });
}
```

## Limitations

### 1. No Storage-Level Transactions

Zelavis transactions are **application-level** - operations are buffered in memory and applied in batch:

- ✅ **Atomicity**: All-or-nothing within single process
- ❌ **No cross-process isolation**: Other processes can see partial state during commit
- ❌ **No distributed transactions**: Not suitable for multi-database operations

**Impact**: Transactions guarantee consistency **within a single Zelavis instance**, but not across multiple processes or databases.

### 2. Operations After Completion Throw Errors

Cannot reuse a completed transaction:

```typescript
const tx = await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  return tx; // ❌ Bad practice - don't return tx
});

// ❌ Throws error - transaction already committed
await tx.insert(() => ({ into: "payments", values: { ... } }));
```

**Solution**: All operations must occur within the transaction callback.

### 3. Memory Overhead

Transactions buffer all operations in memory:

- **Small transactions**: Negligible overhead
- **Large transactions** (1000+ operations): Consider breaking into smaller transactions
- **Batch inserts**: Array inserts are efficient (single operation, multiple records)

### 4. No Savepoints

Cannot partially rollback - it's all-or-nothing:

```typescript
// ❌ Cannot do this:
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  // tx.savepoint("after_order"); // Not supported

  try {
    await tx.insert(() => ({ into: "payments", values: { ... } }));
  } catch (error) {
    // tx.rollbackTo("after_order"); // Not supported
  }
});
```

**Solution**: Use nested logic or separate transactions if needed.

## Best Practices

### ✅ Do

**Keep transactions short and focused:**

```typescript
// ✅ Good - focused transaction
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  await tx.insert(() => ({ into: "payments", values: { ... } }));
});
```

**Handle errors explicitly:**

```typescript
// ✅ Good - clear error handling
try {
  await db.transaction(async (tx) => {
    await tx.insert(() => ({ into: "orders", values: { ... } }));
  });
} catch (error) {
  if (error.message.includes("validation")) {
    // Handle validation error
  } else {
    // Handle other errors
  }
}
```

**Validate before modifying data:**

```typescript
// ✅ Good - validate first
await db.transaction(async (tx) => {
  const inventory = await tx.select((c) => ({ from: "inventory" }));

  if (inventory[0].quantity < orderQuantity) {
    throw new Error("Insufficient inventory");
  }

  await tx.insert(() => ({ into: "orders", values: { ... } }));
});
```

**Use transactions for business invariants:**

```typescript
// ✅ Good - maintain consistency rule
await db.transaction(async (tx) => {
  // Business rule: Order total must equal sum of line items
  const lineItems = [
    { price: 10, quantity: 2 }, // = 20
    { price: 15, quantity: 1 }, // = 15
  ];

  const total = lineItems.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  ); // = 35

  await tx.insert(() => ({
    into: "orders",
    values: { total }, // Must match line items
  }));

  for (const item of lineItems) {
    await tx.insert(() => ({ into: "line_items", values: item }));
  }
});
```

### ❌ Don't

**Don't mix external side effects:**

```typescript
// ❌ Bad - external API call in transaction
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));

  // ❌ Don't do this - if transaction rolls back, email was already sent
  await sendConfirmationEmail(order.id);
});

// ✅ Good - external calls after commit
const orderId = await db.transaction(async (tx) => {
  const order = await tx.insert(() => ({ into: "orders", values: { ... } }));
  return order.ids[0];
});

await sendConfirmationEmail(orderId);
```

**Don't perform heavy computations:**

```typescript
// ❌ Bad - CPU-intensive work blocks transaction
await db.transaction(async (tx) => {
  const data = await tx.select((c) => ({ from: "large_dataset" }));

  // ❌ Heavy computation keeps transaction open
  const processed = performExpensiveCalculation(data);

  await tx.insert(() => ({ into: "results", values: processed }));
});

// ✅ Good - compute outside transaction
const data = await db.select((c) => ({ from: "large_dataset" }));
const processed = performExpensiveCalculation(data);

await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "results", values: processed }));
});
```

**Don't create overly large transactions:**

```typescript
// ❌ Bad - too many operations
await db.transaction(async (tx) => {
  for (let i = 0; i < 10000; i++) {
    await tx.insert(() => ({ into: "records", values: { index: i } }));
  }
});

// ✅ Good - batch insert
await db.transaction(async (tx) => {
  const values = Array.from({ length: 10000 }, (_, i) => ({ index: i }));
  await tx.insert(() => ({ into: "records", values }));
});

// ✅ Good - or split into smaller transactions
for (let i = 0; i < 10000; i += 1000) {
  await db.transaction(async (tx) => {
    const batch = Array.from({ length: 1000 }, (_, j) => ({
      index: i + j,
    }));
    await tx.insert(() => ({ into: "records", values: batch }));
  });
}
```

**Don't ignore return values when needed:**

```typescript
// ❌ Bad - lost the created ID
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  // Need orderId for next operation but didn't capture it
});

// ✅ Good - capture and use return values
await db.transaction(async (tx) => {
  const order = await tx.insert(() => ({ into: "orders", values: { ... } }));
  await tx.insert(() => ({
    into: "payments",
    values: { orderId: order.ids[0] }
  }));
});
```

## Performance

### Transaction Overhead

**Minimal for typical use cases:**

| Operation            | Overhead            | Explanation                |
| -------------------- | ------------------- | -------------------------- |
| **Single operation** | ~0-1ms              | Minimal buffering cost     |
| **Multi-operation**  | ~0-5ms              | Map/Set lookups are O(1)   |
| **Commit**           | Same as batch write | Single storage operation   |
| **Rollback**         | ~0ms                | Just clear buffer (no I/O) |

### Optimization Tips

**1. Batch array operations instead of loops:**

```typescript
// ❌ Slow - 100 separate operations
await db.transaction(async (tx) => {
  for (let i = 0; i < 100; i++) {
    await tx.insert(() => ({ into: "orders", values: { index: i } }));
  }
});

// ✅ Fast - single operation with 100 records
await db.transaction(async (tx) => {
  const values = Array.from({ length: 100 }, (_, i) => ({ index: i }));
  await tx.insert(() => ({ into: "orders", values }));
});
```

**2. Minimize queries within transactions:**

```typescript
// ❌ Slower - multiple queries
await db.transaction(async (tx) => {
  for (const id of userIds) {
    const user = await tx.select((c) => ({
      from: "users",
      where: c.eq(c.users.id, id),
    }));
    // ... use user data
  }
});

// ✅ Faster - single query
await db.transaction(async (tx) => {
  const users = await tx.select((c) => ({ from: "users" }));
  const userMap = new Map(users.map((u) => [u.id, u]));

  for (const id of userIds) {
    const user = userMap.get(id);
    // ... use user data
  }
});
```

**3. Avoid unnecessary transactions:**

```typescript
// ❌ Unnecessary - single operation doesn't need transaction
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "logs", values: { ... } }));
});

// ✅ Better - single operations are already atomic
await db.insert(() => ({ into: "logs", values: { ... } }));
```

### Benchmarks

**Representative performance (Node.js, in-memory storage):**

```typescript
// Transaction with 10 inserts: ~5-10ms
await db.transaction(async (tx) => {
  for (let i = 0; i < 10; i++) {
    await tx.insert(() => ({ into: "records", values: { i } }));
  }
});

// Transaction with array of 10 inserts: ~2-5ms
await db.transaction(async (tx) => {
  await tx.insert(() => ({
    into: "records",
    values: Array.from({ length: 10 }, (_, i) => ({ i })),
  }));
});

// Large transaction (1000 records via array): ~50-100ms
await db.transaction(async (tx) => {
  await tx.insert(() => ({
    into: "records",
    values: Array.from({ length: 1000 }, (_, i) => ({ i })),
  }));
});
```

:::tip
Actual performance depends on storage adapter (file system, memory, remote) and hardware. Always benchmark your specific use case.
:::

## API Reference

### `db.transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>`

Execute a transaction with automatic commit/rollback.

**Parameters:**

- `fn` - Async callback receiving transaction object. Return value becomes transaction result.

**Returns:** Promise resolving to callback's return value.

**Throws:** Re-throws any error from callback after rolling back transaction.

**Example:**

```typescript
const orderId = await db.transaction(async (tx) => {
  const order = await tx.insert(() => ({
    into: "orders",
    values: { userId: 1, amount: 100 },
  }));

  return order.ids[0];
});
```

---

### `tx.insert<T>(builder: () => InsertQuery<T>): Promise<InsertResult>`

Insert records within a transaction (buffered until commit).

**Parameters:**

- `builder` - Function returning insert query object

**Returns:** Promise with `{ ids: string[], inserted: number }`

**Throws:**

- Schema validation errors
- Attempting operation on completed transaction

**Example:**

```typescript
await db.transaction(async (tx) => {
  const result = await tx.insert(() => ({
    into: "orders",
    values: [
      { userId: 1, amount: 100 },
      { userId: 2, amount: 200 },
    ],
  }));

  console.log(result.ids); // ["id1", "id2"]
  console.log(result.inserted); // 2
});
```

---

### `tx.select<T>(builder: (c: QueryBuilder) => SelectQuery): Promise<T[]>`

Query data including uncommitted changes from current transaction.

**Parameters:**

- `builder` - Function receiving query builder, returning select query

**Returns:** Promise with array of matching records

**Behavior:**

- Includes uncommitted inserts from transaction buffer
- Excludes uncommitted deletes from transaction
- Changes only visible within current transaction

**Example:**

```typescript
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { amount: 100 } }));

  // Sees uncommitted insert
  const orders = await tx.select((c) => ({
    from: "orders",
    where: c.gt(c.orders.amount, 50),
  }));

  console.log(orders.length); // 1 (includes uncommitted)
});
```

---

### `tx.selectFromJSON<T>(query: SelectQuery): Promise<T[]>`

Query data using JSON query object (alternative to builder pattern).

**Parameters:**

- `query` - JSON select query object

**Returns:** Promise with array of matching records

**Example:**

```typescript
await db.transaction(async (tx) => {
  const orders = await tx.selectFromJSON({
    from: "orders",
    where: { field: "amount", operator: "gt", value: 50 },
  });
});
```

---

### `tx.delete(collectionName: string, id: string): Promise<void>`

Delete a record within transaction (buffered until commit).

**Parameters:**

- `collectionName` - Name of collection containing record
- `id` - ID of record to delete

**Returns:** Promise resolving when deletion is buffered

**Behavior:**

- If record was inserted in same transaction: removes from buffer (never committed)
- Otherwise: marks for deletion (applied on commit)

**Example:**

```typescript
await db.transaction(async (tx) => {
  const orders = await tx.select((c) => ({
    from: "orders",
    where: c.eq(c.orders.status, "cancelled"),
  }));

  for (const order of orders) {
    await tx.delete("orders", order.id);
  }
});
```

---

### Transaction Lifecycle

```typescript
// BEGIN - Transaction starts when callback begins
await db.transaction(async (tx) => {
  // Operations buffered in memory
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  await tx.insert(() => ({ into: "payments", values: { ... } }));

  // COMMIT - Automatically when callback completes successfully
  // All buffered operations written to storage atomically
});

// ROLLBACK - Automatically if error thrown
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "orders", values: { ... } }));
  throw new Error("Failed"); // Triggers automatic rollback
  // All buffered operations discarded - zero data written
});
```

---

## Summary

**Key Takeaways:**

1. **Use for multi-operation atomicity** - multiple inserts/deletes that must succeed or fail together
2. **Automatic lifecycle** - no manual commit/rollback, callback pattern handles everything
3. **Application-level** - consistency within single process, not cross-process isolation
4. **Keep transactions short** - minimize operations, avoid external calls
5. **Batch array operations** - use array inserts instead of loops for better performance

**Quick Decision Tree:**

```
Need multiple operations to be atomic?
├─ YES → Use transaction
├─ NO → Is it a single operation?
   ├─ YES → Don't use transaction (already atomic)
   └─ NO → Are operations independent?
      ├─ YES → Don't use transaction
      └─ NO → Use transaction
```

### Cannot reuse completed transactions

```typescript
let savedTx;

await db.transaction(async (tx) => {
  savedTx = tx;
  await tx.insert(() => ({ into: "orders", values: { ... } }));
});

// ❌ This will throw
await savedTx.insert(() => ({ into: "payments", values: { ... } }));
// Error: "Cannot perform operations on completed transaction"
```

### Single operations don't need transactions

```typescript
// ❌ Unnecessary
await db.transaction(async (tx) => {
  await tx.insert(() => ({ into: "posts", values: { ... } }));
});

// ✅ Single operations are already atomic
await db.insert(() => ({ into: "posts", values: { ... } }));
```

## Best Practices

1. **Keep transactions short** - long transactions can block other operations
2. **Only wrap what needs atomicity** - don't include unrelated operations
3. **Handle errors explicitly** - catch and log transaction failures
4. **Use for consistency** - when multiple operations must succeed together
5. **Return necessary data** - avoid querying committed data outside transaction

## Performance

- **Overhead**: Minimal - transactions use in-memory buffering
- **Commits**: Single write operation to storage
- **Rollbacks**: Instant - just discard the buffer
- **Isolation**: No locking - each transaction is independent

## API Reference

### `db.transaction(callback)`

Execute operations atomically within a transaction.

**Parameters:**

- `callback: (tx: Transaction) => Promise<T>` - Function that receives transaction object

**Returns:** `Promise<T>` - Result of the callback

**Methods on `tx` (Transaction object):**

- `tx.insert(builder)` - Insert records (buffered)
- `tx.select(builder)` - Query records (includes uncommitted changes)
- `tx.selectFromJSON(query)` - Query with JSON syntax
- `tx.delete(collectionName, id)` - Delete a record (buffered)

All transaction operations automatically commit on success or rollback on error.
