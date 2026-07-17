#!/usr/bin/env bash
# Build and push the amd64 PayCycle image to a registry. arm64 is not
# supported — cross-arch emulation in CI hung, so arm64 was dropped as a
# deliberate non-goal, not an oversight.
#
#   docker login
#   IMAGE=yourname/paycycle ./scripts/publish-image.sh 0.1.0
#
# Pushes $IMAGE:<version> and $IMAGE:latest.
set -euo pipefail

IMAGE="${IMAGE:?Set IMAGE, e.g. IMAGE=yourname/paycycle}"
VERSION="${1:?Usage: publish-image.sh <version>, e.g. 0.1.0}"

docker buildx build \
  --platform linux/amd64 \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  --push \
  "$(dirname "$0")/.."

echo "Published $IMAGE:$VERSION and $IMAGE:latest"
