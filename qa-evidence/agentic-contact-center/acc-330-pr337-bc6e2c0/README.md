# ACC #330 PR #337 exact-head QA evidence

This package is a QA-visible copy of the passing live SIP/Verto proof captured at PR head `bc6e2c00de0c0714de8df83b159593ae0bb8d6c5` for Workboard card `460f5326-5347-4eaa-9d49-b526f97324a2`.

The raw FreeSWITCH log contained generated runtime passwords/tokens, so this package includes the call-scoped redacted linkage log plus structured linkage evidence instead of the full raw log.

Run from the repository checkout at `bc6e2c0`:

```bash
npm run proof:live-sip-bundle -- --live-manifest /Users/alberto/.openclaw/workspace/qa-evidence/agentic-contact-center/acc-330-pr337-bc6e2c0/source/verto-sip-live-proof-manifest.json --out-dir /Users/alberto/.openclaw/workspace/qa-evidence/agentic-contact-center/acc-330-pr337-bc6e2c0/strict-bundle --require-rtc-asr-live --require-caller-playback --require-review-ready
```

Expected result: `reviewReady=true`, `reviewGatePassed=true`, and `failedChecks=[]`.
