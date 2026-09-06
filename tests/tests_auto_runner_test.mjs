import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { redactDiagnosticText } from "../tests-auto/artifact-redaction.mjs";

test("browser artifacts redact login values and authenticated trace headers", () => {
  const text = JSON.stringify({
    headers: [{ name: "Cookie", value: "opaque-session" }, { name: "Content-Type", value: "application/json" }],
    request: { password: "secret-fixture", cookies: [{ value: "opaque-session" }] },
    params: { value: "test-account-fixture" },
  });
  const sanitized = redactDiagnosticText(text, ["test-account-fixture", "secret-fixture"]);
  assert.doesNotMatch(sanitized, /opaque-session|test-account-fixture|secret-fixture/);
  assert.match(sanitized, /application\/json/);
});

const runDry = (environment = {}) => execFileSync("bash", ["tests-auto/test-all.sh"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  env: {
    ...process.env,
    TESTS_AUTO_DRY_RUN: "1",
    TEST_FOREGROUND: "0",
    WEBSHELL_LOCAL_STATIC_DIR: "/tmp/current-webshell-build",
    WEBSHELL_MOBILE_USER_AGENT: "",
    ...environment,
  },
});

test("full browser runner applies required per-scenario profiles without silent skips", () => {
  const output = runDry();
  const profiles = output.trim().split(/\r?\n/).filter((line) => line.includes("[tests-auto] PROFILE"));
  assert.equal(profiles.length, 18);
  assert.ok(profiles.some((line) => line.includes("17-client-tab-replay-recovery")));
  assert.ok(profiles.some((line) => line.includes("18-cross-device-tab-sync")));
  assert.match(
    profiles.find((line) => line.includes("04-terminal-viewport")) || "",
    /mobile_ua=Mozilla\/5\.0 \(iPhone;/,
  );
  assert.match(
    profiles.find((line) => line.includes("11-service-worker-retirement")) || "",
    /static=<empty>/,
  );
  for (const line of profiles.filter((value) => !value.includes("11-service-worker-retirement"))) {
    assert.match(line, /static=\/tmp\/current-webshell-build/);
  }
  assert.match(output, /\[tests-auto\] 18 case profile\(s\) ready/);
  assert.doesNotMatch(output, /case\(s\) passed/);
});
