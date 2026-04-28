# Despliegue en AWS — Workflow Engine (examen1)

Documento de referencia del despliegue actual en producción. Pensado para que cualquier persona (o agente) que retome el proyecto pueda entender la arquitectura, redesplegar cambios, depurar fallos y, si llega el caso, reconstruir todo desde cero.

> **Cuenta AWS:** `142966787350` · **Región:** `us-east-1` · **Perfil CLI:** `examen1`
> **Usuario CLI usado para crear todo:** root (Access Key `AKIASCSL4BULNLU2VPZJ`). Recomendación pendiente: rotar y migrar a un usuario IAM.

---

## 1. Arquitectura

```
                  ┌──────────────────────────┐
                  │  Navegador (HTTPS)       │
                  └────────────┬─────────────┘
                               │
                               ▼
                  ┌──────────────────────────┐
                  │  CloudFront (HTTPS)      │
                  │  d3c6bu8hmorac9          │
                  │     .cloudfront.net      │
                  └─┬──────────┬──────────┬──┘
                    │          │          │
        path: /*    │  /api/*  │  /ai/*   │
        (default)   │  /ws/*   │ /insights/*
                    ▼          ▼          ▼
              ┌──────────┐  ┌────────┐  ┌──────────┐
              │   S3     │  │ EB     │  │  EB      │
              │ Angular  │  │ Java   │  │ Python   │
              │  static  │  │ Spring │  │ FastAPI  │
              │  site    │  │ Boot   │  │ + ML/AI  │
              └──────────┘  └───┬────┘  └────┬─────┘
                                │            │
                                └─────┬──────┘
                                      ▼
                          ┌────────────────────┐
                          │ MongoDB Atlas (M0) │
                          │  workflow_engine   │
                          └────────────────────┘
```

**Por qué CloudFront delante de todo:** la app necesita HTTPS para que `crypto.randomUUID` y `Web Speech API` (mic del Diseñador) funcionen — ambas APIs solo están disponibles en *secure contexts*. CloudFront da HTTPS gratis con su certificado por defecto y resuelve dos problemas extra de regalo: deja todo bajo un solo dominio (sin CORS) y hace que las deep-links como `/admin` funcionen porque mapea cualquier 404 → `/index.html`.

**Comunicación entre servicios — punto importante:**
Java y Python **NO se hablan entre sí**. Ambos backends:
- Apuntan a la **misma base de datos Mongo** (Java escribe, Python lee).
- Comparten el mismo `JWT_SECRET` para que Python pueda verificar tokens HS256 que firmó Java.
- Son llamados independientemente por el navegador. El frontend Angular sabe a cuál llamar para cada feature.

Si en el futuro un servicio necesitara hablar con el otro, se haría por HTTP (como cualquier microservicio), no hay otra magia.

---

## 2. URLs en producción

| Servicio | URL |
|---|---|
| **App pública (HTTPS, este es el que se usa)** | **https://d3c6bu8hmorac9.cloudfront.net** |
| Frontend S3 (origen, no usar direct) | http://examen1-frontend-142966787350.s3-website-us-east-1.amazonaws.com |
| Backend Java (origen, no usar direct) | http://examen1-java-prod.eba-pmtbzyyd.us-east-1.elasticbeanstalk.com |
| Backend Python (origen, no usar direct) | http://examen1-python-prod.eba-bauepspf.us-east-1.elasticbeanstalk.com |
| MongoDB Atlas | `mongodb+srv://...@cluster0.whlr3uj.mongodb.net/workflow_engine` |
| CloudFront Distribution ID | `E3UFTVI4K7OAO2` |

**Login bootstrap (creado al primer arranque del Java):**
- Email: `admin@workflow.local`
- Password: `Admin12345!`

---

## 3. Recursos AWS creados

### 3.1 IAM (roles que Elastic Beanstalk requiere)

Cuentas nuevas no traen estos roles por defecto; se crearon manualmente.

