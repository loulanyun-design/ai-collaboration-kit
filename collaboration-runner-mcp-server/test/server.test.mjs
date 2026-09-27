import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  assertJobId,
  assertModelRoute,
  assertProjectId,
  parseRunnerJson,
  parseRunnerResult,
  preflight,
  resume,
  submit
} from "../src/bridge.mjs";
import { createDevSpaceTokenVerifier, startServer } from "../src/server.mjs";

test("bridge validators reject free-form command-shaped input", () => {
  assert.equal(assertProjectId("sample-project"), "sample-project");
  assert.throws(() => assertProjectId("../bad"));
  assert.equal(assertJobId("a".repeat(32)), "a".repeat(32));
  assert.throws(() => assertJobId("not-a-job"));
  assert.equal(assertModelRoute("retrieval"), "retrieval");
  assert.throws(() => assertModelRoute("gpt-5.6-luna"));
});

test("runner output parsers remain bounded to expected formats", () => {
  assert.deepEqual(parseRunnerJson('{"ok":true}'), { ok: true });
  const parsed = parseRunnerResult('{"jobId":"abc"}\n--- RESULT.md ---\n# Result\n');
  assert.equal(parsed.job.jobId, "abc");
  assert.equal(parsed.resultMarkdown, "# Result\n");
});

test("runner_resume forwards bounded diagnosis and unavailable context", { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mcp-resume-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "runner.mjs"), [
    'console.log(JSON.stringify({ argv: process.argv.slice(2) }));'
  ].join("\n"));
  const previous = process.env.COLLAB_RUNNER_ROOT;
  process.env.COLLAB_RUNNER_ROOT = root;
  try {
    const output = await resume({ project: "fixture-project", diagnosis_complete: true, unavailable_count: 2 });
    assert.deepEqual(output.argv, ["resume", "--project", "fixture-project", "--diagnosis-complete", "true", "--unavailable-count", "2"]);
    await assert.rejects(() => resume({ project: "fixture-project", unavailable_count: 3 }), /integer from 0 to 2/);
    await assert.rejects(() => resume({ project: "fixture-project", diagnosis_complete: "yes" }), /must be boolean/);
  } finally {
    if (previous === undefined) delete process.env.COLLAB_RUNNER_ROOT;
    else process.env.COLLAB_RUNNER_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bridge preflight uses Runner CLI and submit timeout requires reconciliation", { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mcp-bridge-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "runner.mjs"), [
    'const args = process.argv.slice(2);',
    'const cmd = args[0];',
    'if (cmd === "preflight") {',
    '  console.log(JSON.stringify({ ok:true, projectId:args[2], readyForNewLaunch:true, runnerBuildIdentity:"fixture-build", validationSource:"fixture-runner-cli" }));',
    '} else if (cmd === "submit") {',
    '  setInterval(()=>{},1000);',
    '} else { process.exitCode = 2; }'
  ].join("\n"));

  const previous = process.env.COLLAB_RUNNER_ROOT;
  process.env.COLLAB_RUNNER_ROOT = root;
  try {
    const checked = await preflight("fixture-project", { timeoutMs: 1000 });
    assert.equal(checked.readyForNewLaunch, true);
    assert.equal(checked.runnerBuildIdentity, "fixture-build");
    assert.equal(checked.validationSource, "fixture-runner-cli");

    const uncertain = await submit(
      { project: "fixture-project" },
      { timeoutMs: 80 }
    );
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.primaryFailureKind, "SUBMISSION_OUTCOME_UNKNOWN");
    assert.equal(uncertain.executorLaunchState, "UNKNOWN");
    assert.equal(uncertain.readyForNewLaunch, false);
    assert.equal(uncertain.nextAction, "RECONCILE_EXISTING_JOB");
  } finally {
    if (previous === undefined) delete process.env.COLLAB_RUNNER_ROOT;
    else process.env.COLLAB_RUNNER_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("devspace token verifier forwards bearer without persisting it", async () => {
  let seenAuthorization = "";
  const verifier = createDevSpaceTokenVerifier({
    verifyUrl: "http://127.0.0.1:7677/mcp",
    fetchImpl: async (_url, init) => {
      seenAuthorization = init.headers.authorization;
      return { status: 200, body: { cancel: async () => {} } };
    }
  });
  const verified = await verifier("test-secret-token");
  assert.equal(verified.valid, true);
  assert.equal(verified.dependencyAvailable, true);
  assert.equal(seenAuthorization, "Bearer test-secret-token");
});

test("devspace token verifier distinguishes auth dependency failure from invalid token", async () => {
  const unavailable = createDevSpaceTokenVerifier({
    fetchImpl: async () => {
      throw Object.assign(new Error("connection refused"), { name: "TypeError" });
    }
  });
  const unavailableResult = await unavailable("token");
  assert.equal(unavailableResult.valid, false);
  assert.equal(unavailableResult.dependencyAvailable, false);
  assert.equal(unavailableResult.reason, "verify_unavailable");

  const rejected = createDevSpaceTokenVerifier({
    fetchImpl: async () => ({
      status: 401,
      body: { cancel: async () => {} }
    })
  });
  const rejectedResult = await rejected("token");
  assert.equal(rejectedResult.valid, false);
  assert.equal(rejectedResult.dependencyAvailable, true);
  assert.equal(rejectedResult.reason, "token_rejected");
});

test("HTTP server exposes health and MCP initialize locally when auth is disabled for tests", async (t) => {
  const server = await startServer({ host: "127.0.0.1", port: 0, authMode: "none" });
  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  const base = "http://127.0.0.1:" + address.port;

  const health = await fetch(base + "/healthz");
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.sdkSource, "project-local");
  assert.equal(healthBody.sdkVersion, "1.30.0");
  assert.equal(healthBody.zodVersion, "4.6.5");
  assert.equal(healthBody.runtimeReady, true);
  assert.equal(healthBody.authBoundary, "test-auth-disabled");
  assert.equal(healthBody.devspacePublicResource, "https://example.invalid/mcp");
  assert.equal(healthBody.oauthResourceRelationship, "same-origin-subpath");
  assert.equal(healthBody.oauthResourceRelationshipVerified, true);
  assert.equal(
    healthBody.resourceRelationshipVerifier,
    "@modelcontextprotocol/sdk/shared/auth-utils#checkResourceAllowed"
  );

  const init = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "collaboration-runner-mcp-test", version: "1.0.0" }
      }
    })
  });

  assert.equal(init.status, 200);
  const text = await init.text();
  assert.match(text, /collaboration-runner/);
  assert.match(text, /protocolVersion/);
});

