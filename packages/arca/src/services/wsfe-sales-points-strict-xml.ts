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
  const primitive = name === "Nro" || name === "Code" ? "int" : "string";
  const scalar = [
    "Nro",
    "Code",
    "EmisionTipo",
    "Bloqueado",
    "FchBaja",
    "Msg",
  ].includes(name);
  if (scalar && type.namespace === XSD && type.local === primitive) {
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
  scope: Record<string, string>
) {
  const attr = qualified(key.slice(2), scope, true);
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
      assignAttribute(result, key, nested, element.local, scope, attributes);
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
  attributes: Set<string>
) {
  const expanded = qualified(key.slice(2), scope, true);
  const identity = `${expanded.namespace}:${expanded.local}`;
  if (attributes.has(identity)) {
    return invalid("xml.attribute");
  }
  attributes.add(identity);
  const attr = attribute(key, value, name, scope);
  if (!attr) {
    return;
  }
  if (Object.hasOwn(result, attr[0])) {
    return invalid("xml.attribute");
  }
  result[attr[0]] = attr[1];
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
  if (Object.hasOwn(envelope, "Header") && envelope.Header !== "") {
    validateStrictSalesPointsShape(envelope.Header, [], "soap.Header");
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
