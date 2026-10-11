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
| Vacío | El parser sólo acredita `ResultGet.PtoVenta: []`. La API pública exige XML íntegro: `<ResultGet/>` no acredita esa colección y falla cerrada. No se inventa una representación remota vacía. |
| Error 602 | Falla estructurada con código 602. Nunca `[]`. |
| Errores junto con datos | Respuesta inválida. Conserva todos los códigos que fueron validados. |
| Errores 600/601 | Autenticación contextual. 600 no prueba revocación y 601 no prueba una revocación global. |
| Eventos | Conserva códigos, no mensajes. El caller debe evaluar los eventos antes de autorizar su propio flujo. |

Los envelopes anidados no pueden tener `ResultGet`, `Errors` ni `Events`
paralelos fuera de su resultado. Esas estructuras contradictorias se rechazan;
no se descarta información para aceptar los puntos de venta internos.

La validación también cubre las claves de cada resultado, colección, punto de
venta y código/evento. `Errors` y `Events` sólo pueden estar en el resultado de
la operación, no dentro de `ResultGet` ni de un PV. `xsi:nil` verdadero o inválido
no acredita contenido; nil falso y declaraciones de namespaces son legítimos.
Los elementos inesperados y el contenido anidado en campos escalares fallan
cerrados, sin devolver una lista parcial.

Si otra parte de la estructura falla, el diagnóstico conserva los códigos
numéricos válidos encontrados, el campo inválido y `reason: invalid_response`.
Un error 602 con un evento inválido no pierde el 602. Una respuesta mixta o
estructuralmente inválida con 600/601 tampoco autoriza un refresh. Esos códigos
no acreditan por sí solos revocación de autorización.

## Integridad XML obligatoria

El camino estricto reutiliza `raw` del transporte SOAP existente. Un hook interno
valida ese texto **antes** del parser permisivo del SDK y de sus diagnósticos con
previews. Después del transporte vuelve a validar `raw`: un transporte inyectado
que ignore el hook no puede acreditar su objeto `result` sin XML válido.
No hay flag público para omitir esta validación ni un transporte SOAP alternativo.

Se reutiliza `XMLValidator` de `fast-xml-parser`, ya presente en el lockfile.
Además se verifican caracteres y referencias XML 1.0, namespaces expandidos,
atributos relevantes y estructura SOAP/WSFE completa con un parser que conserva
prefijos y atributos antes de normalizarlos. Se rechazan cierres incorrectos,
DOCTYPE, namespaces ajenos, `xsi:nil` contradictorio y tipos incompatibles.
Se admiten SOAP 1.1/1.2, aliases legítimos, declaraciones locales, `xsi:nil` falso,
tipos compatibles y pistas de esquema; nunca se descargan esas pistas.
`FchBaja` sigue siendo opcional. Esto no es una validación XSD completa ni una
promesa de aceptar extensiones futuras desconocidas: éstas fallan cerradas.
Los errores y logs del camino estricto no guardan XML ni mensajes remotos.

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
pnpm --filter facturas exec vitest run src/services/wsfe-sales-points-strict.test.ts src/services/wsfe-sales-points-strict-soap.test.ts src/services/wsfe.test.ts src/soap/index.test.ts
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
controlado, abort y el parser XML real. El caso 8, colección JavaScript
explícitamente vacía, se comprueba sólo en el parser: no se fabrica un XML que
acredite esa forma. Las fixtures de la API incluyen `raw` obligatorio.
La suite SOAP adversarial recorre HTTPS sintético → HTTP/SOAP/XML reales del SDK
y cubre los 17 grupos solicitados más variantes. Bloquea fetch, HTTP/HTTPS, Socket y TLS.
El transporte sólo permite FEParamGetPtosVenta. No hay emisión ni numeración.
Las entradas públicas compiladas se prueban con ESM y `require()` en versiones
de Node que soportan require de ESM. No se agrega un bundle CJS separado.

