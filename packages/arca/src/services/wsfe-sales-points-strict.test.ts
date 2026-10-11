import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ArcaAuthenticationError,
  ArcaSalesPointsStrictError,
  ArcaTransportError,
} from "../errors";
import { getSingleBodyEntry, parseSoapBody } from "../internal/xml";
import { createWsfeService } from "../wsfe";

const valid = { Nro: 1, EmisionTipo: "CAE", Bloqueado: "N", FchBaja: "" };
const response = (points: unknown) => ({ ResultGet: { PtoVenta: points } });
const error = (code: number) => ({
  Errors: { Err: { Code: code, Msg: "SECRETO-REMOTO" } },
});
const authError = () =>
  new ArcaAuthenticationError("SECRETO-REMOTO", {
    service: "wsaa",
    operation: "loginCms",
    reason: "authentication_rejected",
    cause: { token: "SECRETO-REMOTO" },
  });

let networkAttempts = 0;
beforeAll(() => {
  const deny = () => {
    networkAttempts++;
    throw new Error("La prueba prohíbe conexiones de red.");
  };
  vi.stubGlobal("fetch", deny);
  vi.spyOn(http, "request").mockImplementation(deny);
  vi.spyOn(http, "get").mockImplementation(deny);
  vi.spyOn(https, "request").mockImplementation(deny);
  vi.spyOn(https, "get").mockImplementation(deny);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny);
  vi.spyOn(tls, "connect").mockImplementation(deny);
});
afterAll(() => {
  expect(networkAttempts).toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness(fixtures: unknown[], retries = 0, loginFailure = false) {
  let calls = 0;
  const logins: boolean[] = [];
  const options = {
    config: {
      taxId: "00000000000",
      certificatePem: "OFFLINE",
      privateKeyPem: "OFFLINE",
      environment: "test" as const,
      retries,
    },
    auth: {
      login: vi
        .fn()
        .mockImplementation(
          (
            _service: string,
            input?: { forceRefresh?: boolean; abortSignal?: AbortSignal }
          ) => {
            expect(_service).toBe("wsfe");
            logins.push(input?.forceRefresh === true);
            if (loginFailure) {
              return Promise.reject(authError());
            }
            return Promise.resolve({
              token: "SYNTHETIC",
              sign: "SYNTHETIC",
              expiresAt: "2099-01-01",
            });
          }
        ),
    },
    soap: {
      execute: vi
        .fn()
        .mockImplementation(
          (request: {
            service: string;
            operation: string;
            retries?: number;
          }) => {
            // No emisión, consulta de numeración ni otra operación fiscal.
            expect(request.service).toBe("wsfe");
            expect(request.operation).toBe("FEParamGetPtosVenta");
            const fixture = fixtures[Math.min(calls++, fixtures.length - 1)];
            if (fixture instanceof Error) {
              return Promise.reject(fixture);
            }
            return Promise.resolve({
              result: { FEParamGetPtosVentaResult: fixture },
            });
          }
        ),
    },
  };
  return {
    service: createWsfeService(options),
    options,
    logins,
    calls: () => calls,
  };
}

describe("H.1B-0: 22 escenarios en el SDK real", () => {
  const cases: [string, unknown, string | undefined, number[]?][] = [
    ["1 valid", response(valid), undefined],
    ["2 blocked", response({ ...valid, Bloqueado: "S" }), undefined],
    ["3 deleted", response({ ...valid, FchBaja: "20261009" }), undefined],
    ["4 CAEA", response({ ...valid, EmisionTipo: "CAEA" }), undefined],
    [
      "5 missing-blocked",
      response({ Nro: 1, EmisionTipo: "CAE", FchBaja: "" }),
      "invalid_response",
    ],
    [
      "6 unknown-blocked",
      response({ ...valid, Bloqueado: "UNKNOWN" }),
      "invalid_response",
    ],
    [
      "7 invalid-date",
      response({ ...valid, FchBaja: "INVALID" }),
      "invalid_response",
    ],
    ["8 empty", response([]), undefined],
    ["9 602", error(602), "service_error", [602]],
    ["10 601", error(601), "authentication_error", [601]],
    [
      "11 partial",
      response([valid, { EmisionTipo: "CAE" }]),
      "invalid_response",
    ],
    [
      "12 duplicates",
      response([valid, { ...valid, Bloqueado: "S" }]),
      "invalid_response",
    ],
    [
      "13 transport",
      new ArcaTransportError("SECRETO-REMOTO", {
        responseBodyPreview: "SECRETO-REMOTO",
        cause: { token: "SECRETO-REMOTO" },
      }),
      "transport_error",
    ],
    ["14 auth", authError(), "authentication_error"],
    ["15 refresh", error(601), "authentication_error", [601]],
    ["16 incomplete", {}, "invalid_response"],
    [
      "17 invalid-calendar",
      response({ ...valid, FchBaja: "20261345" }),
      "invalid_response",
    ],
    ["18 600", error(600), "authentication_error", [600]],
    [
      "19 missing-date",
      response({ Nro: 1, EmisionTipo: "CAE", Bloqueado: "N" }),
      undefined,
    ],
    [
      "20 unknown-emission",
      response({ ...valid, EmisionTipo: "UNKNOWN" }),
      "invalid_response",
    ],
    [
      "21 mixed602",
      { Errors: { Err: [{ Code: 602 }, { Code: 500 }] } },
      "service_error",
      [602, 500],
    ],
    [
      "22 602-with-point",
      { ...response(valid), ...error(602) },
      "invalid_response",
      [602],
    ],
  ];
  it.each(cases)("%s", async (name, fixture, reason, codes) => {
    const h = harness(
      name.startsWith("15 ") ? [fixture, response(valid)] : [fixture],
      0,
      name.startsWith("14 ")
    );
    if (reason) {
      const failure = await h.service
        .getSalesPointsStrict({ authenticationRecovery: true })
        .catch((cause) => cause);
      expect(failure).toBeInstanceOf(ArcaSalesPointsStrictError);
      expect(failure.reason).toBe(reason);
      expect(failure.attempts).toBe(1);
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure)).not.toContain("SECRETO-REMOTO");
      expect(failure.message).not.toContain("SECRETO-REMOTO");
      if (codes) {
        expect(
          failure.issues.map((issue: { code: number }) => issue.code)
        ).toEqual(codes);
      }
      if (name.startsWith("14 ")) {
        expect(failure.originService).toBe("wsaa");
        expect(failure.originOperation).toBe("loginCms");
      }
    } else {
      const result = await h.service.getSalesPointsStrict();
      expect(result.attempts).toBe(1);
      expect(result.authenticationRecovered).toBe(false);
      expect(result.kind).toBe(name.startsWith("8 ") ? "empty" : "points");
      expect(result.points).toEqual(
        name.startsWith("8 ")
          ? []
          : [
              {
                number: 1,
                emissionType: name.startsWith("4 ") ? "CAEA" : "CAE",
                blocked: name.startsWith("2 "),
                deletion: name.startsWith("3 ")
                  ? { kind: "date", date: "2026-10-09" }
                  : { kind: name.startsWith("19 ") ? "absent" : "empty" },
              },
            ]
      );
    }
    expect(h.calls()).toBe(name.startsWith("14 ") ? 0 : 1);
    expect(h.logins).toEqual([false]);
    for (const [request] of h.options.soap.execute.mock.calls) {
      expect(request.retries).toBe(0);
    }
  });
});

