/**
 * The storage every domain service reaches through.
 *
 * A service depends on this rather than on six constructor arguments, so
 * whether a caller is running against a database or a Map is a choice made
 * once when the layer is built, not threaded through every construction site.
 */
import { Context, Layer } from "effect";
import type { EcommerceRepositories } from "../contracts/repositories.js";

export class Repositories extends Context.Service<Repositories, EcommerceRepositories>()(
  "zelavis/ecommerce/Repositories",
) {
  /** Serves whichever implementation the caller composed. */
  static readonly layerOf = (repositories: EcommerceRepositories) =>
    Layer.succeed(Repositories, Repositories.of(repositories));
}
