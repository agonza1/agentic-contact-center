# SignalWire PSTN to FreeSWITCH Runbook

This path connects the ClueCon PSTN number to the existing ACC SIP/Verto voice agent lane:

```text
PSTN caller -> SignalWire -> SIP trunk -> local FreeSWITCH -> acc-pipecat Verto bridge -> rtc-asr/ACC/Kokoro
```

Do not put live SignalWire values in Git, docs, issue comments, screenshots, or proof artifacts.

## Required local environment

Keep these values in a local `.env` or shell session. `.env` and `artifacts/` are gitignored.

```sh
export SIGNALWIRE_SPACE_URL="https://SPACE.signalwire.com"
export SIGNALWIRE_PROJECT_ID="PROJECT_ID_PLACEHOLDER"
export SIGNALWIRE_TOKEN="TOKEN_PLACEHOLDER"
export SIGNALWIRE_SIP_USERNAME="SIP_USERNAME_PLACEHOLDER"
export SIGNALWIRE_SIP_PASSWORD="SIP_PASSWORD_PLACEHOLDER"
export SIGNALWIRE_FROM_NUMBER="+12029687351"
export FREESWITCH_PUBLIC_SIP_HOST="PUBLIC_SIP_HOST_OR_TUNNEL_PLACEHOLDER"
```

Optional overrides:

```sh
export SIGNALWIRE_SIP_REALM="SPACE.sip.signalwire.com"
export SIGNALWIRE_SIP_PROXY="SPACE.sip.signalwire.com"
export SIGNALWIRE_TRUNK_MODE="registration"
```

When `SIGNALWIRE_SIP_REALM` and `SIGNALWIRE_SIP_PROXY` are omitted, the readiness script derives `SPACE.sip.signalwire.com` from `SIGNALWIRE_SPACE_URL=https://SPACE.signalwire.com`. Set `SIGNALWIRE_TRUNK_MODE=ip_auth` only for documented IP-auth trunking where SignalWire routes directly to `sip:8600@FREESWITCH_PUBLIC_SIP_HOST` and no FreeSWITCH gateway registration is expected.

## Generate FreeSWITCH config

The committed files under `freeswitch/templates/` are credential-free templates. Render the real gateway and public dialplan files into ignored artifacts:

```sh
npm run signalwire:freeswitch:readiness -- --render --skip-fs-cli
```

That render-only command should report `config_rendered_pending_freeswitch_cli`. It does not prove the trunk is reachable and does not open the manual-call gate.

Generated files:

- `artifacts/freeswitch-signalwire/conf/sip_profiles/external/signalwire.xml`
- `artifacts/freeswitch-signalwire/conf/dialplan/public/signalwire_inbound.xml`

Mount or copy those files into the active FreeSWITCH config:

```text
/etc/freeswitch/sip_profiles/external/signalwire.xml
/etc/freeswitch/dialplan/public/signalwire_inbound.xml
```

Then reload FreeSWITCH:

```sh
fs_cli -x 'reloadxml'
fs_cli -x 'sofia profile external restart reloadxml'
```

The inbound dialplan routes the configured DID, `8600`, or `acc` to the existing `acc-pipecat` Verto agent leg.

## SignalWire number routing

In SignalWire, configure inbound calls for `SIGNALWIRE_FROM_NUMBER` to reach the FreeSWITCH public SIP endpoint. Use either:

- SIP registration: route the number to the registered SIP endpoint/gateway for the configured SIP credentials. Leave `SIGNALWIRE_TRUNK_MODE=registration`; the readiness gate requires `sofia status gateway signalwire` to show `REGED`.
- IP-auth trunking: route to `sip:8600@FREESWITCH_PUBLIC_SIP_HOST`. Set `SIGNALWIRE_TRUNK_MODE=ip_auth`; the readiness gate checks the FreeSWITCH external profile without requiring a registered SignalWire gateway.

Changing firewall, NAT, router, or public tunnel exposure requires Alberto approval first. If the public SIP endpoint is not already available, stop and document the needed host, port, and transport instead of opening it.

## Verification before manual PSTN call

Start the accepted local voice path:

```sh
npm run docker:sip-verto
```

Run the SignalWire readiness probe:

```sh
npm run signalwire:freeswitch:readiness -- --render
```

Expected proof:

- `missingEnv` is empty.
- `status` is `ready_for_manual_pstn_call`.
- `manualCallReady` is `true`.
- For registration trunks, `freeswitchCli` includes redacted output for `sofia status profile external`, `sofia status gateway signalwire`, and `show registrations`.
- For IP-auth trunks, `freeswitchCli` includes redacted output for `sofia status profile external` and `show registrations`; `REGED` is not required because there is no outbound gateway registration.
- `artifacts/freeswitch-signalwire/readiness.json` contains no live tokens, SIP passwords, project IDs, or private host values.

If FreeSWITCH is down, the registration gateway is unregistered, the selected trunk mode is wrong, or the public SIP endpoint is unavailable, the probe exits non-zero with an actionable blocker. Do not ask for the live PSTN call until this is ready and QA has confirmed the ACC voice path is listening.

Manual call gate: ask Alberto to call `SIGNALWIRE_FROM_NUMBER` only after the readiness probe and local voice path are ready.
