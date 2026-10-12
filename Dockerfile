# Mezsgye Atlas — no build step, no dependencies to install.
FROM node:22-alpine

# su-exec lets the entrypoint drop from root to an unprivileged user after it
# has fixed up permissions on the (possibly bind-mounted) data directory.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Atlas files live here; mount a volume to keep them.
ENV ATLAS_DATA=/data
ENV HOST=0.0.0.0
ENV PORT=7311
RUN mkdir -p /data && chown -R node:node /data

# NOTE: we intentionally stay root as the image's default user so the
# entrypoint can chown a bind-mounted /data that the host owns as root. The
# entrypoint immediately drops privileges to an unprivileged user before
# running the server. Pass `--user` to skip that and run fully unprivileged.
EXPOSE 7311

# NOTE: the app has no authentication. Only publish this port on a trusted
# network, or keep it bound to localhost with `-p 127.0.0.1:7311:7311`.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
