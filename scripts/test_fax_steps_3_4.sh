#!/usr/bin/env bash

set -euo pipefail

API_KEY="${MEDSENDER_API_KEY:-}"
FROM_NUMBER="+14252074289"
TO_NUMBER="${TO_NUMBER:-+14252074289}"
INBOUND_FROM_NUMBER="${INBOUND_FROM_NUMBER:-+12065550123}"
PDF_PATH="${1:-}"
RUN_INBOUND_TEST="${RUN_INBOUND_TEST:-false}"

if [[ -z "$API_KEY" ]]; then
  echo "Error: MEDSENDER_API_KEY is not set."
  echo "Set it with: export MEDSENDER_API_KEY='sk_test_...'"
  exit 1
fi

if [[ -z "$PDF_PATH" ]]; then
  echo "Usage: MEDSENDER_API_KEY=sk_test_... $0 /absolute/path/to/sample.pdf"
  echo "Optional env vars:"
  echo "  TO_NUMBER=+1..."
  echo "  INBOUND_FROM_NUMBER=+1..."
  echo "  RUN_INBOUND_TEST=true"
  exit 1
fi

if [[ ! -f "$PDF_PATH" ]]; then
  echo "Error: PDF not found at path: $PDF_PATH"
  exit 1
fi

echo "Step 3: Sending test fax..."
curl -sS -X POST "https://api.medsender.com/api/v2/sent_faxes" \
  -H "Authorization: Bearer $API_KEY" \
  -F "from_number=$FROM_NUMBER" \
  -F "to_number=$TO_NUMBER" \
  -F "file=@$PDF_PATH"

echo
echo "Step 3 complete. Confirm delivery status in the Medsender portal."

if [[ "$RUN_INBOUND_TEST" == "true" ]]; then
  echo
  echo "Step 4: Triggering inbound test fax..."
  curl -sS -X POST "https://api.medsender.com/api/v2/received_faxes/test_receive" \
    -H "Authorization: Bearer $API_KEY" \
    -F "to_number=$FROM_NUMBER" \
    -F "from_number=$INBOUND_FROM_NUMBER" \
    -F "file=@$PDF_PATH"
  echo
  echo "Step 4 complete. Check webhook receiver logs and the Medsender portal."
else
  echo
  echo "Step 4 skipped. Set RUN_INBOUND_TEST=true to execute inbound test receive."
fi
