// ACC ToolHive/Cedar demo policy bundle.
// Static authorization lives here; dynamic approval state is validated by ACC
// before retention.apply_offer mutates state.

forbid (
  principal,
  action == Action::"retention.apply_offer",
  resource
)
when {
  principal.type == "voice_agent"
};

permit (
  principal,
  action == Action::"retention.lookup_options",
  resource
)
when {
  principal.type in ["voice_agent", "operator"]
};

permit (
  principal,
  action == Action::"operator.request_approval",
  resource
)
when {
  principal.type in ["voice_agent", "operator"]
  && context has call_id
  && context has offer_id
  && context has discount_percent
  && context has idempotency_key
  && context.discount_percent >= 0
  && context.discount_percent <= 10
};

permit (
  principal,
  action == Action::"retention.apply_offer",
  resource
)
when {
  principal.type == "operator"
  && context has call_id
  && context has offer_id
  && context has discount_percent
  && context has approval_id
  && context has idempotency_key
  && context.discount_percent >= 0
  && context.discount_percent <= 10
};