| Rol / Profile | Para qué |
|---|---|
| `aws-elasticbeanstalk-service-role` | Lo asume el servicio EB para gestionar la infra (auto-scaling, health checks, etc.). Adjuntas: `AWSElasticBeanstalkEnhancedHealth`, `AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy`. |
| `aws-elasticbeanstalk-ec2-role` | Lo monta cada EC2 que EB lanza, para escribir logs y leer artefactos. Adjuntas: `AWSElasticBeanstalkWebTier`, `AWSElasticBeanstalkMulticontainerDocker`, `AWSElasticBeanstalkWorkerTier`. Tiene un Instance Profile homónimo. |

Trust policies en `aws/eb-service-trust.json` y `aws/eb-ec2-trust.json`.

### 3.2 S3 buckets

| Bucket | Uso | Notas |
|---|---|---|
| `examen1-deploy-142966787350` | Almacena los `.zip` de Application Versions de EB. | Versionado activado. Privado. |
| `examen1-frontend-142966787350` | Hosting estático del Angular. | Public read habilitado, `index.html` como Index *y* Error Document (para SPA fallback). |

### 3.3 CloudFront

| Campo | Valor |
|---|---|
| ID | `E3UFTVI4K7OAO2` |
| Domain | `d3c6bu8hmorac9.cloudfront.net` |
| Price class | `PriceClass_100` (US/EU/CA — el más barato) |
| Cert | CloudFront default (`*.cloudfront.net`) |

**Orígenes y comportamientos** (configurados en `aws/cloudfront-config.json`):

| Path Pattern | Origen | Cache | Origin Request Policy |
|---|---|---|---|
| `/api/*` | EB Java | Disabled | AllViewerExceptHostHeader (Spring Boot ignora Host) |
| `/ws/*` | EB Java | Disabled | AllViewer (WS necesita todos los headers) |
| `/insights/*` | EB Python | Disabled | AllViewerExceptHostHeader |
| `/ai/*` | EB Python | Disabled | AllViewerExceptHostHeader |
| `/healthz` | EB Python | Disabled | AllViewerExceptHostHeader |
| `/*` (default) | S3 website | CachingOptimized | CORS-S3Origin |

**Custom error responses:** `403 → 200 /index.html`, `404 → 200 /index.html`. Esto hace que las deep links del SPA (ej. `/admin/policies`) funcionen — sin esto S3 devolvía 404 y los navegadores rehúsan ejecutar JS en respuestas 404.

**Viewer Protocol Policy:** `redirect-to-https` en TODOS los behaviors → si alguien entra por `http://` lo redirige a `https://`.

### 3.4 Elastic Beanstalk

Plataforma usada en ambos: `64bit Amazon Linux 2023 v4.12.1 running Docker` (single-container).

| Aplicación | Entorno | Tipo | URL pública |
|---|---|---|---|
| `examen1-java` | `examen1-java-prod` | SingleInstance, t3.small | `examen1-java-prod.eba-pmtbzyyd.us-east-1.elasticbeanstalk.com` |
| `examen1-python` | `examen1-python-prod` | SingleInstance, t3.small | `examen1-python-prod.eba-bauepspf.us-east-1.elasticbeanstalk.com` |

`SingleInstance` significa **sin Application Load Balancer**: 1 EC2, EIP fijo, puerto 80 público. Sale más barato y suficiente para el examen. El downside es que no tenemos HTTPS hasta que metamos un ALB con certificado ACM o un CloudFront delante.

### 3.5 Variables de entorno inyectadas

