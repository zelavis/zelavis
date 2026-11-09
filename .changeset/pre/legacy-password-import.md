---
"zelavis": minor
---

Account import carries bcrypt (`$2a$`/`$2b$`/`$2y$`, Django `bcrypt_sha256`), scrypt (Django) and Firebase Authentication's modified scrypt passwords (with the project's `hashConfig` and each account's `passwordSalt`). They are verified in plain JavaScript over Web Crypto, yielding as they run, and replaced by Zelavis's own PBKDF2 hash at their owner's first sign-in; the import report lists them in `rehashOnSignIn`.
