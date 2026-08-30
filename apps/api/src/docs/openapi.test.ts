import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpenApi, registerOpenApiUi } from "./openapi.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("OpenAPI documentation", () => {
  it("exposes Swagger UI and a merged main/Billing OpenAPI document", async () => {
    const app = Fastify();
    apps.push(app);

    await registerOpenApi(app);
    app.post("/api/auth/register", async () => ({ token: "test" }));
    app.post("/api/auth/login", async () => ({ token: "test" }));
    app.get("/api/admin/users/:id/detail", async () => ({ success: true }));
    await registerOpenApiUi(app);
    await app.ready();

    const specification = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(specification.statusCode).toBe(200);

    const document = specification.json();
    expect(document.openapi).toBe("3.0.3");
    expect(document.paths["/api/auth/login"].post.tags).toEqual(["认证"]);
    expect(document.paths["/api/auth/login"].post.security).toEqual([]);
    expect(document.paths["/api/auth/login"].post.requestBody.content["application/json"].schema.required).toEqual([
      "identifier",
      "password",
    ]);
    const registerSchema = document.paths["/api/auth/register"].post.requestBody.content["application/json"].schema;
    expect(registerSchema.required).toEqual(["username", "password"]);
    expect(registerSchema.properties).not.toHaveProperty("channelCode");

    expect(document.paths["/api/admin/users/{id}/detail"].get.tags).toEqual(["管理 · 用户"]);
    expect(document.paths["/api/admin/users/{id}/detail"].get.security).toEqual([{ adminBearerAuth: [] }]);
    expect(document.paths["/api/admin/users/{id}/detail"].get.parameters[0]).toMatchObject({
      name: "id",
      in: "path",
      required: true,
    });

    expect(document.paths["/resource/charge"].post.tags).toEqual(["Billing · 资源计费"]);
    expect(document.paths["/resource/charge"].post.security).toEqual([{ billingInternalToken: [] }]);
    expect(document.paths["/resource/charge"].post.servers[0].url).toContain("8093");
    expect(document.components.securitySchemes.billingInternalToken.name).toBe("X-Internal-Token");

    const ui = await app.inject({ method: "GET", url: "/docs/" });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain("AI 助手 API 文档");
  });

  it("marks multipart and SSE endpoints with their wire formats", async () => {
    const app = Fastify();
    apps.push(app);

    await registerOpenApi(app);
    app.post("/api/kb/:id/documents", async () => ({ success: true }));
    app.get("/api/workflow/novels/projects/:projectId/runs/:runId/events/stream", async () => "");
    await registerOpenApiUi(app);
    await app.ready();

    const document = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    const upload = document.paths["/api/kb/{id}/documents"].post;
    expect(upload.requestBody.content["multipart/form-data"].schema.properties.file.format).toBe("binary");

    const stream = document.paths["/api/workflow/novels/projects/{projectId}/runs/{runId}/events/stream"].get;
    expect(stream.responses["200"].content["text/event-stream"]).toBeDefined();
  });
});
