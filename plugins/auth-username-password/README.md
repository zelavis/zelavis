# @zelavis/app-auth-username-password

Username/password provider service for `zelavis/app/auth`.

This ordinary Zelavis plugin registers a `username-password` auth method through the public `zelavis/app/auth` contract. It uses the runtime-neutral PBKDF2 password hasher by default and does not depend on hidden service composition.

```ts
import { hashPassword } from "zelavis/app/auth";
import { usernamePasswordService } from "@zelavis/app-auth-username-password";

export const service = usernamePasswordService();
const secretHash = await hashPassword("a long password with 15+ characters");
```

Store `secretHash` in a `username-password` credential. Clients authenticate
through the Auth endpoint with provider name `username-password`; successful
authentication returns a revocable opaque session token.
