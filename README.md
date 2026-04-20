# MedSender Chrome Extension

This extension is a Medsender API helper that lets you:

- Save your Medsender API key and API base URL
- Send a fax with a PDF file from the popup
- View recent sent faxes and their status

## API used

- Base URL default: https://api.medsender.com/api/v2
- Authentication: Authorization header with Bearer API key
- Endpoints used in popup:
	- POST /sent_faxes
	- GET /sent_faxes

## Setup

1. Open Chrome and go to chrome://extensions.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open the extension and click API Settings.
6. Enter your API key and keep the default base URL unless your account uses a different one.

## Send a fax

1. Open popup.
2. Enter From number and To number.
3. Attach a PDF file.
4. Optional: add a short cover message.
5. Click Send Fax.

## Notes

- API requests are made directly from the extension to api.medsender.com.
- API key is stored in Chrome sync storage for convenience.
- If your organization restricts key storage, move key handling to a secure backend and call that backend from the extension.

## API sandbox test script (Step 3 and 4)

Use the helper script to send a test fax and optionally trigger a test inbound fax event.

1. Export your real test API key from the Medsender portal:
	export MEDSENDER_API_KEY=sk_test_your_real_key
2. Generate a sample PDF (no extra tools required):
	bash scripts/generate_sample_pdf.sh /tmp/medsender-sample.pdf
3. Run Step 3 (send fax):
	bash scripts/test_fax_steps_3_4.sh /tmp/medsender-sample.pdf
4. Optional Step 4 (simulate inbound fax + webhook payload):
	RUN_INBOUND_TEST=true bash scripts/test_fax_steps_3_4.sh /tmp/medsender-sample.pdf

Single command for Step 3:

export MEDSENDER_API_KEY=sk_test_your_real_key && bash scripts/generate_sample_pdf.sh /tmp/medsender-sample.pdf && bash scripts/test_fax_steps_3_4.sh /tmp/medsender-sample.pdf

Defaults used by the script:

- from_number and inbound to_number: +14252074289
- to_number for send fax: +14252074289 (override with TO_NUMBER)
- inbound from_number: +12065550123 (override with INBOUND_FROM_NUMBER)