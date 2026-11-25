/**
 * Feedback form API: suggestions, problem reports and help requests from
 * the website (public pages included) are emailed to the maintainer.
 * No auth required — but when a valid token is present the sender's
 * account email is attached so they can be answered.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, APP_VERSION } from "../config.js";
import type { AuthHooks } from "../auth/plugin.js";
import type { MailSender } from "../services/mailer.js";

const feedbackSchema = z.object({
  kind: z.enum(["suggestion", "problem", "help"]),
  message: z.string().trim().min(10).max(5000),
  /** Optional contact address typed into the form. */
  email: z.string().trim().email().max(254).optional().or(z.literal("")),
});

const KIND_SUBJECT: Record<z.infer<typeof feedbackSchema>["kind"], string> = {
  suggestion: "Suggestion",
  problem: "Problem report",
  help: "Help request",
};

export interface FeedbackDeps {
  auth: AuthHooks;
  sendMail: MailSender | null;
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackDeps): void {
  const { auth, sendMail } = deps;

  app.post("/api/feedback", async (req, reply) => {
    if (!sendMail) {
      return reply.code(503).send({ error: "feedback is not configured on this server" });
    }
    const body = feedbackSchema.parse(req.body ?? {});

    // Soft auth: a logged-in sender gets their account attached, but the
    // form also works for visitors who are not signed in.
    let account: string | null = null;
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Bearer ")) {
      try {
        const user = await auth.resolveUser(header.slice(7));
        account = user.email;
      } catch {
        // Expired/invalid token: treat as anonymous rather than rejecting.
      }
    }

    const contact = body.email || account;
    const lines = [
      body.message,
      "",
      "---",
      `Kind: ${KIND_SUBJECT[body.kind]}`,
      `Contact: ${contact ?? "(none given)"}`,
      `Account: ${account ?? "(not signed in)"}`,
      `App version: ${APP_VERSION}`,
      `Sent: ${new Date().toISOString()}`,
    ];
    try {
      await sendMail({
        to: config.feedbackEmail,
        subject: `[Helio] ${KIND_SUBJECT[body.kind]}${contact ? ` from ${contact}` : ""}`,
        text: lines.join("\n"),
        replyTo: contact ?? undefined,
      });
    } catch (err) {
      req.log.error(err, "feedback email failed");
      return reply.code(502).send({ error: "could not send your message — try again later" });
    }
    return reply.code(201).send({ ok: true });
  });
}
