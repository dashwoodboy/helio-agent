/**
 * Outbound email over SMTP (nodemailer). Used only by the feedback form;
 * when SMTP_HOST is not configured the feature is simply off and the API
 * reports that instead of failing sends.
 */
import nodemailer from "nodemailer";
import { config } from "../config.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Visitor's address, so a plain "Reply" answers them directly. */
  replyTo?: string;
}

export type MailSender = (msg: MailMessage) => Promise<void>;

/** SMTP-backed sender, or null when SMTP is not configured. */
export function createMailer(): MailSender | null {
  if (!config.smtpHost) return null;
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  const from = config.smtpUser || `helio@${config.smtpHost}`;
  return async (msg) => {
    await transport.sendMail({ from: `"Helio" <${from}>`, ...msg });
  };
}
