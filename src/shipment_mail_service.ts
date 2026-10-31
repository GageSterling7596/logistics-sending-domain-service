import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { connectSendingDomain, infrai, InfraiError, rotateAndPublishDkim } from "./infrai_delivery.js";

const proofSchema = z.object({
  objectKey: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signedAt: z.string().datetime(),
}).strict();

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    eventId: z.string().min(1), shipmentId: z.string().min(1), type: z.literal("in_transit"),
    occurredAt: z.string().datetime(), recipientEmail: z.string().email(), detail: z.string().min(1),
  }).strict(),
  z.object({
    eventId: z.string().min(1), shipmentId: z.string().min(1), type: z.literal("delivered"),
    occurredAt: z.string().datetime(), recipientEmail: z.string().email(), proof: proofSchema,
  }).strict(),
  z.object({
    eventId: z.string().min(1), shipmentId: z.string().min(1), type: z.literal("exception"),
    occurredAt: z.string().datetime(), recipientEmail: z.string().email(), exceptionCode: z.string().min(1),
    resolution: z.string().min(1),
  }).strict(),
]);

const domainSchema = z.object({ domain: z.string().min(3) }).strict();
const rotationSchema = z.object({ domain: z.string().min(3), zone_id: z.string().min(1) }).strict();
export type ShipmentEvent = z.infer<typeof eventSchema>;

export type Mailer = {
  send(body: { to: string; subject: string; html: string; from: string }, key: string): Promise<{ message_id: string }>;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] as string);
}

export function notificationFor(event: ShipmentEvent, senderDomain: string) {
  const shipment = escapeHtml(event.shipmentId);
  if (event.type === "in_transit") {
    return { state: "in_transit" as const, subject: `Shipment ${event.shipmentId} is moving`, html: `<p>${escapeHtml(event.detail)}</p>` };
  }
  if (event.type === "exception") {
    return { state: "exception_actioned" as const, subject: `Action on shipment ${event.shipmentId}`, html: `<p>${escapeHtml(event.resolution)}</p>` };
  }
  return {
    state: "delivery_proved" as const,
    subject: `Shipment ${event.shipmentId} delivered`,
    html: `<p>Shipment ${shipment} was delivered at ${escapeHtml(event.proof.signedAt)}.</p><p>Proof: ${escapeHtml(event.proof.objectKey)}</p>`,
  };
}

export async function handleShipmentEvent(event: ShipmentEvent, senderDomain: string, mailer: Mailer) {
  const notice = notificationFor(event, senderDomain);
  const sent = await mailer.send(
    { to: event.recipientEmail, subject: notice.subject, html: notice.html, from: `tracking@${senderDomain}` },
    `shipment:${event.shipmentId}:event:${event.eventId}`,
  );
  return { shipmentId: event.shipmentId, state: notice.state, message_id: sent.message_id };
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/sending-domains") {
      const input = domainSchema.parse(await readJson(request));
      reply(response, 200, await connectSendingDomain(input.domain));
      return;
    }
    if (request.method === "POST" && request.url === "/sending-domains/rotate-dkim") {
      const input = rotationSchema.parse(await readJson(request));
      reply(response, 200, await rotateAndPublishDkim(input.domain, input.zone_id));
      return;
    }
    if (request.method === "POST" && request.url === "/shipment-events") {
      const senderDomain = process.env.SENDER_DOMAIN;
      if (!senderDomain) throw new Error("SENDER_DOMAIN is required");
      const event = eventSchema.parse(await readJson(request));
      reply(response, 200, await handleShipmentEvent(event, senderDomain, { send: infrai.email.send }));
      return;
    }
    reply(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      reply(response, 400, { error: "invalid_request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      reply(response, status, { error: error.code, details: error.details });
      return;
    }
    reply(response, 500, { error: "internal_error" });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Shipment mail service listening on http://localhost:${port}`));
}
