FROM denoland/deno:alpine AS base
WORKDIR /app
RUN apk add --no-cache docker-cli

COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache --lock=deno.lock --frozen src/main.ts

FROM base AS development
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000/tcp 5353/udp 5353/tcp
CMD ["deno", "task", "dev"]

FROM base AS production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000/tcp 5353/udp 5353/tcp
CMD ["deno", "task", "start"]