describe("Validaciones adicionales y recuperación controlada", () => {
  it.each([
    0,
    -1,
    99_999,
    1.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    null,
    "",
    "1x",
    "1e2",
    " 1",
  ])("rechaza Nro=%s", async (Nro) => {
    await expect(
      harness([response({ ...valid, Nro })]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "Nro" });
  });
  it.each([
    "20260229",
    "19000229",
    "20260431",
    "00000101",
    "2026-10-09",
    20_261_009,
    null,
    undefined,
    "00000000",
  ])("rechaza FchBaja=%s", async (FchBaja) => {
    await expect(
      harness([response({ ...valid, FchBaja })]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "FchBaja" });
  });
  it.each(["20240229", "20000229", "20261231"])(
    "acepta fecha calendario %s",
    async (FchBaja) => {
      expect(
        (
          await harness([
            response({ ...valid, FchBaja }),
          ]).service.getSalesPointsStrict()
        ).points[0].deletion.kind
      ).toBe("date");
    }
  );
  it("rechaza duplicados idénticos incluso con número representado como string", async () => {
    await expect(
      harness([
        response([valid, { ...valid, Nro: "1" }]),
      ]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "duplicate.Nro" });
  });
  it.each([
    null,
    [],
    "",
    { ResultGet: {} },
    { ResultGet: null },
    { ResultGet: "" },
    { ResultGet: { PtoVenta: null } },
    { Errors: {} },
    { Errors: { Err: { Code: "602x" } } },
    { ...response(valid), Events: {} },
  ])("rechaza envelope o colección incompletos %j", async (fixture) => {
    await expect(
      harness([fixture]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });
  it("conserva eventos y no filtra mensajes remotos", async () => {
    const result = await harness([
      {
        ...response(valid),
        Events: { Evt: { Code: "39", Msg: "SECRETO-REMOTO" } },
      },
    ]).service.getSalesPointsStrict();
    expect(result.events).toEqual([{ source: "event", code: 39 }]);
    expect(JSON.stringify(result)).not.toContain("SECRETO-REMOTO");
  });
  it("recupera una vez sólo con opt-in y retries mayor que cero", async () => {
    const h = harness([error(601), response(valid)], 1);
    const result = await h.service.getSalesPointsStrict({
      authenticationRecovery: true,
    });
    expect(result).toMatchObject({
      attempts: 2,
      authenticationRecovered: true,
      recovery: {
        providerCode: 601,
        authenticationReason: "missing_relationship",
        issues: [{ source: "error", code: 601 }],
      },
    });
    expect(h.logins).toEqual([false, true]);
    expect(h.calls()).toBe(2);
  });
  it("no recupera por defecto ni permite un tercer intento", async () => {
    const first = harness([error(600), response(valid)], 1);
    await expect(first.service.getSalesPointsStrict()).rejects.toMatchObject({
      providerCode: 600,
      attempts: 1,
    });
    expect(first.calls()).toBe(1);
    const persistent = harness([error(600)], 1);
    await expect(
      persistent.service.getSalesPointsStrict({ authenticationRecovery: true })
    ).rejects.toMatchObject({ attempts: 2, providerCode: 600 });
    expect(persistent.calls()).toBe(2);
  });
  it("distingue un campo obligatorio ausente de uno inválido", async () => {
    await expect(
      harness([
        response({ Nro: 1, EmisionTipo: "CAE" }),
      ]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "Bloqueado", fieldState: "absent" });
    await expect(
      harness([
        response({ ...valid, Bloqueado: "UNKNOWN" }),
      ]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "Bloqueado", fieldState: "invalid" });
  });
  it("conserva la primera falla si la respuesta de recuperación es inválida", async () => {
    await expect(
      harness([error(600), {}], 1).service.getSalesPointsStrict({
        authenticationRecovery: true,
      })
    ).rejects.toMatchObject({
      attempts: 2,
      reason: "invalid_response",
      recovery: { providerCode: 600 },
    });
  });
  it("no inicia SOAP si abort ocurre durante login", async () => {
    const controller = new AbortController();
    const h = harness([response(valid)]);
    h.options.auth.login.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({
        token: "SYNTHETIC",
        sign: "SYNTHETIC",
        expiresAt: "2099-01-01",
      });
    });
    await expect(
      h.service.getSalesPointsStrict({ abortSignal: controller.signal })
    ).rejects.toMatchObject({ reason: "aborted", attempts: 1 });
    expect(h.calls()).toBe(0);
  });
  it("rechaza wrappers contradictorios y arrays sparse sin filtrar entradas", async () => {
    const h = harness([]);
    h.options.soap.execute.mockResolvedValueOnce({
      result: {
        FEParamGetPtosVentaResponse: {
          FEParamGetPtosVentaResult: response(valid),
        },
        FEParamGetPtosVentaResult: response(valid),
      },
    });
    await expect(h.service.getSalesPointsStrict()).rejects.toMatchObject({
      field: "envelope",
    });
    await expect(
      harness([response(new Array(1))]).service.getSalesPointsStrict()
    ).rejects.toMatchObject({ field: "PtoVenta" });
  });
  it("no recupera una falla mixta ni acepta respuesta inválida tras refresh", async () => {
    const mixed = harness(
      [{ Errors: { Err: [{ Code: 600 }, { Code: 602 }] } }],
      1
    );
    await expect(
      mixed.service.getSalesPointsStrict({ authenticationRecovery: true })
    ).rejects.toMatchObject({ reason: "service_error", attempts: 1 });
    const invalid = harness(
      [error(601), response({ ...valid, Bloqueado: "UNKNOWN" })],
      1
    );
    await expect(
      invalid.service.getSalesPointsStrict({ authenticationRecovery: true })
    ).rejects.toMatchObject({ reason: "invalid_response", attempts: 2 });
  });
  it("forceRefresh explícito no inicia otro refresh", async () => {
    const h = harness([error(601)], 1);
    await expect(
      h.service.getSalesPointsStrict({
        forceRefresh: true,
        authenticationRecovery: true,
      })
    ).rejects.toMatchObject({ attempts: 1 });
    expect(h.logins).toEqual([true]);
  });
  it("propaga signal a login y SOAP; rechaza resultado tardío tras abort", async () => {
    const controller = new AbortController();
    const h = harness([response(valid)]);
    await h.service.getSalesPointsStrict({ abortSignal: controller.signal });
    expect(h.options.auth.login.mock.calls[0][1]?.abortSignal).toBe(
      controller.signal
    );
    expect(h.options.soap.execute.mock.calls[0][0]).toMatchObject({
      signal: controller.signal,
    });
    h.options.soap.execute.mockImplementationOnce(() => {
      controller.abort("SECRETO-REMOTO");
      return Promise.resolve({
        result: { FEParamGetPtosVentaResult: response(valid) },
      });
    });
    await expect(
      h.service.getSalesPointsStrict({ abortSignal: controller.signal })
    ).rejects.toMatchObject({ reason: "aborted" });
    const pre = harness([response(valid)]);
    await expect(
      pre.service.getSalesPointsStrict({ abortSignal: controller.signal })
    ).rejects.toMatchObject({ reason: "aborted", attempts: 0 });
    expect(pre.logins).toEqual([]);
  });
  it("usa el parser XML real sin transporte alternativo", async () => {
    const h = harness([]);
    const xml =
      "<Envelope><Body><FEParamGetPtosVentaResponse><FEParamGetPtosVentaResult><ResultGet><PtoVenta><Nro>1</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja/></PtoVenta></ResultGet></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></Body></Envelope>";
    const [, result] = getSingleBodyEntry<Record<string, unknown>>(
      parseSoapBody(xml)
    );
    h.options.soap.execute.mockResolvedValueOnce({ result });
    expect((await h.service.getSalesPointsStrict()).points[0]).toMatchObject({
      number: 1,
      deletion: { kind: "empty" },
    });
  });
  it("mantiene defaults, 602 y recuperación del método original", async () => {
    expect(
      await harness([
        response({ Nro: 1, EmisionTipo: "CAE" }),
      ]).service.getSalesPoints()
    ).toEqual([{ number: 1, emissionType: "CAE", blocked: false }]);
    expect(await harness([error(602)]).service.getSalesPoints()).toEqual([]);
    const h = harness([error(601), response(valid)]);
    expect(await h.service.getSalesPoints()).toEqual([
      { number: 1, emissionType: "CAE", blocked: false },
    ]);
    expect(h.logins).toEqual([false, true]);
  });
});
