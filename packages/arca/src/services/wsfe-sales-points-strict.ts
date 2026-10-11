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

/** Sólo tolera declaraciones XML y nil explícitamente falso, nunca contenido oculto. */
export function validateStrictSalesPointsShape(
  value: unknown,
  keys: string[],
  field: string
) {
  const node = record(value, field);
  for (const [key, nested] of Object.entries(node)) {
    if (keys.includes(key)) {
      continue;
    }
    if (/^@_xmlns(?::[\w.-]+)?$/.test(key) && typeof nested === "string") {
      continue;
    }
    if (key === "@_nil" || key === "@_xsi:nil") {
      if (nested !== "false" && nested !== "0") {
        return invalid(`${field}.xsi:nil`);
      }
      continue;
    }
    if (key === "#text" && typeof nested === "string" && nested.trim() === "") {
      continue;
    }
    return invalid(`${field}.structure`);
  }
  return node;
}

const shape = validateStrictSalesPointsShape;

function scalar(value: unknown, field: string): unknown {
  if (value !== null && typeof value === "object") {
    const node = shape(value, ["#text"], field);
    return node["#text"] ?? "";
  }
  return value;
}

function unwrap(value: unknown): Record<string, unknown> {
  const responseKey = "FEParamGetPtosVentaResponse";
  const resultKey = "FEParamGetPtosVentaResult";
  const envelope = shape(
    value,
    [responseKey, resultKey, "ResultGet", "Errors", "Events"],
    "envelope"
  );
  if (has(envelope, responseKey)) {
    if (
      has(envelope, resultKey) ||
      has(envelope, "ResultGet") ||
      has(envelope, "Errors") ||
      has(envelope, "Events")
    ) {
      return invalid("envelope");
    }
    const response = shape(envelope[responseKey], [resultKey], "envelope");
    return record(response[resultKey], "envelope");
  }
  if (has(envelope, resultKey)) {
    if (
      has(envelope, "ResultGet") ||
      has(envelope, "Errors") ||
      has(envelope, "Events")
    ) {
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
  const group = shape(result[container], [key], container);
  if (!has(group, key)) {
    return invalid(container, "absent");
  }
  const entries = Array.isArray(group[key]) ? group[key] : [group[key]];
  return Array.from(entries, (entry: unknown) => {
    const item = shape(entry, ["Code", "Msg"], `${container}.${key}`);
    if (
      has(item, "Msg") &&
      typeof scalar(item.Msg, `${container}.Msg`) !== "string"
    ) {
      return invalid(`${container}.Msg`);
    }
    return {
      source,
      code: integer(
        scalar(item.Code, `${container}.Code`),
        `${container}.Code`,
        2_147_483_647
      ),
    };
  });
}

function deletion(
  point: Record<string, unknown>
): WsfeSalesPointStrict["deletion"] {
  if (!has(point, "FchBaja")) {
    return { kind: "absent" };
  }
  const value = scalar(point.FchBaja, "FchBaja");
  if (value === "") {
    return { kind: "empty" };
  }
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) {
    return invalid("FchBaja");
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    return invalid("FchBaja");
  }
  return {
    kind: "date",
    date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
  };
}

function rejectErrors(
  result: Record<string, unknown>,
  errors: WsfeSalesPointsStrictIssue[],
  events: WsfeSalesPointsStrictIssue[]
) {
  if (errors.length === 0) {
    return;
  }
  const field = has(result, "ResultGet")
    ? "ResultGet"
    : events.length > 0
      ? "Events"
      : undefined;
  // No se descarta ni una contradicción ni códigos secundarios (incluido 602).
  const authentication = errors.every(
    ({ code }) => code === 600 || code === 601
  );
  throw new ArcaSalesPointsStrictError({
    reason:
      field === undefined
        ? authentication
          ? "authentication_error"
          : "service_error"
        : "invalid_response",
    issues: [...errors, ...events],
    field,
    fieldState: field === undefined ? undefined : "invalid",
    providerCode: authentication ? errors[0].code : undefined,
    authenticationReason: authentication
      ? errors[0].code === 600
        ? "invalid_token"
        : "missing_relationship"
      : undefined,
  });
}

/** Valida antes del mapper permisivo; nunca devuelve parcialmente una lista inválida. */
function parseStrict(value: unknown) {
  const result = unwrap(value);
  shape(result, ["ResultGet", "Errors", "Events"], "result");
  const errors = issues(result, "Errors", "Err", "error");
  const events = issues(result, "Events", "Evt", "event");
  rejectErrors(result, errors, events);
  if (!has(result, "ResultGet")) {
    return invalid("ResultGet", "absent");
  }
  const group = shape(result.ResultGet, ["PtoVenta"], "ResultGet");
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
      const point = shape(
        entry,
        ["Nro", "EmisionTipo", "Bloqueado", "FchBaja"],
        "PtoVenta"
      );
      for (const field of ["Nro", "EmisionTipo", "Bloqueado"]) {
        if (!has(point, field)) {
          return invalid(field, "absent");
        }
      }
      const number = integer(scalar(point.Nro, "Nro"), "Nro", 99_998);
      if (seen.has(number)) {
        return invalid("duplicate.Nro", "duplicate");
      }
      seen.add(number);
      const emissionType = scalar(point.EmisionTipo, "EmisionTipo");
      const blocked = scalar(point.Bloqueado, "Bloqueado");
      if (emissionType !== "CAE" && emissionType !== "CAEA") {
        return invalid("EmisionTipo");
      }
      if (blocked !== "S" && blocked !== "N") {
        return invalid("Bloqueado");
      }
      return {
        number,
        emissionType,
        blocked: blocked === "S",
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

/** Recupera sólo códigos válidos, incluso si otra entrada o estructura falla. */
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectGroupIssues(node: Record<string, unknown>) {
  const found: WsfeSalesPointsStrictIssue[] = [];
  for (const [container, key, source] of [
    ["Errors", "Err", "error"],
    ["Events", "Evt", "event"],
  ] as const) {
    const entries = optionalRecord(node[container])?.[key];
    for (const item of Array.isArray(entries) ? entries : [entries]) {
      try {
        const code = integer(
          scalar(optionalRecord(item)?.Code, "Code"),
          "Code",
          2_147_483_647
        );
        found.push({ source, code });
      } catch {
        // Sólo los códigos validados se conservan; la validación completa falla después.
      }
    }
  }
  return found;
}

function collectValidIssues(value: unknown): WsfeSalesPointsStrictIssue[] {
  const node = optionalRecord(value);
  if (!node) {
    return [];
  }
  const found = collectGroupIssues(node);
  for (const key of [
    "FEParamGetPtosVentaResponse",
    "FEParamGetPtosVentaResult",
  ]) {
    if (has(node, key)) {
      found.push(...collectValidIssues(node[key]));
    }
  }
  return found;
}

export function parseWsfeSalesPointsStrict(value: unknown) {
  const validatedIssues = collectValidIssues(value);
  try {
    return parseStrict(value);
  } catch (error) {
    if (
      error instanceof ArcaSalesPointsStrictError &&
      error.reason === "invalid_response"
    ) {
      throw new ArcaSalesPointsStrictError({
        reason: "invalid_response",
        field: error.field,
        fieldState: error.fieldState,
        issues: validatedIssues,
      });
    }
    throw error;
  }
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
      originalCode:
        error.reason === "soap_fault" ? "ARCA_SOAP_FAULT" : undefined,
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
