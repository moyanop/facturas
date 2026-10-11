import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArcaSalesPointsStrictError } from "../errors";
import { createArcaLogger } from "../internal/logger";
import { createSoapTransport } from "../soap";
import { createWsfeService } from "../wsfe";

const NS = "http://ar.gov.afip.dif.FEV1/";
const POINT =
  "<PtoVenta><Nro>1</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja/></PtoVenta>";
const DATA = `<ResultGet>${POINT}</ResultGet>`;
const issue = (code: number) =>
  `<Errors><Err><Code>${code}</Code><Msg>SECRETO-REMOTO</Msg></Err></Errors>`;
const response = (content: string) =>
  `<FEParamGetPtosVentaResponse xmlns="${NS}"><FEParamGetPtosVentaResult>${content}</FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse>`;
const soap = (body: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><s:Header/><s:Body>${body}</s:Body></s:Envelope>`;
let forbiddenConnections = 0;

beforeEach(() => {
  forbiddenConnections = 0;
  const deny = () => {
    forbiddenConnections++;
    throw new Error("La prueba prohíbe conexiones fiscales reales.");
  };
  vi.stubGlobal("fetch", deny);
  vi.spyOn(http, "request").mockImplementation(deny);
  vi.spyOn(http, "get").mockImplementation(deny);
  vi.spyOn(https, "get").mockImplementation(deny);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny);
  vi.spyOn(tls, "connect").mockImplementation(deny);
});
afterEach(() => {
  expect(forbiddenConnections).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** HTTPS sintético, HTTP/soap/XML reales del SDK; sólo permite la consulta de PV. */
function harness(fixtures: string[], retries = 1) {
  const log = vi.fn();
  const login = vi.fn(async () => ({
    token: "SINTETICO",
    sign: "SINTETICO",
    expiresAt: "2099-01-01",
  }));
  const requests: string[] = [];
  vi.spyOn(https, "request").mockImplementation(((
    options: https.RequestOptions,
    callback: (response: EventEmitter) => void
  ) => {
    expect(options.method).toBe("POST");
    expect(options.path).toBe("/wsfev1/service.asmx");
    expect(options.headers).toMatchObject({
      "Content-Type": expect.stringContaining("/FEParamGetPtosVenta"),
    });
    const request = new EventEmitter() as EventEmitter & {
      write: (chunk: Buffer) => void;
      end: () => void;
      setTimeout: () => void;
      destroy: () => void;
    };
    request.setTimeout = () => undefined;
    request.destroy = () => undefined;
    request.write = (chunk) => {
      const xml = chunk.toString();
      expect(xml).toContain("<FEParamGetPtosVenta ");
      expect(xml).not.toMatch(
        /FECAESolicitar|FECAEASolicitar|FECompUltimoAutorizado|FECompConsultar/
      );
      requests.push(xml);
    };
    request.end = () => {
      const reply = Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: { "content-type": "application/soap+xml; charset=utf-8" },
      });
      process.nextTick(() => {
        callback(reply);
        reply.emit(
          "data",
          Buffer.from(
            fixtures[Math.min(requests.length - 1, fixtures.length - 1)]
          )
        );
        reply.emit("end");
        request.emit("close");
      });
    };
    return request as never;
  }) as unknown as typeof https.request);
  const config = {
    taxId: "00000000000",
    certificatePem: "OFFLINE",
    privateKeyPem: "OFFLINE",
    environment: "test" as const,
    retries,
  };
  const transport = createSoapTransport({
    config,
    logger: createArcaLogger({ level: "debug", log }),
  });
  return {
    service: createWsfeService({ config, auth: { login }, soap: transport }),
    requests,
    login,
    log,
  };
}

describe("Review P1/P2: frontera HTTPS/SOAP/XML completa", () => {
  const invalid: [string, string, number[]?, ("invalid" | "absent")?][] = [
    [
      "2 cierre incorrecto",
      response(
        DATA.replace("<Bloqueado>N</Bloqueado>", "<Bloqueado>N</FchBaja>")
      ),
    ],
    [
      "3 wrapper anidado contradictorio",
      response(
        `${DATA}<FEParamGetPtosVentaResult>${issue(602)}</FEParamGetPtosVentaResult>`
      ),
      [602],
    ],
    [
      "4 Errors dentro de ResultGet",
      response(`<ResultGet>${POINT}${issue(602)}</ResultGet>`),
    ],
    [
      "5 Events dentro de ResultGet",
      response(
        `<ResultGet>${POINT}<Events><Evt><Code>39</Code></Evt></Events></ResultGet>`
      ),
    ],
    [
      "6 ResultGet nil con contenido",
      response(DATA.replace("<ResultGet>", '<ResultGet xsi:nil="true">')),
    ],
    [
      "7 PtoVenta nil con campos",
      response(DATA.replace("<PtoVenta>", '<PtoVenta xsi:nil="true">')),
    ],
    [
      "8 elemento inesperado",
      response(
        DATA.replace("</PtoVenta>", "<Otro>SECRETO-REMOTO</Otro></PtoVenta>")
      ),
    ],
    [
      "9 lista parcial",
      response(
        `<ResultGet>${POINT}<PtoVenta><Nro>2</Nro><EmisionTipo>CAE</EmisionTipo></PtoVenta></ResultGet>`
      ),
      undefined,
      "absent",
    ],
    [
      "10 602 con evento inválido",
      response(
        `${issue(602)}<Events><Evt><Code>INVALID</Code><Msg>SECRETO-REMOTO</Msg></Evt></Events>`
      ),
      [602],
    ],
    [
      "11a 600 con datos contradictorios",
      response(`${issue(600)}${DATA}`),
      [600],
    ],
    [
      "11b 601 con evento inválido",
      response(`${issue(601)}<Events><Evt><Code>INVALID</Code></Evt></Events>`),
      [601],
    ],
    ["12 envelope incompleto", `<FEParamGetPtosVentaResponse xmlns="${NS}"/>`],
    [
      "namespace de PV incorrecto",
      response(DATA.replace("<PtoVenta>", '<PtoVenta xmlns="urn:ajeno">')),
    ],
    [
      "prefijo xsi falsificado",
      response(
        DATA.replace(
          "<PtoVenta>",
          '<PtoVenta xmlns:xsi="urn:ajeno" xsi:nil="false">'
        )
      ),
    ],
    [
      "tipo contradictorio",
      response(DATA.replace("<Nro>", '<Nro xsi:type="xsd:string">')),
    ],
    [
      "nil no booleano",
      response(DATA.replace("<PtoVenta>", '<PtoVenta xsi:nil="desconocido">')),
    ],
    ["Body anidado inesperado", `<s:Body/>${response(DATA)}`],
    [
      "carácter XML 1.0 inválido",
      response(
        `${DATA}<Events><Evt><Code>39</Code><Msg>\u0000</Msg></Evt></Events>`
      ),
    ],
    [
      "referencia a carácter XML inválido",
      response(
        `${DATA}<Events><Evt><Code>39</Code><Msg>&#0;</Msg></Evt></Events>`
      ),
    ],
    [
      "entidad XML no declarada",
      response(
        `${DATA}<Events><Evt><Code>39</Code><Msg>&desconocida;</Msg></Evt></Events>`
      ),
    ],
    [
      "atributos duplicados con aliases del mismo namespace",
      response(
        DATA.replace(
          "<Nro>",
          '<Nro xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xsd:int" i:type="xsd:int">'
        )
      ),
    ],
    [
      "elemento prefijado no puede ocultarse como propiedad de prototipo",
      response(
        DATA.replace(
          "</PtoVenta>",
          `<f:__proto__ xmlns:f="${NS}"><f:Errors><f:Err><f:Code>602</f:Code></f:Err></f:Errors></f:__proto__></PtoVenta>`
        )
      ),
    ],
  ];
  it.each(invalid)(
    "%s falla cerrada sin refresh ni secretos",
    async (_name, body, codes, state = "invalid") => {
      const h = harness([soap(body)]);
      const failure: unknown = await h.service
        .getSalesPointsStrict({ authenticationRecovery: true })
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(ArcaSalesPointsStrictError);
      expect(failure).toMatchObject({
        reason: "invalid_response",
        attempts: 1,
        field: expect.any(String),
        fieldState: state,
      });
      if (codes) {
        expect(
          (failure as ArcaSalesPointsStrictError).issues.map(({ code }) => code)
        ).toEqual(codes);
      }
      expect(h.requests).toHaveLength(1);
      expect(h.login).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(failure)).not.toMatch(/SECRETO-REMOTO|<|SINTETICO/);
      expect(JSON.stringify(h.log.mock.calls)).not.toMatch(
        /SECRETO-REMOTO|<|SINTETICO/
      );
    }
  );
  it("1 XML válido con PV CAE", async () => {
    const h = harness([soap(response(DATA))]);
    expect((await h.service.getSalesPointsStrict()).points).toEqual([
      {
        number: 1,
        emissionType: "CAE",
        blocked: false,
        deletion: { kind: "empty" },
      },
    ]);
  });
  it("13 respuesta íntegra con evento, nil falso y atributos escalares legítimos", async () => {
    const body = DATA.replace("<PtoVenta>", '<PtoVenta xsi:nil="false">')
      .replace("<Nro>", '<Nro xsi:type="xsd:int">')
      .replace(
        "<Bloqueado>",
        '<Bloqueado xml:space="preserve" xsi:type="xsd:string">'
      );
    const h = harness([
      soap(
        response(
          `${body}<Events><Evt><Code>39</Code><Msg><![CDATA[SECRETO-REMOTO &desconocida; &#0;]]>&amp;&#x1F9EA;</Msg></Evt></Events>`
        )
      ),
    ]);
    const result = await h.service.getSalesPointsStrict();
    expect(result.points).toHaveLength(1);
    expect(result.events).toEqual([{ source: "event", code: 39 }]);
    expect(JSON.stringify(result)).not.toContain("SECRETO-REMOTO");
  });
  it("14 FchBaja legítimamente ausente", async () => {
    const h = harness([soap(response(DATA.replace("<FchBaja/>", "")))]);
    expect((await h.service.getSalesPointsStrict()).points[0].deletion).toEqual(
      { kind: "absent" }
    );
  });
  it("15 namespaces válidos con prefijos alternativos y declaraciones locales", async () => {
    const body = `<f:FEParamGetPtosVentaResponse xmlns:f="${NS}"><f:FEParamGetPtosVentaResult><f:ResultGet><p:PtoVenta xmlns:p="${NS}" xmlns:n="http://www.w3.org/2001/XMLSchema-instance" n:nil="0"><p:Nro>1</p:Nro><p:EmisionTipo>CAE</p:EmisionTipo><p:Bloqueado>N</p:Bloqueado></p:PtoVenta></f:ResultGet></f:FEParamGetPtosVentaResult></f:FEParamGetPtosVentaResponse>`;
    expect(
      (await harness([soap(body)]).service.getSalesPointsStrict()).points[0]
        .number
    ).toBe(1);
  });
  it("16 sólo consulta PV: cero emisión y numeración, cero red real", async () => {
    const h = harness([soap(response(DATA))]);
    await h.service.getSalesPointsStrict();
    expect(h.requests).toHaveLength(1);
    expect(forbiddenConnections).toBe(0);
  });
  it("17 el método original conserva tolerancia XML, defaults, 602 y recuperación", async () => {
    const h = harness(
      [
        soap(
          response(
            DATA.replace("<Bloqueado>N</Bloqueado>", "<Bloqueado>N</FchBaja>")
          )
        ),
        soap(response(DATA.replace("<Bloqueado>N</Bloqueado>", ""))),
        soap(response(issue(602))),
        soap(response(issue(601))),
        soap(response(DATA)),
      ],
      0
    );
    expect((await h.service.getSalesPoints())[0].blocked).toBe(false);
    expect((await h.service.getSalesPoints())[0].blocked).toBe(false);
    expect(await h.service.getSalesPoints()).toEqual([]);
    expect((await h.service.getSalesPoints())[0].number).toBe(1);
    expect(h.requests).toHaveLength(5);
    expect(h.login).toHaveBeenLastCalledWith(
      "wsfe",
      expect.objectContaining({ forceRefresh: true })
    );
  });
  it("no hay bypass por result sin raw ni por un raw distinto", async () => {
    const h = harness([soap(response(DATA))]);
    const execute = vi.fn();
    execute.mockResolvedValue({
      result: {
        FEParamGetPtosVentaResult: {
          ResultGet: {
            PtoVenta: { Nro: "1", EmisionTipo: "CAE", Bloqueado: "N" },
          },
        },
      },
    });
    const service = createWsfeService({
      config: {
        taxId: "00000000000",
        certificatePem: "OFFLINE",
        privateKeyPem: "OFFLINE",
        environment: "test",
        retries: 0,
      },
      auth: { login: h.login },
      soap: { execute },
    });
    await expect(service.getSalesPointsStrict()).rejects.toMatchObject({
      reason: "invalid_response",
      field: "raw",
      fieldState: "absent",
    });
    // Aunque el transporte inyectado ignore el hook, raw sigue siendo autoritativo.
    execute.mockResolvedValue({ raw: soap(response(issue(602))), result: {} });
    await expect(service.getSalesPointsStrict()).rejects.toMatchObject({
      reason: "service_error",
      issues: [{ source: "error", code: 602 }],
    });
    execute.mockResolvedValue({
      raw: soap(
        response(
          DATA.replace("<Bloqueado>N</Bloqueado>", "<Bloqueado>N</FchBaja>")
        )
      ),
      result: {},
    });
    await expect(service.getSalesPointsStrict()).rejects.toMatchObject({
      reason: "invalid_response",
      field: "xml",
    });
    expect(h.requests).toHaveLength(0);
  });
  it("rechaza un envelope con dos Body completos", async () => {
    const xml = soap(response(DATA)).replace(
      "</s:Envelope>",
      `<s:Body>${response(DATA)}</s:Body></s:Envelope>`
    );
    await expect(
      harness([xml]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ reason: "invalid_response", field: "soap.Body" });
  });
  it("acepta SOAP 1.1 y pistas de esquema legítimas sin descargarlas", async () => {
    const xml = soap(response(DATA))
      .replace(
        "http://www.w3.org/2003/05/soap-envelope",
        "http://schemas.xmlsoap.org/soap/envelope/"
      )
      .replace(
        "<ResultGet>",
        '<ResultGet xsi:schemaLocation="http://ar.gov.afip.dif.FEV1/ https://example.invalid/wsfe.xsd">'
      );
    expect(
      (await harness([xml]).service.getSalesPointsStrict()).points
    ).toHaveLength(1);
  });
  it("un ResultGet XML vacío no se inventa como colección acreditada", async () => {
    await expect(
      harness([soap(response("<ResultGet/>"))]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ reason: "invalid_response", field: "ResultGet" });
  });
  it("admite colecciones opcionales Errors y Events vacías con atributos legítimos", async () => {
    const xml = soap(
      response(
        `${DATA}<Errors xsi:nil="false"/><Events xmlns="${NS}">\n </Events>`
      )
    );
    expect(
      (await harness([xml]).service.getSalesPointsStrict()).events
    ).toEqual([]);
  });
  it("sanea un SOAP Fault sin conservar XML ni mensajes remotos", async () => {
    const h = harness([
      soap(
        "<s:Fault><s:Code><s:Value>s:Server</s:Value></s:Code><s:Reason><s:Text>SECRETO-REMOTO</s:Text></s:Reason></s:Fault>"
      ),
    ]);
    const failure: unknown = await h.service
      .getSalesPointsStrict()
      .catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      reason: "soap_fault",
      originalCode: "ARCA_SOAP_FAULT",
    });
    expect(JSON.stringify(failure)).not.toContain("SECRETO-REMOTO");
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("SECRETO-REMOTO");
  });
});