**EB Java** (en `aws/eb-options-java.json`):
- `MONGODB_URI` — URI completa con `/workflow_engine?retryWrites=true&w=majority`
- `JWT_SECRET` — clave HS256 base64 (compartida con Python)
- `JWT_ISSUER` — `workflow-engine`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` — bootstrap admin
- `SERVER_PORT` — `8080`

**EB Python** (en `aws/eb-options-python.json`):
- `MONGODB_URI` — misma URI
- `JWT_SECRET`, `JWT_ISSUER` — mismos que Java (la verificación lo exige)
- `ANTHROPIC_API_KEY` — para `/ai/chat` y `/ai/form-fill`
- `ANTHROPIC_MODEL` — `claude-sonnet-4-5`
- `CORS_ORIGINS` — lista separada por comas con dominio del bucket S3 + `localhost:4200`

> **Importante:** estos JSON tienen secretos en claro. No los subas a un repo público. Si rotas claves, edítalos y vuelve a aplicar (ver §6.4).

---

## 4. Cambios al código que el despliegue requirió

Si vas a clonar a otra máquina para redesplegar, ten en cuenta:

### 4.1 `examen1_backend/Dockerfile` (creado)

Multi-stage build. Usa imagen oficial `maven:3.9-amazoncorretto-21` (NO usar `mvnw` — el Maven wrapper en modo `only-script` falla al desempacar Maven dentro del contenedor).

### 4.2 `examen1_backend/Dockerrun.aws.json` (creado)

Mapea puerto del contenedor `8080` → `HostPort 80` para que EB lo enrute correctamente.

### 4.3 `examen1_Backend2/Dockerfile` (creado)

`python:3.11-slim` + `requirements.txt` + `uvicorn`.

### 4.4 `examen1_Backend2/Dockerrun.aws.json` (creado)

Mapea `8001` → `HostPort 80`.

### 4.5 `examen1_Backend2/main.py` (modificado)

CORS pasó de hardcoded `localhost:4200` a leer `CORS_ORIGINS` env var (separados por coma). Imprescindible para que el frontend en S3 pueda llamar a Python.

### 4.6 `examen1_Backend2/.dockerignore` (creado)

Excluye `.env` para que **no** se suba al contenedor (las env vars se inyectan vía EB, no desde un .env empaquetado).

### 4.7 `examen1_frontend/src/environments/environment.prod.ts` (modificado)

Usa **paths relativos** porque todo va por el mismo dominio CloudFront:

```ts
export const environment = {
  production: true,
  apiBaseUrl: '/api',
  wsBaseUrl: 'wss://d3c6bu8hmorac9.cloudfront.net/ws/policies',
  aiBaseUrl: ''
};
```

Si llegas a renombrar la distribución CloudFront, actualiza el `wsBaseUrl` (necesita URL absoluta para el constructor `WebSocket`).

### 4.8 `examen1_frontend/angular.json` (modificado)

Dos cambios críticos:
- **`fileReplacements`** en la configuración `production`. **Sin esto el build no sustituye `environment.ts` por `environment.prod.ts`** y el bundle queda apuntando a `localhost:8080`.
- **Budgets relajados** (`anyComponentStyle: 16kb / 32kb`) porque varios componentes superan los 4kb default.

### 4.9 `examen1_frontend/src/main.ts` (modificado)

Polyfill de `crypto.randomUUID`. Esta API solo está disponible en contextos seguros (HTTPS o localhost). El polyfill protege también el caso en que alguien entre por la URL HTTP directa del bucket S3, no la HTTPS de CloudFront. Es no-op cuando la API nativa existe.

> Nota relacionada: el botón de **micrófono del Diseñador BPMN** (Web Speech API) también es secure-context-only, pero a esa API **no se le puede hacer polyfill** — la única solución es servir el frontend por HTTPS, que es por lo que existe el CloudFront.

---

## 5. Cómo redesplegar cambios

### 5.1 Backend Java (Spring Boot)

```bash
cd /c/Universidad/software-g

# 1. Empaquetar (script PowerShell que produce un ZIP con forward slashes —
#    Compress-Archive de PS5 produce backslashes que Linux no entiende).
powershell -File aws/zip-source.ps1 \
  -Source "./examen1_backend" \
  -Destination "./aws/java-backend.zip" \
  -Exclude @("target/*",".mvn/*","mvnw","mvnw.cmd",".git/*",".idea/*")

