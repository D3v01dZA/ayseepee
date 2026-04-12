#!/bin/sh

set -ex

echo "Testing for running docker"
docker ps > /dev/null

echo "Building docker image using Docker"
docker buildx build --platform linux/amd64 --push -t d3v01d/ayseepee:stable .

echo "Build complete!"
