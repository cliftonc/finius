import { gunzipSync } from "node:zlib";
import { ServiceClientType, getExportRequestProto } from "@opentelemetry/otlp-proto-exporter-base";

export type OtlpSignal = "traces" | "metrics" | "logs";

const PROTO_BY_SIGNAL: Record<OtlpSignal, ServiceClientType> = {
  traces: ServiceClientType.SPANS,
  metrics: ServiceClientType.METRICS,
  logs: ServiceClientType.LOGS
};

export class OtlpDecodeError extends Error {
  constructor(
    message: string,
    public status = 415
  ) {
    super(message);
  }
}

export function decodeOtlpBody(raw: Uint8Array, signal: OtlpSignal, contentType?: string | null, contentEncoding?: string | null): unknown {
  const body = contentEncoding?.toLowerCase() === "gzip" ? gunzipSync(raw) : Buffer.from(raw);
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("json") || looksLikeJson(body)) return decodeJson(body);
  if (type.includes("protobuf") || type.includes("proto")) return decodeProtobuf(body, signal);
  // OTLP/HTTP defaults to protobuf when content-type is omitted by some clients.
  try {
    return decodeProtobuf(body, signal);
  } catch {
    return decodeJson(body);
  }
}

function decodeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new OtlpDecodeError("expected OTLP JSON or protobuf body", 415);
  }
}

function decodeProtobuf(body: Buffer, signal: OtlpSignal): unknown {
  try {
    const proto = getExportRequestProto(PROTO_BY_SIGNAL[signal]) as unknown as {
      decode: (body: Uint8Array) => unknown;
      toObject: (message: unknown, options: Record<string, unknown>) => unknown;
    };
    const decoded = proto.decode(body);
    return proto.toObject(decoded, {
      longs: String,
      enums: Number,
      bytes: String,
      defaults: false,
      arrays: true,
      objects: true
    });
  } catch (error) {
    throw new OtlpDecodeError(`invalid OTLP/protobuf ${signal} request: ${(error as Error).message}`, 400);
  }
}

function looksLikeJson(body: Buffer): boolean {
  const first = body.toString("utf8", 0, Math.min(body.length, 32)).trimStart()[0];
  return first === "{" || first === "[";
}
