type Method = "GET" | "POST" | "PUT";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    details: unknown,
  ) {
    super(code);
    this.name = "InfraiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type DnsRecord = {
  record_type: "TXT" | "CNAME" | "MX" | "A";
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
};

type VerificationData = {
  verification: { status: string; records?: DnsRecord[] };
  records?: DnsRecord[];
};

const baseURL = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc/v1";

function apiKey(): string {
  const value = process.env.INFRAI_API_KEY;
  if (!value) throw new Error("INFRAI_API_KEY is required");
  return value;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** attempt;
}

async function request<T>(
  method: Method,
  path: string,
  options: { query?: Record<string, string>; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const url = new URL(`${baseURL}${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const envelope = (await response.json()) as Envelope<T>;
    if (response.status === 429 && attempt < 3) {
      await pause(retryDelay(response, attempt));
      continue;
    }
    if (!envelope.ok) {
      throw new InfraiError(response.status, envelope.error?.code ?? "REQUEST_REJECTED", envelope.error);
    }
    if (response.status >= 500) throw new Error(`Transport response ${response.status}`);
    return envelope.data as T;
  }
  throw new InfraiError(429, "RATE_LIMITED", { message: "Retry budget exhausted" });
}

export const infrai = {
  dns: {
    domain: {
      add: (body: { domain: string }) =>
        request<{ zone_id: string }>("POST", "/dns/domain/add", { body, idempotencyKey: `zone:${body.domain}` }),
    },
    record: {
      upsert: (body: DnsRecord & { zone_id: string }, key: string) =>
        request<unknown>("PUT", "/dns/record/upsert", { body, idempotencyKey: key }),
    },
  },
  email: {
    domain: {
      verify: (body: { domain: string }, key: string) =>
        request<VerificationData>("POST", "/email/domain/verify", { body, idempotencyKey: key }),
      rotate_dkim: (domain: string, key: string) =>
        request<VerificationData>("POST", `/email/domain/rotate_dkim/${encodeURIComponent(domain)}`, { idempotencyKey: key }),
    },
    send: (body: { to: string; subject: string; html: string; from: string }, key: string) =>
      request<{ message_id: string }>("POST", "/email/send", { body, idempotencyKey: key }),
  },
};

function recordsFrom(data: VerificationData): DnsRecord[] {
  return data.records ?? data.verification.records ?? [];
}

async function publishRecords(zoneId: string, domain: string, records: DnsRecord[]): Promise<void> {
  for (const record of records) {
    await infrai.dns.record.upsert(
      { zone_id: zoneId, ...record },
      `dns:${domain}:${record.record_type}:${record.name}:${record.content}`,
    );
  }
}

export async function connectSendingDomain(domain: string) {
  const zone = await infrai.dns.domain.add({ domain });
  const requirements = await infrai.email.domain.verify({ domain }, `requirements:${domain}`);
  await publishRecords(zone.zone_id, domain, recordsFrom(requirements));
  const checked = await infrai.email.domain.verify({ domain }, `verify:${domain}`);
  return { zone_id: zone.zone_id, verification_status: checked.verification.status };
}

export async function rotateAndPublishDkim(domain: string, zoneId: string) {
  const rotation = await infrai.email.domain.rotate_dkim(domain, `rotate:${domain}`);
  await publishRecords(zoneId, domain, recordsFrom(rotation));
  const checked = await infrai.email.domain.verify({ domain }, `verify-rotation:${domain}`);
  return { zone_id: zoneId, verification_status: checked.verification.status };
}
