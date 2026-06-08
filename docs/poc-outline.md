# POC Outline

## Goal

Prove that a contact-center cancellation flow is safer and more steerable when the realtime loop is explicitly owned instead of delegated to a black-box voice agent.

## First implementation slice

1. Accept a mocked inbound call event.
2. Progress through the scripted caller turns.
3. Stop at the offer boundary for policy review.
4. Request operator steer.
5. Resume with approved guidance or fail closed.
6. Persist the transcript, event trail, and latency markers.

## Minimum evidence to capture

- call identifier and scenario name
- ordered transcript turns
- flow-state transitions
- operator steer decision
- fallback reason when triggered
- latency timing per critical stage

## Non-goals for the first slice

- real PSTN connectivity
- live billing or CRM tools
- production authentication and multitenancy
- generalized workflow building
