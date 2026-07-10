import { SmtpEmailSender } from "./smtp.js";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

export interface EmailResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly skippedNoConfig?: boolean;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<EmailResult>;
}

export class NoopEmailSender implements EmailSender {
  async send(_msg: EmailMessage): Promise<EmailResult> {
    return { ok: false, skippedNoConfig: true };
  }
}

export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  SMTP_SECURE?: string;
}

export function createEmailSender(env: SmtpEnv): EmailSender {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return new NoopEmailSender();
  return new SmtpEmailSender({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT) || 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM,
    secure: env.SMTP_SECURE !== "false",
  });
}
