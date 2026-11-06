/**
 * Anti-corruption layer: turn whatever shape the upstream API returns
 * into the one internal record shape the rest of the system relies on.
 *
 * BillingRecord {
 *   id, ts, product, direction, destination, country,
 *   billingGroupId, units, unitLabel, rate, cost, currency, status
 * }
 */
const PRODUCT_ALIASES = {
  messaging: 'messaging',
  message: 'messaging', // /detail_records?filter[record_type]=messaging returns record_type "message"
  message_detail_record: 'messaging',
  'call-control': 'voice',
  call_control: 'voice',
  voice: 'voice',
  'sip-trunking': 'sip',
  sip_trunking: 'sip',
  verification: 'verify',
  verify: 'verify',
  numbers: 'numbers',
  'ai-voice-assistant': 'ai',
  ai_voice_assistant: 'ai',
  'ai-assistant': 'ai',
  'conversational-ai': 'ai',
  inference: 'ai',
  ai: 'ai',
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function normalizeProduct(type) {
  return PRODUCT_ALIASES[String(type).toLowerCase()] || String(type).toLowerCase();
}

export function normalizeTelnyxRecord(raw, recordType) {
  const ts = Date.parse(raw.created_at || raw.started_at || raw.sent_at || raw.completed_at || raw.updated_at || '');
  if (!Number.isFinite(ts)) return null;

  const product = normalizeProduct(raw.record_type && raw.record_type !== 'detail_record' ? raw.record_type : recordType);
  // Messaging carrier pass-through fees are billed on top of `cost`.
  const cost = toNum(raw.cost ?? raw.total_cost ?? raw.amount) + toNum(raw.carrier_fee) + toNum(raw.ai_opt_out_classification_fee);
  const destination = raw.cld ?? raw.to ?? raw.destination_number ?? raw.called_number ?? '';
  const isVoice = product === 'voice' || product === 'sip';
  const seconds = toNum(raw.billed_sec ?? raw.call_sec ?? raw.duration_sec);
  const units = isVoice || (product === 'ai' && seconds > 0) ? seconds / 60 : toNum(raw.parts ?? raw.units ?? 1) || 1;
  const status = raw.status ?? (raw.completed === 0 || raw.connected === 0 ? 'failed' : 'completed');
  // AI records carry no `id`; a call-control leg and its sip-trunking twin share one,
  // but bill separately — so the product namespaces the key.
  const upstreamId = raw.id ?? raw.uuid ?? raw.conversation_id ?? raw.call_control_id ?? raw.telnyx_leg_id;

  const rec = {
    id: `${product}:${upstreamId ?? `${ts}-${destination}`}`,
    ts,
    product,
    direction: String(raw.direction || 'outbound').toLowerCase(),
    destination: String(destination),
    country: country(raw),
    billingGroupId: raw.billing_group_id || raw.billing_group || null,
    units: Math.round(units * 100) / 100,
    unitLabel: isVoice ? 'min' : product === 'messaging' ? 'seg' : 'req',
    rate: toNum(raw.rate),
    cost: Math.round(cost * 1e6) / 1e6,
    currency: String(raw.currency || 'USD').toUpperCase(),
    status: String(status).toLowerCase(),
  };

  if (product === 'ai') {
    // Field names differ across Telnyx AI record types; read defensively.
    const outcome = String(raw.outcome ?? raw.resolution ?? raw.end_reason ?? '').toLowerCase();
    const latency = Number(raw.latency_ms ?? raw.avg_latency_ms ?? raw.response_latency_ms);
    rec.ai = {
      model: String(raw.model ?? raw.llm_model ?? raw.model_name ?? raw.ai_model ?? 'unknown'),
      assistantId: raw.assistant_id ?? raw.ai_assistant_id ?? null,
      channel: String(raw.channel ?? (seconds > 0 ? 'voice' : 'chat')).toLowerCase(),
      turns: toNum(raw.turns ?? raw.message_count ?? raw.num_messages),
      tokensIn: toNum(raw.input_tokens ?? raw.prompt_tokens),
      tokensOut: toNum(raw.output_tokens ?? raw.completion_tokens),
      latencyMs: Number.isFinite(latency) && latency > 0 ? latency : null,
      outcome: ['resolved', 'transferred', 'abandoned'].includes(outcome) ? outcome : null,
      durationSec: seconds,
    };
    rec.unitLabel = seconds > 0 ? 'min' : 'turn';
  }
  return rec;
}

/** ISO code when present; voice legs only give a numeric dial code (1 → "+1"). */
function country(raw) {
  const iso = raw.country_iso ?? raw.destination_country ?? raw.country;
  if (iso) return String(iso).toUpperCase();
  const cc = raw.country_code;
  if (cc === undefined || cc === null || cc === '') return '??';
  return /^\d+$/.test(String(cc)) ? `+${cc}` : String(cc).toUpperCase();
}

export function normalizeBalance(data) {
  return {
    balance: toNum(data.balance),
    creditLimit: toNum(data.credit_limit),
    availableCredit: toNum(data.available_credit),
    pending: toNum(data.pending),
    currency: String(data.currency || 'USD').toUpperCase(),
    ts: Date.now(),
  };
}
