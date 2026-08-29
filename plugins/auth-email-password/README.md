# @zelavis/app-auth-email-password

Email/password provider service for `zelavis/app/auth`.

This ordinary Zelavis plugin registers an `email-password` auth method through the public `zelavis/app/auth` contract. It uses the runtime-neutral PBKDF2 password hasher by default and does not depend on hidden service composition.

```ts
import { emailPasswordService } from "@zelavis/app-auth-email-password";

export const service = emailPasswordService();
```

The provider owns both credential enrollment and authentication. The Platform
first-owner bootstrap endpoint can therefore create an `email-password`
credential without knowing how that provider hashes secrets. Email identifiers
are normalized to trimmed lowercase values, PBKDF2 hashes are stored instead of
plaintext passwords, and successful authentication returns a revocable opaque
session token.

Optional recovery stays provider-owned. Configure `recovery.deliver` to send
the generated one-time token through the deployment's email provider. Zelavis
stores only its expiring hash, returns the same accepted response for known and
unknown accounts, replaces the password through the provider completion
endpoint, and revokes the account's active sessions.
