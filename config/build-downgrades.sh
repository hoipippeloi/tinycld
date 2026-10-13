#!/usr/bin/env bash
#
# build-downgrades.sh <running-build-root> <candidate-build-root>
#
# Lists every member that both build roots carry (a top-level directory with a
# package.json: tinycld, mail, …) whose version in the candidate is OLDER than
# in the running build, one "<member> <running> -> <candidate>" per line.
# Exits 1 when it finds any, 0 when there are none, 2 on bad arguments.
#
# The entrypoint runs this before it adopts a new image's baked build. The app
# also upgrades itself (in-app core and package updates build onto the volume),
# so the running build can be newer than the image it started from; adopting an
# older image would run older code against a database that newer migrations
# already changed. Versions compare with `sort -V`, which suits the plain
# MAJOR.MINOR.PATCH tags releases use.
set -eu

if [ "$#" -ne 2 ] || [ ! -d "$1" ] || [ ! -d "$2" ]; then
    echo "usage: $0 <running-build-root> <candidate-build-root>" >&2
    exit 2
fi
running="$1"
candidate="$2"

version_of() {
    sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

found=0
for manifest in "$candidate"/*/package.json; do
    [ -f "$manifest" ] || continue
    member="$(basename "$(dirname "$manifest")")"
    [ -f "$running/$member/package.json" ] || continue
    new="$(version_of "$manifest")"
    old="$(version_of "$running/$member/package.json")"
    if [ -z "$new" ] || [ -z "$old" ] || [ "$new" = "$old" ]; then
        continue
    fi
    if [ "$(printf '%s\n%s\n' "$old" "$new" | sort -V | tail -n 1)" = "$old" ]; then
        echo "$member $old -> $new"
        found=1
    fi
done
exit "$found"