# 2. Elegir un version label nuevo (vN+1) y subir
VERSION="v4"   # incrementa
aws s3 cp ./aws/java-backend.zip s3://examen1-deploy-142966787350/java-backend-$VERSION.zip --profile examen1

aws elasticbeanstalk create-application-version \
  --application-name examen1-java \
  --version-label $VERSION \
  --source-bundle S3Bucket=examen1-deploy-142966787350,S3Key=java-backend-$VERSION.zip \
  --profile examen1

# 3. Aplicar al entorno (toma ~3-5 min)
aws elasticbeanstalk update-environment \
  --environment-name examen1-java-prod \
  --version-label $VERSION \
  --profile examen1

# 4. Esperar a que termine
aws elasticbeanstalk describe-environments \
  --environment-names examen1-java-prod \
  --profile examen1 \
  --query 'Environments[0].{Status:Status,Health:Health,Version:VersionLabel}'
```

Cuando `Status=Ready` y `Health=Green`, la nueva versión está corriendo. Si vuelve `Health=Yellow` o `Red`, ver §7.

### 5.2 Backend Python (FastAPI)

```bash
cd /c/Universidad/software-g

powershell -File aws/zip-source.ps1 \
  -Source "./examen1_Backend2" \
  -Destination "./aws/python-backend.zip" \
  -Exclude @(".env","__pycache__/*",".venv/*","venv/*",".git/*")

VERSION="v3"   # incrementa
aws s3 cp ./aws/python-backend.zip s3://examen1-deploy-142966787350/python-backend-$VERSION.zip --profile examen1

aws elasticbeanstalk create-application-version \
  --application-name examen1-python \
  --version-label $VERSION \
  --source-bundle S3Bucket=examen1-deploy-142966787350,S3Key=python-backend-$VERSION.zip \
  --profile examen1

aws elasticbeanstalk update-environment \
  --environment-name examen1-python-prod \
  --version-label $VERSION \
  --profile examen1
```

### 5.3 Frontend Angular

```bash
cd /c/Universidad/software-g/examen1_frontend

# 1. Build
npm run build -- --configuration=production

# 2. Sync a S3 con Content-Type correcto por extensión.
#    IMPORTANTE: nunca uses --metadata-directive REPLACE sin pasar
#    --content-type explícito, porque AWS resetea el MIME a
#    binary/octet-stream y el navegador rechaza ejecutar los .js.

cd dist/app/browser

# Assets sin necesidad de override (favicon, etc.)
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "index.html" --exclude "*.js" --exclude "*.css" \
  --exclude "*.svg" --exclude "*.woff*" --exclude "*.ttf" --exclude "*.eot" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1

# JavaScript
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.js" \
  --content-type "text/javascript" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1

# CSS
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.css" \
  --content-type "text/css" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1

# Fuentes y SVG
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.svg" \
  --content-type "image/svg+xml" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.woff2" \
  --content-type "font/woff2" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.woff" \
  --content-type "font/woff" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.ttf" \
  --content-type "font/ttf" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1
aws s3 cp . s3://examen1-frontend-142966787350/ --recursive \
  --exclude "*" --include "*.eot" \
  --content-type "application/vnd.ms-fontobject" \
  --cache-control "public,max-age=31536000,immutable" --profile examen1

# index.html — siempre fresco para que el browser pille los nuevos chunks
aws s3 cp ./index.html s3://examen1-frontend-142966787350/index.html \
  --content-type "text/html" \
  --cache-control "no-cache,no-store,must-revalidate" --profile examen1

# Limpiar chunks viejos cuyo hash ya no se usa
aws s3 sync . s3://examen1-frontend-142966787350/ --delete --size-only --profile examen1

