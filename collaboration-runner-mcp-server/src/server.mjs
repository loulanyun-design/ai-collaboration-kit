import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, result, resume, status, submit } from "./bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const SERVER_VERSION = String(PACKAGE_JSON.version || "0.0.0");

const DEFAULT_PUBLIC_BASE_URL = "https://example.invalid";
const DEFAULT_PUBLIC_RESOURCE_PATH = "/mcp/runner";
const DEFAULT_DEVSPACE_PUBLIC_RESOURCE_PATH = "/mcp";
const DEFAULT_DEVSPACE_VERIFY_URL = "http://127.0.0.1:7677/mcp";
const DEFAULT_SCOPE = "devspace";
const DEFAULT_SCOPES = ["devspace", "offline_access"];

async function loadMcpRuntime() {
  const sdkPackage = path.join(ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
  const zodPackage = path.join(ROOT, "node_modules", "zod", "package.json");
  if (!fs.existsSync(sdkPackage) || !fs.existsSync(zodPackage)) {
    throw new Error(
      "Project-local MCP dependencies are missing. Run npm ci in collaboration-runner-mcp-server."
    );
  }

  const sdkMeta = JSON.parse(fs.readFileSync(sdkPackage, "utf8"));
  const zodMeta = JSON.parse(fs.readFileSync(zodPackage, "utf8"));
  const [
    { McpServer },
    { StreamableHTTPServerTransport },
    { checkResourceAllowed },
    z
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/shared/auth-utils.js"),
    import("zod")
  ]);

  return {
    McpServer,
    StreamableHTTPServerTransport,
    checkResourceAllowed,
    z,
    source: "project-local",
    sdkVersion: String(sdkMeta.version || ""),
    zodVersion: String(zodMeta.version || "")
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_PUBLIC_BASE_URL));
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeResourcePath(value) {
  let p = String(value || DEFAULT_PUBLIC_RESOURCE_PATH).trim();
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/, "");
  if (!p || p === "/") throw new Error("public resource path must not be root");
  return p;
}

function runtimeConfig(options = {}) {
  const publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl ?? process.env.COLLAB_RUNNER_MCP_PUBLIC_BASE_URL);
  const publicResourcePath = normalizeResourcePath(options.publicResourcePath ?? process.env.COLLAB_RUNNER_MCP_PUBLIC_RESOURCE_PATH);
  const publicResourceUrl = new URL(publicResourcePath, publicBaseUrl + "/").toString();
  const devspacePublicResourcePath = normalizeResourcePath(
    options.devspacePublicResourcePath ??
    process.env.COLLAB_RUNNER_MCP_DEVSPACE_PUBLIC_RESOURCE_PATH ??
    DEFAULT_DEVSPACE_PUBLIC_RESOURCE_PATH
  );
  const devspacePublicResourceUrl = new URL(devspacePublicResourcePath, publicBaseUrl + "/").toString();
  const metadataPath = "/.well-known/oauth-protected-resource" + publicResourcePath;
  const metadataUrl = new URL(metadataPath, publicBaseUrl + "/").toString();
  const oauthIssuer = new URL("/", publicBaseUrl + "/").toString();
  const authMode = String(options.authMode ?? process.env.COLLAB_RUNNER_MCP_AUTH_MODE ?? "devspace-oauth");
  if (!["devspace-oauth", "none"].includes(authMode)) throw new Error("unsupported auth mode");

  return {
    host: String(options.host || process.env.COLLAB_RUNNER_MCP_HOST || "127.0.0.1"),
    port: Number(options.port ?? process.env.COLLAB_RUNNER_MCP_PORT ?? 7678),
    authMode,
    publicBaseUrl,
    publicResourcePath,
    publicResourceUrl,
    devspacePublicResourcePath,
    devspacePublicResourceUrl,
    metadataPath,
    metadataUrl,
    oauthIssuer,
    requiredScope: String(options.requiredScope ?? process.env.COLLAB_RUNNER_MCP_REQUIRED_SCOPE ?? DEFAULT_SCOPE),
    scopesSupported: DEFAULT_SCOPES,
    devspaceVerifyUrl: String(options.devspaceVerifyUrl ?? process.env.COLLAB_RUNNER_MCP_DEVSPACE_VERIFY_URL ?? DEFAULT_DEVSPACE_VERIFY_URL)
  };
}

function jsonToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

function errorToolResult(err) {
  return {
    content: [{ type: "text", text: String(err && err.message ? err.message : err) }],
    isError: true
  };
}

