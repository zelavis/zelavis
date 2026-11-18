/**
 * The emails Auth sends (Zelavis-own), over the text of upstream's
 * `components/email/helpers.ts` (`challengeEmailText`, `VALIDATE_EMAIL_COPY`) and
 * `methods/email-password/server.ts` (the recovery copy and the security notices).
 *
 * Plain text and HTML for each, naming the runtime and the expiry. A link comes
 * from the email settings' link base, never from a request `Host`, and carries
 * its code in the URL fragment so the code is not sent to the server that
 * serves the page.
 */
import type { EmailKind } from "../../app/email/contracts.js";
import type { AuthEmailPayload } from "../runtime/index.js";
import { formatDuration } from "./helpers.js";

/** The pages the emailed links open, under the link base. */
export type ChallengePage = "verify-email" | "change-email" | "reset-password";

/** The lines of a challenge email that depend on the flow. */
export type ChallengeEmailCopy = {
  kind: EmailKind;
  /** The landing page the link opens. */
  page: ChallengePage;
  subject: string;
  // The sentence before the link, for example "Open this link to validate
  // your email address:".
  intro: string;
};

/** What the start of a challenge needs of the runtime's email delivery: where links open, and the name mails carry. */
export type ChallengeEmailSender = {
  readonly linkBase: URL;
  readonly runtimeName: string;
};

/** The copy of the emails that record an address. */
export const VALIDATE_EMAIL_COPY: ChallengeEmailCopy = {
  kind: "email-verification",
  page: "verify-email",
  subject: "Validate your email address",
  intro: "Open this link to validate your email address:",
};

/** The copy of the email that confirms a new primary address. */
export const CHANGE_EMAIL_COPY: ChallengeEmailCopy = { ...VALIDATE_EMAIL_COPY, page: "change-email" };

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/**
 * The link to `page` under the link base, with the code in the fragment.
 * Relative to the base's directory, so a base with a path keeps it.
 */
export function buildLink(linkBase: URL, page: ChallengePage | "invitation", secret: string): string {
  const directory = new URL(linkBase);
  if (!directory.pathname.endsWith("/")) directory.pathname += "/";
  const link = new URL(page, directory);
  link.hash = new URLSearchParams({ [page === "invitation" ? "token" : "code"]: secret }).toString();
  return link.href;
}

/** The message of a challenge email. */
export function challengeEmail(
  sender: ChallengeEmailSender,
  message: { to: string; copy: ChallengeEmailCopy; emailCode: string; ttlMs: number },
): AuthEmailPayload {
  const link = buildLink(sender.linkBase, message.copy.page, message.emailCode);
  const expiry = `The link stops working after ${formatDuration(message.ttlMs)}, and works only in the browser you started from.`;
  const ignore = "If you did not request this email, you can safely ignore it.";
  // TODO: also offer a short code the user can type, with rate limiting on
  // attempts (a short code is guessable, unlike the 256-bit link code).
  return {
    kind: message.copy.kind,
    to: message.to,
    subject: message.copy.subject,
    text: `${message.copy.intro}\n\n${link}\n\n${expiry}\n\n${ignore}\n\n${sender.runtimeName}`,
    html: `<p>${escapeHtml(message.copy.intro)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(expiry)}</p><p>${escapeHtml(ignore)}</p><p>${escapeHtml(sender.runtimeName)}</p>`,
  };
}

/** A security notification (OWASP ASVS 6.3.7): no link, only what happened. */
export function noticeEmail(
  sender: ChallengeEmailSender,
  message: { to: string; kind: EmailKind; subject: string; text: string },
): AuthEmailPayload {
  return {
    kind: message.kind,
    to: message.to,
    subject: message.subject,
    text: `${message.text}\n\n${sender.runtimeName}`,
    html: `${message.text.split("\n\n").map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}<p>${escapeHtml(sender.runtimeName)}</p>`,
  };
}

/** An invitation is usable from any browser that receives the link. */
export function invitationEmail(base: URL, to: string, token: string): AuthEmailPayload {
  const link = buildLink(base, "invitation", token);
  const intro = "You have been invited to Zelavis. Open this link to accept your invitation.";
  const expiry = "The invitation expires seven days after it was created and can be accepted once.";
  return {
    kind: "invitation", to, subject: "You’re invited to Zelavis",
    text: `${intro}\n\n${link}\n\n${expiry}`,
    html: `<p>${intro}</p><p><a href="${escapeHtml(link)}">Accept invitation</a></p><p>${expiry}</p>`,
  };
}