# 3. Invalidar caché de CloudFront SOLO para index.html
#    (los chunks tienen hash, son inmutables y se sirven con max-age=1y).
#    En Windows / Git Bash el shell se come las comillas con --paths,
#    así que pasamos el batch como archivo:
cat > /tmp/inv.json <<EOF
{ "Paths": { "Quantity": 1, "Items": ["/index.html"] },
  "CallerReference": "deploy-$(date +%s)" }
EOF
aws cloudfront create-invalidation \
  --distribution-id E3UFTVI4K7OAO2 \
  --invalidation-batch file:///tmp/inv.json \
  --profile examen1
```

Después de subir, espera ~1 minuto a que la invalidación termine y prueba en una pestaña incógnita. CloudFront te da 1000 invalidations/mes gratis, no hay que ahorrar.

---

## 6. Tareas operativas comunes

### 6.1 Cambiar una variable de entorno en un EB

```bash
# Ejemplo: actualizar CORS_ORIGINS en Python
cat > /tmp/update.json <<'EOF'
[
  { "Namespace": "aws:elasticbeanstalk:application:environment",
    "OptionName": "CORS_ORIGINS",
    "Value": "http://nuevo-dominio.com,http://examen1-frontend-142966787350.s3-website-us-east-1.amazonaws.com,http://localhost:4200" }
]
EOF

aws elasticbeanstalk update-environment \
  --environment-name examen1-python-prod \
  --option-settings file:///tmp/update.json \
  --profile examen1
```

EB hace un rolling update sin downtime real (en SingleInstance reinicia el contenedor — ~30s sin servicio).

### 6.2 Ver logs

```bash
# 1. Pedir tail al EB
aws elasticbeanstalk request-environment-info \
  --environment-name examen1-java-prod \
  --info-type tail --profile examen1

# 2. Esperar ~25s y recuperar la URL prefirmada (luego curl al URL)
aws elasticbeanstalk retrieve-environment-info \
  --environment-name examen1-java-prod \
  --info-type tail --profile examen1 \
  --query 'EnvironmentInfo[0].Message' --output text
```

Para logs completos cambia `tail` por `bundle`.

### 6.3 Ver eventos del EB (deploys, health changes)

```bash
aws elasticbeanstalk describe-events \
  --environment-name examen1-java-prod \
  --max-items 20 --profile examen1 \
  --query 'Events[*].{T:EventDate,S:Severity,M:Message}' --output table
