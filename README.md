# Conecta

Conecta es un webhook de despliegue blue/green para contenedores Docker. Una
imagen pequeña mantiene el estado en SQLite, publica el destino activo mediante
DNS y deja que el resto de la plataforma lo elijas tú.

Puedes combinarlo con GitHub Actions, un registro Docker y un webhook; hacer el
build localmente y llamar al webhook; o integrarlo con cualquier CI/CD propia.
Conecta no impone proveedor de Git, registro, proxy ni terminación TLS.

## Qué incluye

- API HTTP para desplegar y repetir rollouts.
- DNS autoritativo interno para registros `A`, `AAAA` y `SRV`.
- Cambio blue/green con comprobación HTTP de salud.
- Persistencia SQLite en `/data/conecta.sqlite`.
- Una única imagen basada en Deno y Docker CLI.

Conecta no incluye dashboard, CI/CD ni certificados TLS. Caddy, Traefik u otro
proxy debe compartir la red Docker y consultar el DNS de Conecta.

## Inicio rápido

El ejemplo completo arranca Conecta y Caddy en una red Docker compartida:

```bash
cp .env.example .env
chmod 600 .env
mkdir -p env
docker compose -f examples/compose.yaml up --build -d
curl --fail http://127.0.0.1:3000/healthz
```

El ejemplo publica Caddy en `http://127.0.0.1:8080`. Para usar una aplicación de
prueba, despliega una imagen con el webhook y visita esa dirección:

```bash
curl --fail-with-body --request POST \
  http://127.0.0.1:3000/deploy/api \
  --header "Authorization: Bearer YOUR_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"config":{"name":"Demo API","image":"traefik/whoami","container_port":80,"health_path":"/","startup_timeout_seconds":60},"tag":"v1.10.3"}'

curl --fail http://127.0.0.1:8080
```

Adapta `examples/compose.yaml` y `examples/caddy/Caddyfile` para tu dominio,
TLS y red de producción.

## Flujos de despliegue

El webhook recibe la configuración completa del proyecto y el tag de la imagen:

```bash
curl --fail-with-body --request POST \
  https://conecta.example.com/deploy/api \
  --header "Authorization: Bearer YOUR_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"config":{"name":"Customer API","image":"ghcr.io/acme/api","container_port":3000,"health_path":"/healthz","startup_timeout_seconds":60,"env_file":"/data/env/api.env"},"tag":"sha-COMMIT_SHA"}'
```

El `tag` puede proceder de GitHub Actions, de un build local o de cualquier
automatización. Para un registro privado, guarda el token en `.env` y referencia
solo su nombre:

```json
{
  "registry": {
    "username": "acme",
    "password_env": "REGISTRY_ACME_TOKEN"
  }
}
```

Para repetir el último tag almacenado:

```bash
curl --fail-with-body --request POST \
  https://conecta.example.com/rollout/api \
  --header "Authorization: Bearer YOUR_API_KEY"
```

## Configuración

Copia `.env.example` a `.env` y cambia al menos `CONECTA_API_KEY` por un secreto
aleatorio. Las variables son:

| Variable | Uso | Valor por defecto |
| --- | --- | --- |
| `HOSTNAME` / `PORT` | API HTTP | `0.0.0.0` / `3000` |
| `CONECTA_API_KEY` | Autenticación del webhook | Obligatoria |
| `CONECTA_DOCKER_NETWORK` | Red de Conecta y las aplicaciones | `conecta` |
| `CONECTA_DB_PATH` | Base de datos SQLite | `/data/conecta.sqlite` |
| `CONECTA_DNS_HOSTNAME` / `CONECTA_DNS_PORT` | Listener DNS | `0.0.0.0` / `5353` |
| `CONECTA_DNS_ZONE` | Zona privada publicada | `svc.internal` |
| `CONECTA_DNS_TTL_SECONDS` | TTL de respuestas DNS | `5` |
| `CONECTA_DNS_PROPAGATION_SECONDS` | Espera antes de retirar el slot anterior | `10` |

El TTL admite de `0` a `3600`. La propagación debe cubrir como mínimo el
`refresh` configurado en Caddy. Las credenciales `REGISTRY_*` son variables
adicionales definidas por cada proyecto; nunca se envían en el webhook.

## DNS y proxy

Para el proyecto `api` y la zona `svc.internal`, Conecta publica:

- `api.svc.internal` mediante `A`/`AAAA`.
- `_http._tcp.api.svc.internal` mediante `SRV`.

El proxy debe resolver el registro `SRV` y después el destino del servicio usando
`conecta:5353`. El ejemplo de Caddy incluido muestra esa configuración.

## Persistencia y seguridad

Conserva el volumen Docker `conecta-data` al actualizar. No uses
`docker compose down --volumes` salvo que quieras borrar la configuración y el
registro.

Protege la API key, los tokens `REGISTRY_*`, el socket de Docker, la base de
datos y los archivos de entorno. Mantén estos recursos en redes privadas y
monta los archivos de aplicación como solo lectura.

## Desarrollo

El código usa Deno y los tests unitarios están en `src/`:

```bash
deno task check
deno task test
```
