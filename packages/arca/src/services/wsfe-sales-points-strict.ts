import {
  ArcaAuthenticationError,
  ArcaInvalidSoapResponseError,
  ArcaSalesPointsStrictError,
  ArcaSoapFaultError,
  ArcaTransportError,
} from "../errors";

/** Opciones de lectura estricta; la recuperación requiere autorización explícita. */
export type WsfeSalesPointsStrictInput = {
  representedTaxId?: number | string;
  forceRefresh?: boolean;
  abortSignal?: AbortSignal;
  authenticationRecovery?: boolean;
};

/** FchBaja es opcional: no se confunde una omisión con una fecha inválida. */
export type WsfeSalesPointStrict = {
  number: number;
  emissionType: "CAE" | "CAEA";
  blocked: boolean;
  deletion: { kind: "absent" | "empty" } | { kind: "date"; date: string };
};

/** Códigos públicos, sin mensajes remotos, XML ni credenciales. */
export type WsfeSalesPointsStrictIssue = {
  source: "error" | "event";
  code: number;
};

/** Evidencia saneada de la falla que motivó el único refresh permitido. */
export type WsfeSalesPointsStrictRecovery = NonNullable<
  ArcaSalesPointsStrictError["recovery"]
>;

export type WsfeSalesPointsStrictResult = {
  kind: "points" | "empty";
  points: WsfeSalesPointStrict[];
  events: WsfeSalesPointsStrictIssue[];
  service: "wsfe";
  operation: "FEParamGetPtosVenta";
  /** Contexto solicitado, no un eco de identidad certificado por WSFE. */
  representedTaxId: string;
  environment: "test" | "production";
  /** Intentos lógicos (login + lectura), no cantidad de requests HTTP. */
  attempts: number;
  authenticationRecovered: boolean;
  recovery?: WsfeSalesPointsStrictRecovery;
};

function invalid(
  field: string,
  fieldState: "absent" | "invalid" | "duplicate" = "invalid"
): never {
  throw new ArcaSalesPointsStrictError({
    reason: "invalid_response",
    field,
    fieldState,
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(field);
  }
  return value as Record<string, unknown>;
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function unwrap(value: unknown): Record<string, unknown> {
  const envelope = record(value, "envelope");
  const responseKey = "FEParamGetPtosVentaResponse";
  const resultKey = "FEParamGetPtosVentaResult";
  const allowed = new Set([
    responseKey,
    resultKey,
    "ResultGet",
    "Errors",
    "Events",
  ]);
  if (
    Object.keys(envelope).some(
      (key) => !(allowed.has(key) || key.startsWith("@_xmlns"))
    )
  ) {
    return invalid("envelope");
  }
  if (has(envelope, responseKey)) {
    if (
      has(envelope, resultKey) ||
      has(envelope, "ResultGet") ||
      has(envelope, "Errors")
    ) {
      return invalid("envelope");
    }
    const response = record(envelope[responseKey], "envelope");
    if (
      Object.keys(response).some(
        (key) => key !== resultKey && !key.startsWith("@_xmlns")
      )
    ) {
      return invalid("envelope");
    }
    return record(response[resultKey], "envelope");
  }
  if (has(envelope, resultKey)) {
    if (has(envelope, "ResultGet") || has(envelope, "Errors")) {
      return invalid("envelope");
    }
    return record(envelope[resultKey], "envelope");
  }
  // También admite el resultado directo usado por los transportes inyectables.
  return envelope;
}

function integer(value: unknown, field: string, max: number): number {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && /^\d+$/.test(value))
  ) {
    return invalid(field);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    return invalid(field);
  }
  return number;
}

function issues(
  result: Record<string, unknown>,
  container: "Errors" | "Events",
  key: "Err" | "Evt",
  source: "error" | "event"
): WsfeSalesPointsStrictIssue[] {
  if (!has(result, container) || result[container] === "") {
    return [];
  }
  const group = record(result[container], container);
  if (!has(group, key)) {
    return invalid(container, "absent");
  }
  const entries = Array.isArray(group[key]) ? group[key] : [group[key]];
  return Array.from(entries, (entry: unknown) => ({
    source,
    code: integer(
      record(entry, container).Code,
      `${container}.Code`,
      2_147_483_647
    ),
  }));
}

