---
layout: docs
title: "Email Delivery"
description: "Configure SMTP for the Platform and for each App, send a test, and follow deliveries."
---

# Email Delivery

Every Zelavis runtime sends its own email: the Platform has one set of settings and one outbox, and each native App
Project has its own, kept in that App's own runtime store. An App's mail never uses the Platform's server, sender or
credentials, and the Platform never sees an App's queue. Email verification and password recovery send through the outbox of the
runtime the account belongs to.

Delivery is SMTP submission, built in. Postmark, Amazon SES, Resend, Mailgun and most other providers accept SMTP, so
no provider plugin is needed. There is no bulk or marketing mail, no attachments and no inbound mail; DKIM signing is
the submission server's job.

## Settings

Email starts disabled. The settings are:

| Field | Meaning |
| --- | --- |
| `mode` | `disabled` or `smtp`. SMTP needs `from`, `linkBaseUrl` and `smtp`. |
| `from.address`, `from.name` | The sender. A bare address, and an optional display name without control characters. |
| `linkBaseUrl` | The public address emailed links start with, such as `https://panel.example.com/zelavis`. It must be `https` (or `http` on `localhost`, `127.0.0.1` or `[::1]`), with no query or fragment. Links are never built from a request's `Host` header. |
| `smtp.host`, `smtp.port` | The submission server. |
| `smtp.security` | `starttls` connects in the clear and upgrades before anything else is sent (usually port 587); Zelavis refuses a server that does not offer `STARTTLS`. `tls` uses TLS from the first byte (usually port 465). |
| `smtp.username`, `smtp.password` | `AUTH PLAIN`, sent only over TLS. Refused if the server does not offer it. |

Certificates are always verified against the host's trusted CAs; there is no option to skip verification. A server
with a private CA needs that CA trusted by the host (for Node, `NODE_EXTRA_CA_CERTS`).

The password is encrypted at rest with the runtime's master secret and never returned: reads show `smtp.hasPassword`.
On a write, leaving `password` out keeps the stored one only while the host and username stay the same; changing
either asks for the password again, so a stored password is never sent to a different server. `""` removes it.

Every write carries `expectedRevision`, the `revision` of the last read, and answers `409 email_settings_conflict`
when the settings changed meanwhile.

## Delivery

A send is queued and answered at once; the runtime's worker delivers it.

- **At least once.** A message is leased (two minutes) while it is sent. If the runtime stops after the server
  accepted a message but before it recorded that, the message is sent again once the lease expires. Its
  `Message-ID` is `<delivery id@sender domain>` on every attempt, so a receiving system can drop the duplicate.
- **Caller ids.** In-process callers (Auth, billing) may enqueue with their own message `id` (1-64 characters of
  `A-Za-z0-9_-`). A repeated id creates at most one delivery and is answered with the same id, so a caller that
  retries after a crash never sends twice. The id is released when the delivery's retention ends.
- **Retries.** A `4xx` reply, a timeout or a lost connection is retried after 1 minute, 5 minutes, 30 minutes,
  2 hours and 6 hours; the sixth failure is final. A `5xx` reply is final at once.
- **Survives restarts.** The queue is durable, in the runtime's own store, and the worker continues it when the
  runtime starts again.
- **Bounded.** A runtime holds at most 1000 deliveries waiting (queued or sending); more answer
  `429 email_outbox_full`. Delivered and failed entries are listed for seven days and then removed.
- **Private.** Message content is encrypted at rest and never returned or logged. The listing shows the recipient,
  kind, state, attempts and the last failure as one of `SMTP <code>`, `timeout`, `connection failed`, `tls failed`,
  `starttls unavailable`, `auth unavailable`, `invalid message` or `no transport`; never the server's own words.
- **Disabled means waiting.** Switching to `disabled` refuses new sends (`409 email_disabled`); deliveries already
  queued wait and are sent once SMTP is configured again.

## Operations

The Platform's own email needs `system.settings.manage` (system scope). An App's needs `project.settings.manage` on
that exact Project; the Platform forwards it to the App's own routes.

| What | HTTP | SDK | CLI |
| --- | --- | --- | --- |
| Read settings | `GET email/settings` | `client.email.settings()` | `zelavis email settings` |
| Replace settings | `PUT email/settings` | `client.email.setSettings(input)` | `zelavis email set-settings --data JSON` |
| Queue a test (202) | `POST email/test` `{ to }` | `client.email.sendTest(to)` | `zelavis email test ADDRESS` |
| List deliveries | `GET email/deliveries?limit=1..100&after=CURSOR` | `client.email.deliveries({ limit, after })` | `zelavis email deliveries [--limit N] [--after CURSOR]` |
| An App's settings | `GET\|PUT runtime/projects/:projectId/email/settings` | `client.projects.emailSettings(id)`, `setEmailSettings(id, input)` | `zelavis projects email-settings PROJECT`, `set-email-settings PROJECT --data JSON` |
| An App's test | `POST runtime/projects/:projectId/email/test` | `client.projects.sendTestEmail(id, to)` | `zelavis projects send-test-email PROJECT ADDRESS` |
| An App's deliveries | `GET runtime/projects/:projectId/email/deliveries` | `client.projects.emailDeliveries(id, { limit, after })` | `zelavis projects email-deliveries PROJECT [--limit N] [--after CURSOR]` |

Paths are under `/zelavis/api/v1/`. Add `--json` to a CLI command for the same JSON the route answers. The listing
pages oldest first; pass the answer's `next` as `after` for the next page.

```bash
zelavis email set-settings --data '{"expectedRevision":0,"mode":"smtp","from":{"address":"noreply@example.com","name":"Example"},"linkBaseUrl":"https://panel.example.com/zelavis","smtp":{"host":"smtp.example.com","port":587,"security":"starttls","username":"apikey","password":"…"}}'
zelavis email test you@example.com
zelavis email deliveries --json
```

Errors carry `{ error, code }`: `invalid_email_settings` (400), `email_settings_conflict` (409, with the current
`revision`), `email_disabled` (409), `email_outbox_full` (429) and `email_unavailable` (503).

## Dashboard

**Settings → Email delivery** (`/settings/email`) holds the Platform's settings, a test send and its deliveries. An
App's cards are on its **Auth** page (`/projects/:projectId/auth`), under public registration.

For verification and password recovery, set the link base to the public auth
mount for this runtime. The Platform uses its dashboard mount and a native App
uses the auth mount on its own verified hostname or preview. Send a test
message before enabling **Require verified email** in **Auth**. The
[Auth guide](/packages/auth/#sign-in-methods) covers
link lifetimes, session behavior and the public operations.
