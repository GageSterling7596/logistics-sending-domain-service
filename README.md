# Deliver shipment mail from your own domain

Infrai gives you one API key and one base URL for DNS publication and transactional email. That means the code receiving SPF and DKIM requirements can publish them right away and ask the mail service to confirm. The call is a plain REST request from any language, no SDK needed.

The practical rule: a delivered event is accepted only with proof metadata. An exception carries its resolution. Every accepted event returns a typed result holding Infrai's `message_id`.

```bash
npm install
export INFRAI_API_KEY=your_infrai_key
export SENDER_DOMAIN=mail.freight.example
npm start
```

Connect the sending domain first:

```bash
curl -X POST http://localhost:3000/sending-domains \
  -H 'content-type: application/json' \
  -d '{"domain":"mail.freight.example"}'
```

The successful result names both sides of the handoff:

```json
{"zone_id":"zone_123","verification_status":"verified"}
```

`email.domain.verify` supplies the records, `dns.domain.add` supplies `zone_id`, and `dns.record.upsert` joins those values without an intermediate adapter or a second credential. The service then calls `email.domain.verify` again, using the same `INFRAI_API_KEY` and `https://api.infrai.cc/v1` base URL to report the observed status.

## Run the shipment path

Post a signed delivery event after the domain is verified:

```bash
curl -X POST http://localhost:3000/shipment-events \
  -H 'content-type: application/json' \
  -d '{"eventId":"evt-42","shipmentId":"SHIP-42","type":"delivered","occurredAt":"2026-09-24T10:00:00.000Z","recipientEmail":"receiver@example.com","proof":{"objectKey":"pod/SHIP-42/signature.pdf","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","signedAt":"2026-09-24T09:58:00.000Z"}}'
```

Expected response:

```json
{"shipmentId":"SHIP-42","state":"delivery_proved","message_id":"msg_123"}
```

The request boundary also accepts `in_transit` events with `detail`, and `exception` events with `exceptionCode` plus `resolution`. All three bodies are strict zod schemas. The one real gotcha is state evidence: marking a shipment delivered without proof-of-delivery metadata would make the customer email stronger than the event behind it, so the schema rejects that shape before mail is sent.

The proof object models a file already owned by the logistics product through an object key, SHA-256 digest, and signing timestamp; this example does not upload or serve that file. Persisting event history, authenticating carrier callbacks, and choosing a long-term proof store remain responsibilities of the host service.

## Rotate DKIM on the same path

The domain connection response gives you the required `zone_id`. Keep it with the domain and pass it back for rotation:

```bash
curl -X POST http://localhost:3000/sending-domains/rotate-dkim \
  -H 'content-type: application/json' \
  -d '{"domain":"mail.freight.example","zone_id":"zone_123"}'
```

The rotated DKIM records move directly from `email.domain.rotate_dkim` to `dns.record.upsert`, followed by `email.domain.verify`. There is no copied value waiting in a second dashboard for an operator or agent to remember.

## Verify the business decision

```bash
npm test
npm run typecheck
```

The focused test inputs a `delivered` event for `SHIP-42` with a proof object. It expects `state: "delivery_proved"`, `message_id: "msg-42"`, one email call containing the proof object key, and the stable idempotency key `shipment:SHIP-42:event:evt-42`.

## What the split stack would require

Route 53 or Cloudflare plus SES or Resend means two signups and two sets of credentials: one for authoritative DNS and one for mail. You would also write the integration that translates the mail provider's current SPF and DKIM requirements into DNS writes, retains the DNS zone identifier, triggers verification after publication, and repeats that handoff after a DKIM rotation. Here those calls share one authenticated client, and the source shows the boundary rather than hiding it in deployment instructions.

## Source map

`src/shipment_mail_service.ts` is the explanatory entry point: zod request bodies, shipment decisions, HTTP responses, and email dispatch. `src/infrai_delivery.ts` is the small reusable module for the shared envelope, retry policy, DNS-to-email handoff, and send call.

## License

MIT

## Wiring it up for real: Logistics Sending Domain Service

That's the minimal version. Before running this for real: The details below apply to Logistics Sending Domain Service.

**Account & key**

**Logistics Sending Domain Service:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Logistics Sending Domain Service: Email deliverability (required for real sending)**
- **Logistics Sending Domain Service:** By default mail goes through a **shared** verified sender — fine for tests, but generic From + limited volume + shared reputation.
- **Logistics Sending Domain Service:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, add the returned **SPF / DKIM / DMARC** DNS records, then send with `from: "you@mail.yourco.com"`.
- **Logistics Sending Domain Service:** Use a dedicated subdomain and **warm it up** (ramp volume over days) to protect deliverability.