```

### 6.4 Invalidar caché de CloudFront

Solo necesitas invalidar `/index.html` después de un deploy de frontend (los chunks con hash son inmutables). Si por alguna razón quieres invalidar todo:

```bash
aws cloudfront create-invalidation --distribution-id E3UFTVI4K7OAO2 --paths "/*" --profile examen1
```

Tarda ~3-5 min y te da 1000 paths/mes gratis.

### 6.5 Rotar secretos

1. **Anthropic key:** consola anthropic.com → API Keys → revocar la actual y generar nueva. Actualizar `ANTHROPIC_API_KEY` en EB Python (§6.1).
2. **JWT_SECRET:** generar uno nuevo (`openssl rand -base64 64`). **Aplicarlo a los DOS entornos EB** (Java y Python) al mismo tiempo, porque si difieren los tokens de Java no validan en Python. Tras cambiarlo todos los usuarios deben re-loguearse.
3. **MongoDB password:** Atlas → Database Access → editar usuario → Edit Password → autogenerate. Actualizar `MONGODB_URI` en los DOS entornos EB.
4. **AWS Access Keys:** consola AWS → Security credentials → desactivar/borrar la actual y crear una nueva. `aws configure --profile examen1` con la nueva.

---

## 7. Problemas que se resolvieron durante el deploy (y cómo evitarlos)

Documento esto porque cualquier rollback o deploy desde otra máquina probablemente los volverá a encontrar.

### 7.1 ZIP con backslashes
PowerShell 5.1 `Compress-Archive` produce ZIPs con rutas `dir\file` (backslash). Linux trata esos paths como nombres de archivo literales y EB falla con "source bundle has issues". **Solución:** usar `aws/zip-source.ps1` (vía `[System.IO.Compression.ZipArchive]`) que sí escribe forward slashes.

### 7.2 `mvnw` falla en Docker
El Maven wrapper en modo `distributionType=only-script` (versión moderna) intenta descargar y desempacar Maven en el contenedor → "failed to untar". **Solución:** el `Dockerfile` actual usa `maven:3.9-amazoncorretto-21` y NO copia el wrapper.

### 7.3 Frontend apuntaba a `localhost:8080`
Faltaba `fileReplacements` en `angular.json`. Sin esa entrada, `ng build --configuration=production` ignora `environment.prod.ts`. **Ya corregido en el repo.**

### 7.4 MIME `binary/octet-stream` en los `.js`
Si haces `aws s3 cp ... --metadata-directive REPLACE` sin pasar `--content-type`, AWS lo resetea a `binary/octet-stream` y los navegadores rechazan ejecutar el módulo ("Failed to load module script: Strict MIME type checking"). **Siempre** pasa `--content-type` explícito al replace, o usa el flujo de §5.3.

### 7.5 `crypto.randomUUID is not a function`
Esta API solo está disponible en *secure contexts* (HTTPS o localhost). Sobre HTTP plano S3 está `undefined` y el código que la llama tira excepción. Hay un polyfill en `src/main.ts` que la define si falta. Si en algún momento muevas el frontend detrás de HTTPS (CloudFront), el polyfill se vuelve no-op (la API nativa toma precedencia automáticamente).

### 7.6 Deep links a `/admin` devuelven 404 *(resuelto con CloudFront)*
Antes, S3 devolvía el ErrorDocument con status 404. CloudFront ahora está configurado con `CustomErrorResponses` para mapear 403/404 → 200 con `/index.html`, así que los deep links funcionan normalmente.

### 7.7 Web Speech API (micrófono) y `crypto.randomUUID` no funcionan en HTTP
Ambas APIs son *secure-context-only*. **No** funcionan sobre `http://`. CloudFront resuelve esto sirviendo todo por HTTPS. Si alguna vez ves "No detecté audio" en el mic del Diseñador, comprueba que el usuario está entrando por la URL CloudFront (`d3c6bu8hmorac9.cloudfront.net`), no por la URL directa del S3 website.

---

## 8. Costos estimados

| Recurso | Costo aprox. |
|---|---|
| 2× EC2 t3.small (SingleInstance) 24/7 | ~$30 / mes |
| 2× Elastic IP estática | ~$0 (hay 1 EIP por instancia, asignada) |
| S3 (storage + transfer del frontend) | <$1 / mes |
| CloudFront (PriceClass_100, tráfico bajo) | <$1 / mes (1 TB gratis al mes con free tier) |
| MongoDB Atlas M0 | $0 (free tier) |
| **Total** | **~$31 / mes** |

Con $100 de créditos da para ~3 meses cómodos. Para abaratar: bajar a `t3.micro` (suficiente si no hay carga real) → ~$16/mes total.

---

## 9. Si tuvieras que reconstruir todo desde cero

Orden mínimo de pasos:

1. `aws configure --profile examen1` con Access Key del usuario (preferentemente IAM, no root).
2. Verificar VPC default existe en `us-east-1`: `aws ec2 describe-vpcs --filters Name=is-default,Values=true --profile examen1 --query 'Vpcs[0].VpcId'`
3. Crear roles IAM `aws-elasticbeanstalk-service-role` y `aws-elasticbeanstalk-ec2-role` con sus trust policies (`aws/eb-*-trust.json`) y políticas adjuntas. Crear el Instance Profile homónimo y vincularle el rol EC2.
4. Crear bucket `examen1-deploy-<accountId>` (privado, versionado) y bucket `examen1-frontend-<accountId>` (public read, website hosting con `index.html` como Index y Error).
5. Configurar Mongo Atlas: cluster M0, usuario con read+write, Network Access `0.0.0.0/0`, copiar URI con `/workflow_engine`.
6. Editar `aws/eb-options-java.json` y `aws/eb-options-python.json` con secretos reales.
7. Empaquetar y subir las primeras Application Versions (§5.1 y §5.2) con `--version-label v1`.
8. Crear los entornos:

   ```bash
   aws elasticbeanstalk create-environment \
     --application-name examen1-java \
     --environment-name examen1-java-prod \
     --solution-stack-name "64bit Amazon Linux 2023 v4.12.1 running Docker" \
     --version-label v1 \
     --option-settings file://aws/eb-options-java.json --profile examen1
   ```

   Igual para Python.