La suite original no requiere ARCA. Se observó un fallo intermitente de
concurrencia del file store en la primera corrida de la base sobre Windows
(`ENOENT` al retirar un lock). No se corrigió en este parche.
El checker original de exports también usa imports de paths absolutos que
fallan en Windows. Las comprobaciones públicas portables y el consumidor de
declaraciones se ejecutan por separado, sin atribuirles PASS al checker original.

### Resultados después de corregir P1-A, P1-B y P2

| Comprobación | Resultado |
| --- | --- |
| Matriz estricta, 22 escenarios y variantes | 83 tests PASS. Red, emisión y numeración igual a cero. |
| SOAP/HTTPS adversarial completo | 34 tests PASS, incluidos los 17 grupos de regresión, entidades/caracteres inválidos, atributos duplicados y XML obligatorio incluso con transporte inyectado. |
| Regresión focal con WSFE original y SOAP original | 212 tests PASS en Node 22.23.3, 24.21.0 y 25.9.0. |
| Typecheck de paquete, tests y ejemplos | PASS; tipos del paquete también comprobados en Node 22 y 24. Los tres errores `.not` reportados no se reprodujeron antes ni después de este bloque; no se eliminan assertions ni se excluyen tests del typecheck. |
| Build ESM y declaraciones | PASS. No se editaron archivos dist manualmente. |
| Consumidor de declaraciones públicas | PASS. |
| Imports ESM y require de ESM | PASS en el artefacto y en un consumidor temporal instalado, Node 22.23.3, 24.21.0 y 25.9.0; SRI del lockfile confirmado. |
| Dos builds y dos npm pack con fuentes LF | Tarballs idénticos byte a byte, 46 archivos, 300900 bytes; build con Node 24.21.0. |
| Lint y formato focal, docs y diff check | PASS. |
| Suite completa en Windows, Node 22.23.3, 24.21.0 y 25.9.0 | Cada versión: 1189 PASS, 1 SKIP y 1 FAIL del file lock ya observado en la base original. No son corridas completamente verdes. |
| Check global de lint y formato | PASS de 132 archivos en clone con LF, sin reformatear código ajeno. |
| Checker original check:exports en Windows | FAIL por import absoluto del CLI. Una copia temporal con sólo la conversión a file URL y bloqueo de red verifica todos los exports; PASS en Node 22, 24 y 25, sin cambiar el checker del SDK. |

Integridad del tarball local `facturas-0.20.3-moyan.1.tgz`:

```text
sha512-kr75X3xxQ+4C67YOvzcbUwhAt6KnhKmIpTR0TEQezp5OCfsCQ1L6bhl6g8Ka97huptkGoO/QBfpfeWa5D64m/w==
```

Esta igualdad se comprobó con las fuentes finales del parche en un clone con LF,
pnpm 12.4.1 y Node 24.21.0. Los source maps incorporan el contenido fuente y sus
finales de línea. El primer artefacto construido desde el checkout CRLF tuvo
otra integridad y no es el artefacto de referencia. No se promete igualdad entre
toolchains o sistemas operativos distintos sin repetir la comprobación.

## Instalación reproducible futura

No instales la raíz del monorepo como dependencia Git. Es un workspace privado,
no el paquete `facturas`. Después de aprobar el parche, fijá el SHA completo de
su commit, usá Node 24.21.0 y pnpm 12.4.1, compilá `packages/arca` con el lockfile
y generá un tarball:

```bash
git clone -c core.autocrlf=false https://github.com/moyanop/facturas.git
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
tipos, parsers y método estrictos y el hook interno mínimo anterior al parseo,
junto con tests y documentación. Resolvé las
diferencias del helper de login sobre la nueva base y repetí la matriz y las
regresiones de autenticación. No envíes la rama histórica completa ni el cambio
de versión temporal como si fuera una actualización oficial. Prepará el
changeset correspondiente a la API aditiva en la versión upstream vigente.

El límite de rollback es el método strict, sus parsers de estructura y XML,
error público, exports, hook interno `validateResponse`, tests, verificaciones
y documentación. El hook sólo se usa en esta consulta; no altera transportes
legacy sin validador. No requiere rollback de WSAA, emisión,
reservas, numeración, bases de datos ni de Moyan. H.1B-1 permanece fuera de alcance.
