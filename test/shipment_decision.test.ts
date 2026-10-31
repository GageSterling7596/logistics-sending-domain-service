import assert from "node:assert/strict";
import test from "node:test";
import { handleShipmentEvent } from "../src/shipment_mail_service.js";

test("a delivered shipment sends proof details and exposes the delivery transition", async () => {
  const calls: Array<{ subject: string; html: string; key: string }> = [];
  const result = await handleShipmentEvent({
    eventId: "evt-42",
    shipmentId: "SHIP-42",
    type: "delivered",
    occurredAt: "2026-09-24T10:00:00.000Z",
    recipientEmail: "receiver@example.com",
    proof: {
      objectKey: "pod/SHIP-42/signature.pdf",
      sha256: "a".repeat(64),
      signedAt: "2026-09-24T09:58:00.000Z",
    },
  }, "mail.freight.example", {
    async send(body, key) {
      calls.push({ subject: body.subject, html: body.html, key });
      return { message_id: "msg-42" };
    },
  });

  assert.deepEqual(result, { shipmentId: "SHIP-42", state: "delivery_proved", message_id: "msg-42" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].html, /pod\/SHIP-42\/signature\.pdf/);
  assert.equal(calls[0].key, "shipment:SHIP-42:event:evt-42");
});
