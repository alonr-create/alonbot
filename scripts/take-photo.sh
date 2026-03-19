#!/bin/bash
OUTPUT="${1:-/tmp/alonbot-camera.jpg}"
/opt/homebrew/bin/imagesnap -w 1 "$OUTPUT" 2>&1
