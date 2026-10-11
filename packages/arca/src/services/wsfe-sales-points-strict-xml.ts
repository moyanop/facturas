import { XMLParser, XMLValidator } from "fast-xml-parser";
import { ArcaSalesPointsStrictError } from "../errors";
import {
  parseWsfeSalesPointsStrict,
  validateStrictSalesPointsShape,
} from "./wsfe-sales-points-strict";

const WSFE = "http://ar.gov.afip.dif.FEV1/";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const XSD = "http://www.w3.org/2001/XMLSchema";
const XML = "http://www.w3.org/XML/1998/namespace";
const SOAP = new Set([
  "http://schemas.xmlsoap.org/soap/envelope/",
  "http://www.w3.org/2003/05/soap-envelope",
]);
function validXmlCodePoint(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 0x20 && code <= 0xd7_ff) ||
    (code >= 0xe0_00 && code <= 0xff_fd) ||
    (code >= 0x1_00_00 && code <= 0x10_ff_ff)
  );
}

function validateXmlCharacters(value: unknown): void {
  if (typeof value === "string") {
    for (const character of value) {
      if (!validXmlCodePoint(character.codePointAt(0) as number)) {
        invalid("xml");
      }
    }
  }
}

function validateXmlReferences(raw: string): void {
  // Dentro de CDATA, comentarios e instrucciones no se expanden referencias.
  const markup = raw.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g,
    ""
  );
  const remaining = markup.replace(
    /&([^;\s<&]+);/g,
    (_match, reference: string) => {
      if (["amp", "lt", "gt", "apos", "quot"].includes(reference)) {
        return "";
      }
      if (!/^#(?:x[\da-fA-F]+|\d+)$/.test(reference)) {
        return invalid("xml");
      }
      const value = reference.slice(1);
      const code = value.startsWith("x")
        ? Number.parseInt(value.slice(1), 16)
        : Number(value);
      if (!validXmlCodePoint(code)) {
        return invalid("xml");
      }
      return "";
    }
  );
  if (remaining.includes("&")) {
    invalid("xml");
  }
}
const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

function invalid(
  field: string,
  fieldState: "absent" | "invalid" = "invalid"
): never {
  throw new ArcaSalesPointsStrictError({
    reason: "invalid_response",
    field,
    fieldState,
  });
}

function qualified(
  name: string,
  namespaces: Record<string, string>,
  attribute = false
) {
  const parts = name.split(":");
  if (parts.length > 2) {
    return invalid("xml.namespace");
  }
  const prefix = parts.length === 2 ? parts[0] : "";
  const namespace = attribute && prefix === "" ? "" : namespaces[prefix];
  if (prefix && !namespace) {
    return invalid("xml.namespace");
  }
  return { local: parts.at(-1) as string, namespace: namespace ?? "" };
}

function namespaceScope(
  node: Record<string, unknown>,
  parent: Record<string, string>
) {
  const scope = Object.assign(Object.create(null), parent) as Record<
    string,
    string
  >;
  for (const [key, value] of Object.entries(node)) {
    if (key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      if (typeof value !== "string") {
        return invalid("xml.namespace");
      }
      const prefix = key === "@_xmlns" ? "" : key.slice(8);
      if (prefix === "xmlns" || (prefix === "xml" && value !== XML)) {
        return invalid("xml.namespace");
      }
      scope[prefix] = value;
    }
  }
  return scope;
}

function compatibleType(
  name: string,
  value: unknown,
  scope: Record<string, string>
) {
  if (typeof value !== "string") {
    return invalid("xml.xsi:type");
  }
  const type = qualified(value, scope);
  const primitives =
    name === "fecha"
      ? ["string", "dateTime"]
      : [name === "Nro" || name === "Code" ? "int" : "string"];
  const scalar = [
    "Nro",
    "Code",
    "EmisionTipo",
    "Bloqueado",
    "FchBaja",
    "Msg",
    "ambiente",
    "fecha",
    "id",
  ].includes(name);
  if (scalar && type.namespace === XSD && primitives.includes(type.local)) {
    return;
  }
  const complex: Record<string, string[]> = {
    ResultGet: ["ArrayOfPtoVenta"],
    Errors: ["ArrayOfErr"],
    Events: ["ArrayOfEvt"],
    FEParamGetPtosVentaResult: ["FEPtoVentaResponse"],
  };
  if (
    !scalar &&
    type.namespace === WSFE &&
    (type.local === name || complex[name]?.includes(type.local))
  ) {
    return;
  }
  return invalid("xml.xsi:type");
}

