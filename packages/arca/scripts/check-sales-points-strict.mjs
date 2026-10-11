// Verifica el artefacto construido mediante entradas públicas, sin red ni ARCA.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

let networkAttempts = 0;
const deny = () => {
  networkAttempts++;
  throw new Error("La verificación del paquete prohíbe conexiones de red.");
};
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
syncBuiltinESMExports();

const root = await import("facturas");
const errors = await import("facturas/errors");
const wsfe = await import("facturas/wsfe");
const require = createRequire(import.meta.url);
const cjs = require("facturas");
const cjsErrors = require("facturas/errors");
const cjsWsfe = require("facturas/wsfe");
assert.equal(
  root.ArcaSalesPointsStrictError,
  errors.ArcaSalesPointsStrictError
);
assert.equal(cjs.ArcaSalesPointsStrictError, errors.ArcaSalesPointsStrictError);
assert.equal(
  cjsErrors.ArcaSalesPointsStrictError,
  errors.ArcaSalesPointsStrictError
);
assert.equal(cjsWsfe.createWsfeService, wsfe.createWsfeService);

for (const factory of [
  root.createWsfeService,
  wsfe.createWsfeService,
  cjsWsfe.createWsfeService,
]) {
  let calls = 0;
  const service = factory({
    config: {
      taxId: "00000000000",
      certificatePem: "OFFLINE",
      privateKeyPem: "OFFLINE",
      environment: "test",
      retries: 0,
    },
    auth: {
      login: () =>
        Promise.resolve({
          token: "SYNTHETIC",
          sign: "SYNTHETIC",
          expiresAt: "2099-01-01",
        }),
    },
    soap: {
      execute: (request) => {
        assert.equal(request.service, "wsfe");
        assert.equal(request.operation, "FEParamGetPtosVenta");
        calls++;
        return Promise.resolve({
          raw: '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult><Errors><Err><Code>602</Code><Msg>SECRETO-REMOTO</Msg></Err></Errors></FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></s:Body></s:Envelope>',
          result: {
            FEParamGetPtosVentaResult: {
              Errors: { Err: { Code: 602, Msg: "SECRETO-REMOTO" } },
            },
          },
        });
      },
    },
  });
  await assert.rejects(
    () => service.getSalesPointsStrict(),
    (failure) => {
      assert.ok(failure instanceof errors.ArcaSalesPointsStrictError);
      assert.equal(failure.reason, "service_error");
      assert.deepEqual(failure.issues, [{ source: "error", code: 602 }]);
      assert.equal(failure.cause, undefined);
      assert.ok(!JSON.stringify(failure).includes("SECRETO-REMOTO"));
      return true;
    }
  );
  assert.deepEqual(await service.getSalesPoints(), []);
  assert.equal(calls, 2);
}
assert.equal(networkAttempts, 0);
console.log(
  "PASS: API estricta ESM/require, identidad de errores, legacy 602; red/emisión/numeración=0."
);
