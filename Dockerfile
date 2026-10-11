# Mezsgye Atlas — no build step, no dependencies to install.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY test ./test

# Atlas files live here; mount a volume to keep them.
ENV ATLAS_DATA=/data
ENV HOST=0.0.0.0
ENV PORT=7311
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 7311

# NOTE: the app has no authentication. Only publish this port on a trusted
# network, or keep it bound to localhost with `-p 127.0.0.1:7311:7311`.
CMD ["node", "server.js"]
