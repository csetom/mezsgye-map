#!/bin/sh
# Mezsgye Atlas container entrypoint.
#
# A bind-mounted data directory (e.g. `-v "$PWD/data:/data"`) keeps the host's
# ownership, which is often root or some uid that is not the `node` user inside
# the image. That makes the data directory unwritable and the app fails to save
# atlases.
#
# To cope, we start as root purely to make the data directory writable, then
# drop to an unprivileged user with the same uid as the directory's owner (or
# the `node` user by default) before running the server. If we are already
# unprivileged (the image was started with `--user`), we skip the fix-up and
# run directly.

set -e

DATA_DIR="${ATLAS_DATA:-/data}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  # Running as root: match the data directory's existing owner so the files we
  # create stay accessible on the host, then make sure it is writable.
  owner_uid="$(stat -c '%u' "$DATA_DIR" 2>/dev/null || echo 0)"
  owner_gid="$(stat -c '%g' "$DATA_DIR" 2>/dev/null || echo 0)"

  if [ "$owner_uid" = "0" ]; then
    # Directory owned by root (common for a freshly bind-mounted empty dir):
    # hand it to the built-in `node` user so the server can write to it.
    owner_uid="$(id -u node)"
    owner_gid="$(id -g node)"
    chown -R "$owner_uid:$owner_gid" "$DATA_DIR"
  else
    # Directory owned by a specific host uid: make sure that uid owns it.
    chown -R "$owner_uid:$owner_gid" "$DATA_DIR" 2>/dev/null || true
  fi

  # Drop privileges to the data directory's owner and exec the server.
  exec su-exec "$owner_uid:$owner_gid" "$@"
fi

# Already unprivileged (started with --user): run as-is.
exec "$@"