function attribute(
  key: string,
  value: unknown,
  name: string,
  scope: Record<string, string>,
  parentNamespace?: string
) {
  const attr = qualified(key.slice(2), scope, true);
  if (soapHeaderAttribute(attr, value, name, parentNamespace)) {
    return undefined;
  }
  if (attr.namespace === XSI) {
    if (attr.local === "nil") {
      return ["@_nil", value] as const;
    }
    if (attr.local === "type") {
      compatibleType(name, value, scope);
      return undefined;
    }
    // Son pistas de esquema; no se descargan ni alteran el contrato conocido.
    if (
      ["schemaLocation", "noNamespaceSchemaLocation"].includes(attr.local) &&
      typeof value === "string"
    ) {
      return undefined;
    }
  }
  if (
    attr.namespace === XML &&
    attr.local === "space" &&
    (value === "default" || value === "preserve")
  ) {
    return undefined;
  }
  return invalid("xml.attribute");
}

/** Atributos SOAP propios del bloque FEHeaderInfo, no de sus campos ni del Body. */
function soapHeaderAttribute(
  attr: { local: string; namespace: string },
  value: unknown,
  name: string,
  parentNamespace?: string
): boolean {
  if (
    name !== "FEHeaderInfo" ||
    !SOAP.has(attr.namespace) ||
    attr.namespace !== parentNamespace
  ) {
    return false;
  }
  if (typeof value !== "string") {
    return invalid("soap.Header.attribute");
  }
  const soap11 = attr.namespace === "http://schemas.xmlsoap.org/soap/envelope/";
  const booleans = soap11 ? ["mustUnderstand"] : ["mustUnderstand", "relay"];
  if (booleans.includes(attr.local)) {
    if (!(soap11 ? ["0", "1"] : ["0", "1", "false", "true"]).includes(value)) {
      return invalid("soap.Header.attribute");
    }
    return true;
  }
  if (attr.local === (soap11 ? "actor" : "role")) {
    return true;
  }
  return invalid("soap.Header.attribute");
}

function validateNamespace(
  namespace: string,
  local: string,
  parentNamespace?: string,
  parentName?: string
) {
  if (parentNamespace === undefined) {
    if (!SOAP.has(namespace)) {
      return invalid("xml.namespace");
    }
  } else if (parentNamespace === WSFE || parentName === "Envelope") {
    if (namespace !== parentNamespace) {
      return invalid("xml.namespace");
    }
  } else if (parentName === "Body") {
    if (
      namespace !==
      (local === "FEParamGetPtosVentaResponse" ? WSFE : parentNamespace)
    ) {
      return invalid("xml.namespace");
    }
  } else if (parentName === "Header") {
    // Única transición adicional: bloque contextual WSFE documentado, no Header arbitrario.
    if (local !== "FEHeaderInfo" || namespace !== WSFE) {
      return invalid("xml.namespace");
    }
  } else if (namespace !== parentNamespace && namespace !== "") {
    return invalid("xml.namespace");
  }
}

function normalizeElement(
  name: string,
  value: unknown,
  parent: Record<string, string>,
  parentNamespace?: string,
  parentName?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeElement(name, item, parent, parentNamespace, parentName)
    );
  }
  const node =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const scope = namespaceScope(node, parent);
  const element = qualified(name, scope);
  validateNamespace(
    element.namespace,
    element.local,
    parentNamespace,
    parentName
  );
  if (value === null || typeof value !== "object") {
    validateXmlCharacters(value);
    return optionalEmpty(element.local, value);
  }
  const result = Object.create(null) as Record<string, unknown>;
  const attributes = new Set<string>();
  for (const [key, nested] of Object.entries(node)) {
    validateXmlCharacters(nested);
    if (key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      continue;
    }
    if (key.startsWith("@_")) {
      assignAttribute(
        result,
        key,
        nested,
        element.local,
        scope,
        attributes,
        parentNamespace
      );
      continue;
    }
    if (key === "#text") {
      result[key] = nested;
      continue;
    }
    const local = key.split(":").at(-1) as string;
    const normalized = normalizeElement(
      key,
      nested,
      scope,
      element.namespace,
      element.local
    );
    if (Object.hasOwn(result, local)) {
      return invalid("xml.structure");
    }
    result[local] = normalized;
  }
  return optionalEmpty(element.local, result);
}

function optionalEmpty(name: string, value: unknown): unknown {
  if (name !== "Errors" && name !== "Events") {
    return value;
  }
  if (typeof value === "string" && value.trim() === "") {
    return "";
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).every((key) => key === "#text" || key === "@_nil")
  ) {
    validateStrictSalesPointsShape(value, [], name);
    return "";
  }
  return value;
}

