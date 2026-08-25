#!/usr/bin/env bash
set -Eeuo pipefail

seed_dir="$(mktemp -d)"
trap 'rm -rf -- "$seed_dir"' EXIT
install -m 0400 /policygraph-seeds/01-schema.sql "$seed_dir/01-schema.sql"
install -m 0400 /policygraph-seeds/02-data.sql "$seed_dir/02-data.sql"

printf '%s  %s\n' \
  '966cdf5b918a08a0ba6df452e4ff51465ba3ed69407884e17afaf23066d1191b' "$seed_dir/01-schema.sql" \
  '3ebebfd5279970050b7a1f5850a6456c77074cd57ae108791a2ad517187d4d67' "$seed_dir/02-data.sql" \
  | sha256sum --check --strict

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --file "$seed_dir/01-schema.sql"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --file "$seed_dir/02-data.sql"