function createToolServer(runtime) {
  const { McpServer, z } = runtime;
  const server = new McpServer({
    name: "collaboration-runner",
    version: SERVER_VERSION
  }, {
    capabilities: { tools: {} },
    instructions: "Thin controlled MCP transport for the existing Collaboration Runner. Do not use runner_submit unless the user explicitly authorized Runner/Codex delegation in the current request."
  });

  const projectSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).describe("Registered collaboration project id");
  const jobSchema = z.string().regex(/^[0-9a-f]{32}$/).describe("Runner job id");

  server.registerTool("runner_preflight", {
    description: "Read-only Runner preflight using the Runner's own validateReadyProject logic. It does not start Codex or create a job.",
    inputSchema: z.object({ project: projectSchema })
  }, async ({ project }) => {
    try { return jsonToolResult(await preflight(project)); }
    catch (err) { return errorToolResult(err); }
  });

  server.registerTool("runner_submit", {
    description: "Submit the current READY handoff through the existing Collaboration Runner. Call only after the user explicitly asked to delegate to Codex/Runner. No arbitrary prompt or shell command is accepted.",
    inputSchema: z.object({
      project: projectSchema,
      model_route: z.enum(["retrieval", "execution", "escalation"]).optional()
    })
  }, async (args) => {
    try { return jsonToolResult(await submit(args)); }
    catch (err) { return errorToolResult(err); }
  });

  server.registerTool("runner_status", {
    description: "Read Runner job status by job id, or by the current task/revision of a registered project.",
    inputSchema: z.object({
      project: projectSchema.optional(),
      job: jobSchema.optional()
    }).refine((v) => Boolean(v.project || v.job), "project or job is required")
  }, async (args) => {
    try { return jsonToolResult(await status(args)); }
    catch (err) { return errorToolResult(err); }
  });

  server.registerTool("runner_result", {
    description: "Read the job summary and matching RESULT.md snapshot without changing Runner or handoff state.",
    inputSchema: z.object({
      project: projectSchema.optional(),
      job: jobSchema.optional()
    }).refine((v) => Boolean(v.project || v.job), "project or job is required")
  }, async (args) => {
    try { return jsonToolResult(await result(args)); }
    catch (err) { return errorToolResult(err); }
  });

  server.registerTool("runner_resume", {
    description: "Read the bounded current Runner/handoff/result/continuation summary for a registered project. It does not launch a new executor. Pass diagnosis_complete after local failure diagnosis, or unavailable_count to apply bounded retry/checkpoint behavior for the same step.",
    inputSchema: z.object({
      project: projectSchema,
      diagnosis_complete: z.boolean().optional(),
      unavailable_count: z.number().int().min(0).max(2).optional()
    })
  }, async (args) => {
    try { return jsonToolResult(await resume(args)); }
    catch (err) { return errorToolResult(err); }
  });

  return server;
}

function hostNameFromHeader(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(0, end + 1).toLowerCase() : raw.toLowerCase();
  }
  return raw.split(":")[0].toLowerCase();
}

function allowedHosts(config) {
  const env = String(process.env.COLLAB_RUNNER_MCP_ALLOWED_HOSTS || "");
  const extra = env.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const publicHost = new URL(config.publicResourceUrl).hostname.toLowerCase();
  return new Set(["127.0.0.1", "localhost", "[::1]", publicHost, ...extra]);
}

function sendJson(res, statusCode, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    ...headers
  });
  res.end(body);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function wwwAuthenticate(config, description = "Missing or invalid access token") {
  return `Bearer error="invalid_token", error_description="${description.replace(/"/g, "'")}", scope="${config.requiredScope}", resource_metadata="${config.metadataUrl}"`;
}

function protectedResourceMetadata(config) {
  return {
    resource: config.publicResourceUrl,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: config.scopesSupported,
    resource_name: "Collaboration Runner"
  };
}

function tokenCacheKey(token) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function createDevSpaceTokenVerifier({
  verifyUrl = DEFAULT_DEVSPACE_VERIFY_URL,
  ttlMs = 30000,
  fetchImpl = fetch
} = {}) {
  const cache = new Map();

  return async function verifyBearer(token) {
    if (!token) {
      return { valid: false, dependencyAvailable: true, reason: "missing_token", status: null };
    }

    const key = tokenCacheKey(token);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.result;

    let response;
    try {
      response = await fetchImpl(verifyUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          "authorization": "Bearer " + token,
          "content-type": "application/json",
          "accept": "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "runner-auth-probe",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "collaboration-runner-auth-probe", version: SERVER_VERSION }
          }
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      return {
        valid: false,
        dependencyAvailable: false,
        reason: "verify_unavailable",
        status: null,
        diagnostic: String(err && err.name ? err.name : "fetch_error")
      };
    }

    const valid = response.status === 200;
    const dependencyAvailable = response.status < 500;
    const result = {
      valid,
      dependencyAvailable,
      reason: valid
        ? "valid"
        : (dependencyAvailable ? "token_rejected" : "verify_unavailable"),
      status: response.status
    };

    try { await response.body?.cancel(); } catch {}

    if (dependencyAvailable) {
      cache.set(key, { result, expiresAt: now + (valid ? ttlMs : 3000) });
      if (cache.size > 256) {
        for (const [cacheKey, entry] of cache) {
          if (entry.expiresAt <= now) cache.delete(cacheKey);
        }
      }
    }
    return result;
  };
}

