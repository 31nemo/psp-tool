#!/bin/sh
# Run e2e tests inside Docker, optionally updating snapshots.
# Usage:
#   scripts/docker-test.sh                  # run tests
#   scripts/docker-test.sh --update         # update snapshot baselines

set -e

IMAGE=psp-toolkit-e2e
LABEL=project=psp-toolkit

docker build -f Dockerfile.test -t "$IMAGE" .

if [ "$1" = "--update" ]; then
  docker run --rm -v "$(pwd)/test/e2e:/app/test/e2e" "$IMAGE" \
    sh -c 'npx playwright test --update-snapshots'
else
  docker run --rm "$IMAGE"
fi

# Clean up dangling images from previous builds
docker image prune -f --filter "label=$LABEL"