function assignAttribute(
  result: Record<string, unknown>,
  key: string,
  value: unknown,
  name: string,
  scope: Record<string, string>,
  attributes: Set<string>,
  parentNamespace?: string
) {
  const expanded = qualified(key.slice(2), scope, true);
  const identity = `${expanded.namespace}:${expanded.local}`;
  if (attributes.has(identity)) {
    return invalid("xml.attribute");
  }
  attributes.add(identity);
  const attr = attribute(key, value, name, scope, parentNamespace);
  if (!attr) {
    return;
  }
  if (Object.hasOwn(result, attr[0])) {
    return invalid("xml.attribute");
  }
  result[attr[0]] = attr[1];
}

function headerText(value: unknown, field: string): string {
  const text =
    value !== null && typeof value === "object"
      ? (validateStrictSalesPointsShape(value, ["#text"], field)["#text"] ?? "")
      : value;
  if (typeof text !== "string") {
    return invalid(field);
  }
  return text;
}

function headerDate(value: string): void {
  // Fecha contextual ISO: fracción y zona opcionales; no se calcula vigencia fiscal.
  const match =
    /^(-?(?:[1-9]\d{4,}|\d{4}))-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(
      value.trim()
    );
  if (!match) {
    invalid("soap.Header.FEHeaderInfo.fecha");
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const endOfDay =
    hour === 24 &&
    (minute !== 0 || second !== 0 || /[1-9]/.test(match[7] ?? ""));
  const zoneHour = Number(match[8] ?? 0);
  const zoneMinute = Number(match[9] ?? 0);
  if (
    !Number.isSafeInteger(year) ||
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 24 ||
    minute > 59 ||
    second > 59 ||
    endOfDay ||
    zoneHour > 14 ||
    zoneMinute > 59 ||
    (zoneHour === 14 && zoneMinute !== 0)
  ) {
    invalid("soap.Header.FEHeaderInfo.fecha");
  }
}

function validateSoapHeader(value: unknown): void {
  if (typeof value === "string" && value.trim() === "") {
    return;
  }
  const header = validateStrictSalesPointsShape(
    value,
    ["FEHeaderInfo"],
    "soap.Header"
  );
  if (!Object.hasOwn(header, "FEHeaderInfo")) {
    return;
  }
  const content = header.FEHeaderInfo;
  const info =
    typeof content === "string" && content.trim() === ""
      ? {}
      : validateStrictSalesPointsShape(
          content,
          ["ambiente", "fecha", "id"],
          "soap.Header.FEHeaderInfo"
        );
  // El manual no impone obligatoriedad individual ni enums para esta metadata opcional.
  for (const key of ["ambiente", "fecha", "id"]) {
    if (Object.hasOwn(info, key)) {
      const text = headerText(info[key], `soap.Header.FEHeaderInfo.${key}`);
      if (key === "fecha") {
        headerDate(text);
      }
    }
  }
}

/** Valida el raw obligatorio del transporte; nunca acredita el objeto result aislado. */
export function readWsfeSalesPointsStrictXml(
  raw: unknown
): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) {
    return invalid("raw", "absent");
  }
  validateXmlCharacters(raw);
  validateXmlReferences(raw);
  if (/<!DOCTYPE\b/i.test(raw) || XMLValidator.validate(raw) !== true) {
    return invalid("xml");
  }
  let document: Record<string, unknown>;
  try {
    document = parser.parse(raw) as Record<string, unknown>;
  } catch {
    return invalid("xml");
  }
  const entries = Object.entries(document);
  if (entries.length !== 1) {
    return invalid("soap.Envelope");
  }
  const [name, value] = entries[0];
  if (name.split(":").at(-1) !== "Envelope") {
    return invalid("soap.Envelope");
  }
  const envelope = validateStrictSalesPointsShape(
    normalizeElement(name, value, { xml: XML }),
    ["Header", "Body"],
    "soap.Envelope"
  );
  if (Object.hasOwn(envelope, "Header")) {
    validateSoapHeader(envelope.Header);
  }
  const body = validateStrictSalesPointsShape(
    envelope.Body,
    ["FEParamGetPtosVentaResponse", "Fault"],
    "soap.Body"
  );
  if (Object.hasOwn(body, "Fault")) {
    if (Object.hasOwn(body, "FEParamGetPtosVentaResponse")) {
      return invalid("soap.Body");
    }
    throw new ArcaSalesPointsStrictError({
      reason: "soap_fault",
      originalCode: "ARCA_SOAP_FAULT",
    });
  }
  if (!Object.hasOwn(body, "FEParamGetPtosVentaResponse")) {
    return invalid("soap.Body", "absent");
  }
  parseWsfeSalesPointsStrict(body);
  return body;
}
