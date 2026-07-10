import nodemailer, { type Transporter } from "nodemailer";
import type { EmailMessage, EmailResult, EmailSender } from "./sender.js";

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
  readonly secure: boolean;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  constructor(private readonly cfg: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
  }

  async send(msg: EmailMessage): Promise<EmailResult> {
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        await this.transporter.sendMail({ from: this.cfg.from, to: msg.to, subject: msg.subject, html: msg.html });
        return { ok: true };
      } catch (err) {
        if (attempt >= 1) return { ok: false, error: err instanceof Error ? err.message : "邮件发送失败" };
      }
    }
    return { ok: false, error: "邮件发送失败" };
  }
}