function deletion(
  point: Record<string, unknown>
): WsfeSalesPointStrict["deletion"] {
  if (!has(point, "FchBaja")) {
    return { kind: "absent" };
  }
  if (point.FchBaja === "") {
    return { kind: "empty" };
  }
  if (typeof point.FchBaja !== "string" || !/^\d{8}$/.test(point.FchBaja)) {
    return invalid("FchBaja");
  }
  const year = Number(point.FchBaja.slice(0, 4));
  const month = Number(point.FchBaja.slice(4, 6));
  const day = Number(point.FchBaja.slice(6, 8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    return invalid("FchBaja");
  }
  return {
    kind: "date",
    date: `${point.FchBaja.slice(0, 4)}-${point.FchBaja.slice(4, 6)}-${point.FchBaja.slice(6, 8)}`,
  };
}

/** Valida antes del mapper permisivo; nunca devuelve parcialmente una lista inválida. */
export function parseWsfeSalesPointsStrict(value: unknown) {
  const result = unwrap(value);
  const errors = issues(result, "Errors", "Err", "error");
  const events = issues(result, "Events", "Evt", "event");
  if (errors.length > 0) {
    // No se descarta ni una contradicción ni códigos secundarios (incluido 602).
    const authentication = errors.every(
      ({ code }) => code === 600 || code === 601
    );
    throw new ArcaSalesPointsStrictError({
      reason: has(result, "ResultGet")
        ? "invalid_response"
        : authentication
          ? "authentication_error"
          : "service_error",
      issues: [...errors, ...events],
      providerCode: authentication ? errors[0].code : undefined,
      authenticationReason: authentication
        ? errors[0].code === 600
          ? "invalid_token"
          : "missing_relationship"
        : undefined,
    });
  }
  if (!has(result, "ResultGet")) {
    return invalid("ResultGet", "absent");
  }
  const group = record(result.ResultGet, "ResultGet");
  if (!has(group, "PtoVenta")) {
    return invalid("ResultGet.PtoVenta", "absent");
  }
  const entries = Array.isArray(group.PtoVenta)
    ? group.PtoVenta
    : [group.PtoVenta];
  const seen = new Set<number>();
  const points: WsfeSalesPointStrict[] = Array.from(
    entries,
    (entry: unknown) => {
      const point = record(entry, "PtoVenta");
      for (const field of ["Nro", "EmisionTipo", "Bloqueado"]) {
        if (!has(point, field)) {
          return invalid(field, "absent");
        }
      }
      const number = integer(point.Nro, "Nro", 99_998);
      if (seen.has(number)) {
        return invalid("duplicate.Nro", "duplicate");
      }
      seen.add(number);
      if (point.EmisionTipo !== "CAE" && point.EmisionTipo !== "CAEA") {
        return invalid("EmisionTipo");
      }
      if (point.Bloqueado !== "S" && point.Bloqueado !== "N") {
        return invalid("Bloqueado");
      }
      return {
        number,
        emissionType: point.EmisionTipo,
        blocked: point.Bloqueado === "S",
        deletion: deletion(point),
      };
    }
  );
  return {
    kind: points.length === 0 ? ("empty" as const) : ("points" as const),
    points,
    events,
  };
}

/** No copia mensajes, cause, stack, previews ni objetos arbitrarios del transporte. */
export function sanitizeWsfeSalesPointsStrictError(
  error: unknown,
  attempts: number,
  aborted: boolean,
  recovery?: WsfeSalesPointsStrictRecovery
): ArcaSalesPointsStrictError {
  const context = { attempts, recovery };
  if (aborted) {
    return new ArcaSalesPointsStrictError({ reason: "aborted", ...context });
  }
  if (error instanceof ArcaSalesPointsStrictError) {
    return new ArcaSalesPointsStrictError({
      reason: error.reason,
      field: error.field,
      fieldState: error.fieldState,
      issues: error.issues,
      providerCode: error.providerCode,
      authenticationReason: error.authenticationReason,
      originService: "wsfe",
      originOperation: "FEParamGetPtosVenta",
      ...context,
    });
  }
  if (error instanceof ArcaAuthenticationError) {
    return new ArcaSalesPointsStrictError({
      reason: "authentication_error",
      originalCode: "ARCA_AUTHENTICATION_ERROR",
      ...context,
      ...authenticationMetadata(error),
    });
  }
  if (error instanceof ArcaTransportError) {
    return new ArcaSalesPointsStrictError({
      reason: "transport_error",
      originalCode: "ARCA_TRANSPORT_ERROR",
      ...context,
      statusCode:
        typeof error.statusCode === "number" &&
        Number.isInteger(error.statusCode) &&
        error.statusCode >= 100 &&
        error.statusCode <= 599
          ? error.statusCode
          : undefined,
    });
  }
  const reason =
    error instanceof ArcaInvalidSoapResponseError
      ? "invalid_response"
      : error instanceof ArcaSoapFaultError
        ? "soap_fault"
        : "unavailable";
  return new ArcaSalesPointsStrictError({
    reason,
    ...context,
    originalCode:
      error instanceof ArcaInvalidSoapResponseError
        ? "ARCA_INVALID_SOAP_RESPONSE"
        : error instanceof ArcaSoapFaultError
          ? "ARCA_SOAP_FAULT"
          : undefined,
  });
}

function authenticationMetadata(error: ArcaAuthenticationError) {
  const rawCode = error.providerCode;
  const providerCode =
    typeof rawCode === "number" ||
    (typeof rawCode === "string" && /^\d+$/.test(rawCode))
      ? Number(rawCode)
      : Number.NaN;
  const originService =
    error.service === "wsaa" && error.operation === "loginCms"
      ? ("wsaa" as const)
      : error.service === "wsfe" && error.operation === "FEParamGetPtosVenta"
        ? ("wsfe" as const)
        : undefined;
  return {
    authenticationReason: error.reason,
    providerCode:
      Number.isSafeInteger(providerCode) &&
      providerCode > 0 &&
      providerCode <= 2_147_483_647
        ? providerCode
        : undefined,
    originService,
    originOperation:
      originService === "wsaa"
        ? ("loginCms" as const)
        : originService === "wsfe"
          ? ("FEParamGetPtosVenta" as const)
          : undefined,
  };
}
