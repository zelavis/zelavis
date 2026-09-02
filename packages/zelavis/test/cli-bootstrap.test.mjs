import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapPlatformOwner,
  formatBootstrapStatus,
  readBootstrapStatus,
  runCli,
} from "../dist/cli/index.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, fetcher };
}

const READY_STATUS = {
  required: true,
  available: true,
  tokenRequired: true,
  providers: ["email-password"],
  enrollmentProviders: ["email-password"],
};

test("bootstrap status reads the Platform's own bootstrap endpoint", async () => {
  const { calls, fetcher } = recordingFetch(() => jsonResponse(READY_STATUS));
  const status = await readBootstrapStatus({
    url: "http://platform.test/zelavis",
    fetch: fetcher,
  });

  assert.equal(calls[0].url, "http://platform.test/zelavis/api/v1/auth/bootstrap");
  assert.equal(status.required, true);
  assert.deepEqual(status.enrollmentProviders, ["email-password"]);
});

test("the owner request sends the credential the Platform expects", async () => {
  const { calls, fetcher } = recordingFetch(() =>
    jsonResponse(
      { account: { id: "account_1", email: "owner@example.com" }, session: { token: "zvs_secret" } },
      201,
    ),
  );

  await bootstrapPlatformOwner(
    {
      bootstrapToken: "token-with-at-least-32-characters-here",
      provider: "email-password",
      email: "owner@example.com",
      displayName: "Owner",
      password: "correct horse battery staple",
    },
    { url: "http://platform.test/zelavis", fetch: fetcher },
  );

  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(body.bootstrapToken, "token-with-at-least-32-characters-here");
  assert.equal(body.account.email, "owner@example.com");
  assert.equal(body.account.displayName, "Owner");
  // The enrolled identifier has to match the account identity, or the Platform
  // rejects the pair rather than silently enrolling a credential nobody can use.
  assert.equal(body.credential.identifier, "owner@example.com");
  assert.equal(body.credential.password, "correct horse battery staple");
});

test("an identity is required before anything is sent", async () => {
  const { calls, fetcher } = recordingFetch(() => jsonResponse({}, 201));
  await assert.rejects(
    bootstrapPlatformOwner(
      { bootstrapToken: "t", provider: "email-password", password: "secret password here" },
      { url: "http://platform.test/zelavis", fetch: fetcher },
    ),
    /requires --email or --username/,
  );
  assert.equal(calls.length, 0);
});

test("a Platform error is surfaced instead of being reported as success", async () => {
  const { fetcher } = recordingFetch(() =>
    jsonResponse({ error: "Invalid Platform bootstrap token." }, 403),
  );
  await assert.rejects(
    bootstrapPlatformOwner(
      {
        bootstrapToken: "wrong",
        provider: "email-password",
        email: "owner@example.com",
        password: "correct horse battery staple",
      },
      { url: "http://platform.test/zelavis", fetch: fetcher },
    ),
    /Invalid Platform bootstrap token/,
  );
});

test("--password is refused so the owner secret stays out of argv", async () => {
  const errors = [];
  const consoleError = console.error;
  console.error = (message) => errors.push(String(message));
  const exitCode = process.exitCode;
  try {
    await runCli(["bootstrap", "--email", "owner@example.com", "--password", "hunter2hunter2hunter2"]);
  } finally {
    console.error = consoleError;
    process.exitCode = exitCode;
  }

  assert.match(errors.join("\n"), /--password is not accepted/);
});

test("bootstrap status explains a Platform with no credential provider", () => {
  const summary = formatBootstrapStatus({
    ...READY_STATUS,
    providers: [],
    enrollmentProviders: [],
  });
  assert.match(summary, /no owner yet/);
  assert.match(summary, /none installed/);
});

test("a completed Platform reports that bootstrap is done", () => {
  const summary = formatBootstrapStatus({ ...READY_STATUS, required: false });
  assert.match(summary, /already has an owner/);
});

test("a missing bootstrap token is reported without a configured token", () => {
  const summary = formatBootstrapStatus({ ...READY_STATUS, available: false });
  assert.match(summary, /ZELAVIS_BOOTSTRAP_TOKEN/);
});