test("OAuth mode advertises protected resource metadata and rejects missing bearer", async (t) => {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    authMode: "devspace-oauth",
    publicBaseUrl: "https://example.invalid",
    publicResourcePath: "/mcp/runner",
    verifyBearer: async (token) => token === "good-token"
  });
  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;

  const metadata = await fetch(base + "/.well-known/oauth-protected-resource/mcp/runner");
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: "https://example.invalid/mcp/runner",
    authorization_servers: ["https://example.invalid/"],
    scopes_supported: ["devspace", "offline_access"],
    resource_name: "Collaboration Runner"
  });

  const missing = await fetch(base + "/mcp/runner", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "host": "example.invalid"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1" }
      }
    })
  });
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate"), /resource_metadata="https:\/\/fang\.tail050659\.ts\.net\/\.well-known\/oauth-protected-resource\/mcp\/runner"/);

  const valid = await fetch(base + "/mcp/runner", {
    method: "POST",
    headers: {
      "authorization": "Bearer good-token",
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "host": "example.invalid"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1" }
      }
    })
  });
  assert.equal(valid.status, 200);
  assert.match(await valid.text(), /collaboration-runner/);
});

test("Runner resource must remain an allowed DevSpace sub-resource", async () => {
  await assert.rejects(
    startServer({
      host: "127.0.0.1",
      port: 0,
      authMode: "devspace-oauth",
      publicBaseUrl: "https://example.invalid",
      publicResourcePath: "/runner",
      devspacePublicResourcePath: "/mcp",
      verifyBearer: async () => ({ valid: true, dependencyAvailable: true })
    }),
    /not an allowed DevSpace sub-resource/
  );
});

test("OAuth verifier dependency outage returns 503 instead of invalid-token 401", async (t) => {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    authMode: "devspace-oauth",
    verifyBearer: async () => ({
      valid: false,
      dependencyAvailable: false,
      reason: "verify_unavailable"
    })
  });
  t.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  const response = await fetch("http://127.0.0.1:" + address.port + "/mcp", {
    method: "POST",
    headers: {
      "authorization": "Bearer any-token",
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "auth_dependency_unavailable");
});

test("invalid Host is rejected before MCP handling", async (t) => {
  const server = await startServer({ host: "127.0.0.1", port: 0, authMode: "none" });
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  const statusCode = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: "/mcp",
      method: "POST",
      headers: {
        "Host": "evil.example",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"
      }
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
  assert.equal(statusCode, 421);
});
