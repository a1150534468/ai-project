import { describe, it, expect } from "vitest";
import { NoopEmailSender, createEmailSender } from "./sender.js";

describe("EmailSender", () => {
  it("Noop 永远返回未发送、不抛错", async () => {
    const r = await new NoopEmailSender().send({ to: "a@b.com", subject: "s", html: "<p>x</p>" });
    expect(r.ok).toBe(false);
    expect(r.skippedNoConfig).toBe(true);
  });

  it("未配置 SMTP_HOST → 工厂返回 Noop", () => {
    expect(createEmailSender({})).toBeInstanceOf(NoopEmailSender);
  });

  it("配置了 SMTP_HOST + FROM → 工厂返回非 Noop", () => {
    const sender = createEmailSender({ SMTP_HOST: "smtp.test", SMTP_FROM: "no-reply@test" });
    expect(sender).not.toBeInstanceOf(NoopEmailSender);
  });
});
