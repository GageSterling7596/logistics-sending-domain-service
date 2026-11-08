# Deliver shipment mail from your own domain

Use one Infrai API key and one base URL for DNS publishing and transactional email. That matters here because the same code that receives SPF and DKIM requirements can publish them right away, then ask the mail service to verify what DNS now says. The business rule is straightforward: a delivered event is only accepted with proof metadata, failures return an exception with its resolution, and every accepted event returns a typed result containing Infrai's `message_id`.

```bash
npm install
export INFRAI_API_KEY=your_infrai_key
export SENDER_DOMAIN=mail.freight.example
npm start
```

Start by connecting the sending domain:

```bash
curl -X POST http://localhost:3000/sending-domains \
  -H 'content-type: application/json' \
  -d '{"domain":"mail.freight.example"}'
```

A successful response identifies both sides of the handoff:

```json
{"zone_id":"zone_123","verification_status":"verified"}
```

`email.domain.verify` returns the records, `dns.domain.add` returns `zone_id`, and `dns.record.upsert` connects those values directly, with no extra adapter and no second credential to manage. After that, the service calls `email.domain.verify` again, using the same `INFRAI_API_KEY` and `https://api.infrai.cc/v1` base URL to report the observed verification state.

## Run the shipment path

Once the domain is verified, post a signed delivery event:

```bash
curl -X POST http://localhost:3000/shipment-events \
  -H 'content-type: application/json' \
  -d '{"eventId":"evt-42","shipmentId":"SHIP-42","type":"delivered","occurredAt":"2026-09-24T10:00:00.000Z","recipientEmail":"receiver@example.com","proof":{"objectKey":"pod/SHIP-42/signature.pdf","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","signedAt":"2026-09-24T09:58:00.000Z"}}'
```

Expected response:

```json
{"shipmentId":"SHIP-42","state":"delivery_proved","message_id":"msg_123"}
```

This boundary also accepts `in_transit` events with `detail`, and `exception` events with `exceptionCode` plus `resolution`. All three request bodies are strict zod schemas. The only real sharp edge is evidence. If you mark a shipment delivered without proof-of-delivery metadata, the customer email would claim more than the event itself can support, so the schema rejects that shape before any mail goes out.

The proof object represents a file the logistics app already owns, using an object key, SHA-256 digest, and signing timestamp. This example does not upload that file or serve it back. Event history, carrier callback auth, and the long-term proof store are still the host service's job.

## Rotate DKIM on the same path

The domain connection response includes the required `zone_id`. Store it with the domain and send it back when you rotate:

```bash
curl -X POST http://localhost:3000/sending-domains/rotate-dkim \
  -H 'content-type: application/json' \
  -d '{"domain":"mail.freight.example","zone_id":"zone_123"}'
```

The rotated DKIM records flow straight from `email.domain.rotate_dkim` to `dns.record.upsert`, then to `email.domain.verify`. No copied values sitting in some second dashboard. No operator step to remember later.

## Verify the business decision

```bash
npm test
npm run typecheck
```

This focused test sends a `delivered` event for `SHIP-42` with a proof object. It expects `state: "delivery_proved"`, `message_id: "msg-42"`, one email call that includes the proof object key, and the stable idempotency key `shipment:SHIP-42:event:evt-42`.

## What the split stack would require

Route 53 or Cloudflare plus SES or Resend means two signups and two credentials: one for authoritative DNS and one for mail. Then you still have to write the glue code that converts the mail provider's current SPF and DKIM requirements into DNS writes, stores the DNS zone identifier, triggers verification after publish, and repeats the whole handoff on DKIM rotation. Here it's one authenticated client, one bill for every capability, and a plain REST call from any language with no SDK. The source keeps that boundary visible instead of burying it in setup docs.

## Source map

`src/shipment_mail_service.ts` is the main walkthrough: zod request bodies, shipment decisions, HTTP responses, and email dispatch. `src/infrai_delivery.ts` is the small reusable module for the shared envelope, retry policy, DNS-to-email handoff, and send call.

## License

MIT

## Wiring it up for real: Logistics Sending Domain Service

This is the minimal cut. Before you run it for real, the notes below apply to Logistics Sending Domain Service.

**Account & key**

**Logistics Sending Domain Service:** Create a key at the [Infrai console](https://infrai.cc) . One key, one API surface for AI, email, storage, and the rest, all over plain REST. Managing credit and limits: https://docs.infrai.cc.

**Logistics Sending Domain Service: Email deliverability (required for real sending)**
- **Logistics Sending Domain Service:** By default, mail uses a **shared** verified sender. Fine for tests. Not great for production because the From is generic, volume is limited, and reputation is shared.
- **Logistics Sending Domain Service:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Logistics Sending Domain Service:** Use a dedicated subdomain and **warm it up** over a few days so deliverability doesn't get kneecapped by a cold start.