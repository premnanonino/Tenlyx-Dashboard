import pg from 'pg';

/**
 * Read-only access to CourseRev's production `conversations` table (the
 * call history), for the Call History page.
 *
 * Production safety:
 *   - every session is forced read-only (default_transaction_read_only),
 *     on top of the database user being read-only;
 *   - 5 s statement timeout and at most `max` connections;
 *   - only indexed access paths: (created_at, id) ranges for the list sync,
 *     call_id (unique) for one call's detail.
 *
 * The list query returns a slim row (no transcript, messages, booking_data
 * or recordings); those heavy fields are fetched one call at a time.
 */
const LIST_SQL = `
  SELECT c.id, c.call_id, c.created_at, c.updated_at,
         c.customer_name, c.customer_email, c.customer_phone_no, c.vapi_golf_course_phone_no,
         c.call_length, c.hasbooking, c.booking_id, c.call_outcome, c.end_call_reason, c.cost, c.config_level,
         c.golf_course_id, gc.golf_course_name,
         COALESCE(c.organization_id, gc.organization_id) AS org_id, o.org_name, o.org_type,
         b.booking_number, b.status AS booking_status, b.created_at AS booking_created_at, b.tee_time_date::text AS tee_time_date
    FROM conversations c
    LEFT JOIN golf_courses gc ON gc.id = c.golf_course_id
    LEFT JOIN organizations o ON o.id = COALESCE(c.organization_id, gc.organization_id)
    LEFT JOIN bookings b ON b.id = c.booking_id
   WHERE c.created_at >= $1 AND c.created_at < $2 AND (c.created_at, c.id) > ($3, $4)
   ORDER BY c.created_at, c.id
   LIMIT $5`;

const DETAIL_SQL = `
  SELECT c.call_id, c.summary, c.transcript, c.translated_transcript, c.messages,
         c.recordingurl, c.stereorecordingurl, c.cost_breakdown, c.booking_data
    FROM conversations c
   WHERE c.call_id = $1`;

const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Production row → the slim call record stored by the dashboard (stable key order). */
export function toCall(r) {
  return {
    id: Number(r.id),
    callId: r.call_id,
    ts: ms(r.created_at),
    updatedAt: ms(r.updated_at),
    name: r.customer_name || null,
    email: r.customer_email || null,
    phone: r.customer_phone_no || null,
    coursePhone: r.vapi_golf_course_phone_no || null,
    durationSec: numOrNull(r.call_length),
    booked: !!(r.hasbooking || r.booking_id),
    bookingId: r.booking_id === null || r.booking_id === undefined ? null : Number(r.booking_id),
    bookingNumber: r.booking_number || null,
    bookingStatus: r.booking_status || null,
    bookedAt: ms(r.booking_created_at),
    teeDate: r.tee_time_date || null,
    outcome: r.call_outcome || null,
    endReason: r.end_call_reason || null,
    cost: numOrNull(r.cost),
    level: r.config_level || null,
    courseId: r.golf_course_id === null || r.golf_course_id === undefined ? null : Number(r.golf_course_id),
    course: r.golf_course_name || null,
    orgId: r.org_id === null || r.org_id === undefined ? null : Number(r.org_id),
    org: r.org_name || null,
    orgType: r.org_type || null,
  };
}

export class CourserevCalls {
  constructor({ url, max = 2, logger }) {
    this.logger = logger;
    this.pool = new pg.Pool({
      connectionString: url,
      max,
      idleTimeoutMillis: 10 * 60_000, // keep a warm connection: a new one through the tunnel costs ~2 s
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 5_000,
      application_name: `tlxmon-calls-${process.env.APP_ROLE || 'all'}`,
      options: '-c default_transaction_read_only=on',
    });
    this.pool.on('error', (err) => logger?.warn('courserev pool error', { err: err.message }));
    this.metrics = { queries: 0, rows: 0, failures: 0, lastError: null };
  }

  async #query(sql, args) {
    this.metrics.queries++;
    try {
      const res = await this.pool.query(sql, args);
      this.metrics.rows += res.rowCount;
      return res.rows;
    } catch (err) {
      this.metrics.failures++;
      this.metrics.lastError = err.message;
      throw err;
    }
  }

  /** One page of calls created in [from, to), after the (ts, id) keyset cursor, oldest first. */
  async page({ from, to, afterTs = null, afterId = 0, limit = 1_000 }) {
    const rows = await this.#query(LIST_SQL, [new Date(from), new Date(to), new Date(afterTs ?? from - 1), afterId, limit]);
    return rows.map(toCall);
  }

  /** Heavy fields of one call (transcript, messages, recordings, booking data). */
  async detail(callId) {
    const [r] = await this.#query(DETAIL_SQL, [callId]);
    if (!r) return null;
    return {
      callId: r.call_id,
      summary: r.summary,
      transcript: r.transcript,
      translatedTranscript: r.translated_transcript,
      messages: r.messages,
      recordingUrl: r.recordingurl,
      stereoRecordingUrl: r.stereorecordingurl,
      costBreakdown: r.cost_breakdown,
      bookingData: r.booking_data,
    };
  }

  close() { return this.pool.end(); }
}
