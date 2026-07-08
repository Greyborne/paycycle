#!/usr/bin/env bash
# Build and push the multi-arch (amd64 + arm64) PayCycle image to a registry.
#
#   docker login
#   IMAGE=yourname/paycycle ./scripts/publish-image.sh 0.1.0
#
# Pushes $IMAGE:<version> and $IMAGE:latest. Requires a docker buildx builder
# with arm64 support (docker buildx create --use gives you one).
set -euo pipefail

IMAGE="${IMAGE:?Set IMAGE, e.g. IMAGE=yourname/paycycle}"
VERSION="${1:?Usage: publish-image.sh <version>, e.g. 0.1.0}"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  --push \
  "$(dirname "$0")/.."

echo "Published $IMAGE:$VERSION and $IMAGE:latest"
