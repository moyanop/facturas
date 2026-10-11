# Consulta estricta de puntos de venta WSFE

`client.wsfe.getSalesPointsStrict()` valida la respuesta completa antes de
normalizarla. Es una API aditiva del fork temporal. El método original permanece
intacto, incluidos sus defaults, la conversión de 602 en `[]` y su recuperación.

## Base y procedencia

- Repositorio padre: [LaPyme/facturas](https://github.com/LaPyme/facturas).
- Fork: [moyanop/facturas](https://github.com/moyanop/facturas).
- Licencia Apache-2.0, sin cambios.
- Base `compat/facturas-0.20.3`, tag `facturas@0.20.3`, commit
  `a96850a703730f9f635a0515d0695f60deda7e0b`.
- Rama `fix/puntos-venta-estrictos`. Paquete temporal `0.20.3-moyan.1`.
- El registro npm no proporciona `gitHead` para 0.20.3. La base se acredita con
  el tag oficial y su `package.json`, no con un `gitHead` supuesto.
- No se incorporaron las versiones 0.20.4 a 0.25.0. No se publican paquetes ni releases.

## API y errores

```ts
import { ArcaSalesPointsStrictError } from "facturas";

try {
  const result = await client.wsfe.getSalesPointsStrict({
    abortSignal: controller.signal,
    authenticationRecovery: false,
  });
  // Revisá modalidad, bloqueo, baja, eventos y el PV exacto en tu propia policy.
  console.log(result.kind, result.points, result.attempts);
} catch (error) {
  if (error instanceof ArcaSalesPointsStrictError) {
    console.log(error.reason, error.field, error.fieldState, error.issues);
  }
}
```

| Campo o situación | Contrato estricto |
| --- | --- |
| `Nro` | Entero decimal entre 1 y 99998. Sin coerción de booleanos, fracciones, exponentes ni sufijos. |
| `EmisionTipo` | CAE o CAEA obligatorios. No inventa una modalidad. |
| `Bloqueado` | S o N obligatorios. Ausente o desconocido nunca significa desbloqueado. |
| `FchBaja` | Opcional. `deletion.kind` distingue `absent`, `empty` y `date`. Una fecha presente exige YYYYMMDD y calendario gregoriano válido. No admite sentinels, null ni objetos nil. |
| Duplicados | Rechaza toda repetición de Nro, incluso idéntica o con otra modalidad. No elige la primera entrada. |
| Vacío | Sólo `ResultGet.PtoVenta: []` produce `kind: empty`. Un ResultGet omitido, incompleto o vacío no acredita una colección válida. |
| Error 602 | Falla estructurada con código 602. Nunca `[]`. |
| Errores junto con datos | Respuesta inválida. Conserva todos los códigos que fueron validados. |
| Errores 600/601 | Autenticación contextual. 600 no prueba revocación y 601 no prueba una revocación global. |
| Eventos | Conserva códigos, no mensajes. El caller debe evaluar los eventos antes de autorizar su propio flujo. |

El error contiene `code: ARCA_SALES_POINTS_STRICT_ERROR`, `reason`, campo y estado
de validación cuando corresponden, códigos públicos, origen de autenticación,
`originalCode` de errores SDK conocidos, status HTTP válido e intentos lógicos.
No incorpora mensajes del proveedor, raw XML, previews, claves, tokens, Sign,
causes ni stacks remotos. Su stack local es el normal de JavaScript.

`representedTaxId` y `environment` son el contexto solicitado. No son un eco de
identidad firmado por WSFE. La API no calcula expiración de autorización ni
construye una política de readiness. No reemplaza los bindings de Moyan.

## Recuperación y cancelación

La lectura SOAP usa `retries: 0`. No hay recuperación de autenticación por
defecto. Para permitir un único refresh, pedí `authenticationRecovery: true` y
configurá el cliente con `retries` mayor que cero. `config.retries: 0` prohíbe ese
refresh incluso con opt-in. Un `forceRefresh: true` explícito tampoco permite un
segundo refresh. No se ocultan errores mixtos para intentar recuperar.

El resultado muestra `attempts`, `authenticationRecovered` y evidencia saneada
`recovery`. Una segunda falla también conserva `recovery`. Son intentos lógicos
de login y lectura, no un contador de HTTP. WSAA mantiene su caché, store y
recuperación `alreadyAuthenticated`. Con retries mayor que cero, su transporte
puede repetir HTTP según la configuración existente.

`abortSignal` se propaga a login y SOAP. Se comprueba antes de login, después del
login y al recibir la respuesta. Una respuesta tardía tras abort no se acepta.
Esto no promete cancelación física absoluta, ni un deadline total del store y
DNS. No se cambió el motor de autenticación global ni el método legacy.

## Pruebas offline

Desde la raíz, con Node >=22 y pnpm 12.4.1:

```bash
pnpm install --frozen-lockfile
pnpm --filter facturas exec vitest run src/services/wsfe-sales-points-strict.test.ts src/services/wsfe.test.ts
pnpm typecheck
pnpm --filter facturas build
node packages/arca/scripts/check-sales-points-strict.mjs
pnpm --filter facturas exec tsc --project scripts/tsconfig.package-consumer.json --noEmit
pnpm test
pnpm check
pnpm check:docs
```

La suite strict cubre los 22 escenarios H.1B-0, más límites numéricos,
calendario, estructuras incompletas, duplicados idénticos, eventos, refresh
controlado, abort y el parser XML real. Bloquea fetch, HTTP/HTTPS, Socket y TLS.
El transporte sólo permite FEParamGetPtosVenta. No hay emisión ni numeración.
Las entradas públicas compiladas se prueban con ESM y `require()` en versiones
de Node que soportan require de ESM. No se agrega un bundle CJS separado.

La suite original no requiere ARCA. Se observó un fallo intermitente de
concurrencia del file store en la primera corrida de la base sobre Windows
(`ENOENT` al retirar un lock). No se corrigió en este parche.
El checker original de exports también usa imports de paths absolutos que
fallan en Windows. Las comprobaciones públicas portables y el consumidor de
declaraciones se ejecutan por separado, sin atribuirles PASS al checker original.

### Resultados de la preparación del parche

| Comprobación | Resultado |
| --- | --- |
| Matriz estricta, 22 escenarios y variantes | 69 tests PASS. Red, emisión y numeración igual a cero. |
| Regresión focal junto con WSFE original | 159 tests PASS en Node 25.4.0 y Node 22.23.3. |
| Typecheck de paquete y ejemplos | PASS. |
| Build ESM y declaraciones | PASS. No se editaron archivos dist manualmente. |
| Consumidor de declaraciones públicas | PASS. |
| Imports ESM y require de ESM | PASS en el artefacto y en un consumidor instalado, Node 22.23.3 y 25.4.0. |
| Dos builds y dos npm pack | Tarballs idénticos byte a byte, 46 archivos, 293872 bytes. |
| Lint y formato focal, docs y diff check | PASS. |
| Suite completa en Windows | 1141 PASS, 1 SKIP y 1 FAIL del file lock ya observado en la base original. No es una corrida completamente verde. |
| Check global de formato en Windows | FAIL por CRLF de archivos originales del checkout. No se reformateó código ajeno. |
| Checker original check:exports en Windows | FAIL por import absoluto del CLI. Se verificaron exports y tipos con comandos independientes. |

Integridad del tarball local `facturas-0.20.3-moyan.1.tgz`:

```text
sha512-iItJuGvBqsdQBi4y3PkmVlTQEilJbR5UWtZki+5AU2t4gGIiGN+vLoq1AcaqOEF9mphnjjkdOWZ6HNxhiVfIBg==
```

Esta igualdad se comprobó con pnpm 12.4.1 y Node 25.4.0 en el mismo entorno de
build. No se promete igualdad de tarballs entre toolchains o sistemas operativos
distintos sin repetir la comprobación.

## Instalación reproducible futura

No instales la raíz del monorepo como dependencia Git. Es un workspace privado,
no el paquete `facturas`. Después de aprobar el parche, fijá el SHA completo de
su commit, compilá `packages/arca` con el lockfile y generá un tarball:

```bash
git clone https://github.com/moyanop/facturas.git
cd facturas
git checkout --detach <SHA_COMPLETO_REVISADO>
pnpm install --frozen-lockfile
pnpm --filter facturas build
cd packages/arca
npm pack --ignore-scripts
```

Verificá el SHA-512 del tarball contra el artefacto revisado. En un cambio futuro
se podría copiar ese artefacto a `backend/vendor/` e instalarlo por archivo:

```bash
npm install --save-exact ./vendor/facturas-0.20.3-moyan.1.tgz
```

Guardá el tarball, su integridad y el lockfile juntos. No mezcles dos copias del
SDK porque romperían identidad de clases y cachés. Los rangos transitivos de
package.json siguen siendo los originales. El consumidor debe conservar su
lockfile y revisar su resolución. Esta sesión no instala ni cambia nada en Moyan.

## Port a upstream y rollback

Para proponerlo después a la rama oficial actual, portá sólo el error público,
tipos, parser y método estrictos, junto con tests y documentación. Resolvé las
diferencias del helper de login sobre la nueva base y repetí la matriz y las
regresiones de autenticación. No envíes la rama histórica completa ni el cambio
de versión temporal como si fuera una actualización oficial. Prepará el
changeset correspondiente a la API aditiva en la versión upstream vigente.

El límite de rollback es el método strict, su parser y error públicos, exports,
tests, verificaciones y documentación. No requiere rollback de WSAA, emisión,
reservas, numeración, bases de datos ni de Moyan. H.1B-1 permanece fuera de alcance.