9. Esperar Status=Ready, Health=Green. Si no, ver §6.2 / §6.3.
10. Build del frontend con las URLs reales de los EB (editar `environment.prod.ts`) y subir según §5.3.

---

## 10. Mejoras posibles (no urgentes)

- **Custom domain:** Route 53 → alias a CloudFront → cert ACM con tu dominio. Lo único pendiente es comprar el dominio.
- **Migrar a usuario IAM:** el deploy está hecho con la Access Key del root, lo cual AWS desaconseja. Crear un IAM con permisos limitados a EB+S3+IAM (para los roles de EB).
- **CI/CD:** GitHub Actions con un workflow por componente que haga `zip + s3 cp + create-application-version + update-environment` automáticamente al push a `main`.
- **Logs centralizados:** activar CloudWatch logs streaming en ambos EB (option `aws:elasticbeanstalk:cloudwatch:logs`).

---

## 11. Archivos relevantes en el repo

| Archivo | Para qué |
|---|---|
| `aws/eb-service-trust.json` | Trust policy del rol de servicio EB |
| `aws/eb-ec2-trust.json` | Trust policy del rol EC2 de EB |
| `aws/eb-options-java.json` | Variables de entorno + config del EB Java |
| `aws/eb-options-python.json` | Variables de entorno + config del EB Python |
| `aws/python-cors-update.json` | Plantilla para actualizar `CORS_ORIGINS` en Python |
| `aws/s3-website-config.json` | Config de hosting estático del bucket frontend |
| `aws/s3-frontend-policy.json` | Bucket policy public-read del frontend |
| `aws/cloudfront-config.json` | Config completa de la distribución CloudFront |
| `aws/zip-source.ps1` | Script PowerShell para empaquetar con forward slashes |
| `examen1_backend/Dockerfile` | Multi-stage build del Spring Boot |
| `examen1_backend/Dockerrun.aws.json` | Mapeo de puerto para EB |
| `examen1_backend/.dockerignore` | Excluye `target/` y `.git/` |
| `examen1_Backend2/Dockerfile` | Build de FastAPI |
| `examen1_Backend2/Dockerrun.aws.json` | Mapeo de puerto para EB |
| `examen1_Backend2/.dockerignore` | Excluye `.env` |

---

## 12. Resumen TL;DR

- **URL pública:** https://d3c6bu8hmorac9.cloudfront.net (todo bajo este dominio HTTPS).
- **3 servicios** detrás de CloudFront: Angular en S3, Java en EB Docker, Python en EB Docker. + **Mongo Atlas**.
- Java y Python no se hablan entre sí: comparten la BD y el `JWT_SECRET`.
- Para subir cambios: §5.1 (Java), §5.2 (Python), §5.3 (Frontend + invalidate CloudFront).
- Para cambiar variables sin redeploy de código: §6.1.
- Si el navegador da MIME error tras subir el frontend: olvidaste pasar `--content-type` al `aws s3 cp`. Reaplica §5.3.
- Si el mic del Diseñador o `crypto.randomUUID` falla: el usuario está entrando por la URL HTTP de S3, no por la URL HTTPS de CloudFront.
- Si después del deploy el navegador muestra la versión vieja: invalidar `/index.html` en CloudFront (§6.4).

— Fin —