async function ensureAuthorized(req, res, config, verifier) {
  if (config.authMode === "none") return true;
  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, {
      error: "invalid_token",
      error_description: "Missing Authorization header"
    }, {
      "www-authenticate": wwwAuthenticate(config, "Missing Authorization header")
    });
    return false;
  }

  const raw = await verifier(token);
  const verification = typeof raw === "boolean"
    ? { valid: raw, dependencyAvailable: true, reason: raw ? "valid" : "token_rejected" }
    : raw;

  if (!verification || verification.dependencyAvailable === false) {
    sendJson(res, 503, {
      error: "auth_dependency_unavailable",
      error_description: "Authorization verifier is temporarily unavailable"
    }, {
      "retry-after": "1"
    });
    return false;
  }

  if (!verification.valid) {
    sendJson(res, 401, {
      error: "invalid_token",
      error_description: "Invalid or expired access token"
    }, {
      "www-authenticate": wwwAuthenticate(config, "Invalid or expired access token")
    });
    return false;
  }
  return true;
}

export async function startServer(options = {}) {
  const runtime = await loadMcpRuntime();
  const config = runtimeConfig(options);
  const oauthResourceRelationshipVerified = runtime.checkResourceAllowed({
    requestedResource: config.publicResourceUrl,
    configuredResource: config.devspacePublicResourceUrl
  });
  if (config.authMode === "devspace-oauth" && !oauthResourceRelationshipVerified) {
    throw new Error(
      "Runner OAuth resource is not an allowed DevSpace sub-resource: " +
      config.publicResourceUrl + " under " + config.devspacePublicResourceUrl
    );
  }

  const hosts = allowedHosts(config);
  const verifyBearer = options.verifyBearer || createDevSpaceTokenVerifier({ verifyUrl: config.devspaceVerifyUrl });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "collaboration-runner-mcp",
          version: SERVER_VERSION,
          authMode: config.authMode,
          publicResource: config.publicResourceUrl,
          sdkSource: runtime.source,
          sdkVersion: runtime.sdkVersion,
          zodVersion: runtime.zodVersion,
          runtimeReady: runtime.source === "project-local",
          authBoundary: config.authMode === "devspace-oauth"
            ? "shared-devspace-parent-resource"
            : "test-auth-disabled",
          devspacePublicResource: config.devspacePublicResourceUrl,
          oauthResourceRelationship: "same-origin-subpath",
          oauthResourceRelationshipVerified,
          resourceRelationshipVerifier: "@modelcontextprotocol/sdk/shared/auth-utils#checkResourceAllowed",
          runnerRoot: process.env.COLLAB_RUNNER_ROOT || "D:\\MCP-Test\\collaboration-runner-pilot"
        });
        return;
      }

      if (url.pathname === config.metadataPath || url.pathname === "/.well-known/oauth-protected-resource") {
        sendJson(res, 200, protectedResourceMetadata(config));
        return;
      }

      const acceptedMcpPaths = new Set(["/mcp", config.publicResourcePath]);
      if (!acceptedMcpPaths.has(url.pathname)) {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      const hostHeader = hostNameFromHeader(req.headers.host);
      if (!hosts.has(hostHeader)) {
        sendJson(res, 421, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Invalid Host header" },
          id: null
        });
        return;
      }

      if (!(await ensureAuthorized(req, res, config, verifyBearer))) return;

      if (!["POST", "GET", "DELETE"].includes(req.method || "")) {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      const toolServer = createToolServer(runtime);
      const transport = new runtime.StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      await toolServer.connect(transport);
      res.on("close", () => {
        void transport.close().catch(() => {});
        void toolServer.close().catch(() => {});
      });
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: String(err && err.message ? err.message : err) },
          id: null
        });
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  server.mcpRuntimeSource = runtime.source;
  server.mcpConfig = config;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer();
  const address = server.address();
  console.error("[collaboration-runner-mcp] listening on", typeof address === "object" && address ? address.address + ":" + address.port : String(address));
  console.error("[collaboration-runner-mcp] resource:", server.mcpConfig.publicResourceUrl);
  console.error("[collaboration-runner-mcp] auth:", server.mcpConfig.authMode);
  console.error("[collaboration-runner-mcp] SDK source:", server.mcpRuntimeSource);
}
