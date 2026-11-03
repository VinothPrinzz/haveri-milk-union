// apps/api/src/routes/dtc-setup.ts
// ═══════════════════════════════════════════════════════════════════════
// DTC Billing → Setup
//
//   GET    /api/v1/dtc/lookups                      routes + contractors for pickers
//   GET    /api/v1/dtc/settings                     cost-per-litre basis, TDS, signatures
//   PUT    /api/v1/dtc/settings
//   GET    /api/v1/dtc/route-terms                  every route with its current terms
//   GET    /api/v1/dtc/route-terms/:routeId           one route: terms, history, recent bills
//   GET    /api/v1/dtc/route-terms/:routeId/history
//   POST   /api/v1/dtc/route-terms                  add / replace a version (route + date)
//   DELETE /api/v1/dtc/route-terms/:id
//   GET    /api/v1/dtc/crate-rates      POST  DELETE /:id
//   GET    /api/v1/dtc/charges          POST  PATCH /:id  DELETE /:id
//   GET    /api/v1/dtc/deposits         POST (upsert per contractor)  POST /:id/refund
//   GET    /api/v1/dtc/deposits/contractor/:contractorId   plan + every instalment taken
//
// Terms are versioned by effective date: a rate revision is a new row, so a
// bill already prepared keeps the rate it was made with. The version in force
// today is mirrored onto routes.rate_per_trip / total_km_per_day, which the
// Contractor screen still shows.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { isoDate, istToday } from "../lib/ist-date.js";
import { HttpError, loadDtcSettings, monthParam, requestAdmin, round2, type Sql } from "../lib/dtc.js";
import { dtcRoute, parseWith } from "../lib/dtc-http.js";

const uuidParam = z.object({ id: z.string().uuid() });
const money = z.number().min(0).max(1e9);
const optText = z.string().trim().max(500).optional().nullable().transform(v => (v ? v : null));
const optDate = isoDate.optional().nullable();

/** Mirror today's terms onto the route master (shown on the Contractor screen). */
async function syncRouteMaster(sql: Sql, routeId: string) {
  const [cur] = await sql`
    SELECT active, rate::float8 AS rate, km_per_day::float8 AS km_per_day
      FROM dtc_route_terms
     WHERE route_id = ${routeId}::uuid AND effective_from <= ${istToday()}::date
     ORDER BY effective_from DESC LIMIT 1
  ` as any[];
  if (!cur || !cur.active) return;
  await sql`
    UPDATE routes SET rate_per_trip = ${String(cur.rate)}::numeric,
                      total_km_per_day = ${String(cur.km_per_day)}::numeric, updated_at = now()
     WHERE id = ${routeId}::uuid
  `;
}

/** dtc_route_terms row (snake_case, numerics as text or number) → API shape. */
function mapTerms(t: any) {
  if (!t) return null;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const day = (v: unknown) => (v == null ? null : String(v).slice(0, 10));
  return {
    id: t.id, routeId: t.route_id, effectiveFrom: day(t.effective_from), active: t.active,
    billingType: t.billing_type, rate: num(t.rate) ?? 0, kmPerDay: num(t.km_per_day) ?? 0,
    vehicleCapacityMt: num(t.vehicle_capacity_mt), vehicleNumber: t.vehicle_number,
    agreementNo: t.agreement_no, contractStart: day(t.contract_start), contractEnd: day(t.contract_end),
    insulated: t.insulated, cashCollection: t.cash_collection, notes: t.notes, createdAt: t.created_at,
  };
}

export async function dtcSetupRoutes(app: FastifyInstance) {
  // ── Lookups ──
  dtcRoute(app, "get", "/api/v1/dtc/lookups", "dtc.view", async () => {
    const routes = await pgClient`
      SELECT r.id, r.code, r.name, r.contractor_id AS "contractorId", c.name AS "contractorName"
        FROM routes r
        LEFT JOIN contractors c ON c.id = r.contractor_id AND c.deleted_at IS NULL
       WHERE r.deleted_at IS NULL AND r.code <> 'DEMO'
       ORDER BY r.code
    `;
    const contractors = await pgClient`
      SELECT id, code, name, phone, active, bank_name AS "bankName", account_no AS "accountNo",
             ifsc_code AS "ifscCode", pan_number AS "panNumber"
        FROM contractors WHERE deleted_at IS NULL
       ORDER BY name
    `;
    return { routes, contractors };
  });

  // ── Settings ──
  dtcRoute(app, "get", "/api/v1/dtc/settings", "dtc.view", async () => loadDtcSettings(pgClient));

  dtcRoute(app, "put", "/api/v1/dtc/settings", "dtc.setup", async (request) => {
    const body = parseWith(z.object({
      costPerLitreBasis: z.enum(["total_earnings", "gross"]),
      tdsEnabled: z.boolean(),
      signatures: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    }), request.body);
    const { userId } = requestAdmin(request);
    const values: [string, string][] = [
      ["cost_per_litre_basis", body.costPerLitreBasis],
      ["tds_enabled", String(body.tdsEnabled)],
      ["signatures", JSON.stringify(body.signatures)],
    ];
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      for (const [key, value] of values) {
        await tx`
          INSERT INTO system_settings (category, key, value, updated_by)
          VALUES ('dtc', ${key}, ${value}, ${userId}::uuid)
          ON CONFLICT (category, key) DO UPDATE
            SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
        `;
      }
    });
    return { message: "DTC settings saved", ...(await loadDtcSettings(pgClient)) };
  });

  // ── Route terms ──
  dtcRoute(app, "get", "/api/v1/dtc/route-terms", "dtc.view", async () => {
    const today = istToday();
    const rows = await pgClient`
      SELECT r.id AS "routeId", r.code AS "routeCode", r.name AS "routeName",
             r.contractor_id AS "contractorId", c.name AS "contractorName",
             (SELECT count(*)::int FROM dtc_route_terms t WHERE t.route_id = r.id) AS "versionCount",
             (SELECT row_to_json(t) FROM dtc_route_terms t
               WHERE t.route_id = r.id AND t.effective_from <= ${today}::date
               ORDER BY t.effective_from DESC LIMIT 1) AS current,
             (SELECT row_to_json(t) FROM dtc_route_terms t
               WHERE t.route_id = r.id AND t.effective_from > ${today}::date
               ORDER BY t.effective_from ASC LIMIT 1) AS upcoming
        FROM routes r
        LEFT JOIN contractors c ON c.id = r.contractor_id AND c.deleted_at IS NULL
       WHERE r.deleted_at IS NULL AND r.code <> 'DEMO'
       ORDER BY r.code
    `;
    return {
      today,
      data: (rows as any[]).map(r => ({ ...r, current: mapTerms(r.current), upcoming: mapTerms(r.upcoming) })),
    };
  });

  dtcRoute(app, "get", "/api/v1/dtc/route-terms/:routeId/history", "dtc.view", async (request) => {
    const { routeId } = parseWith(z.object({ routeId: z.string().uuid() }), request.params);
    const rows = await pgClient`
      SELECT t.*, u.name AS "createdByName",
             EXISTS (SELECT 1 FROM dtc_bills b JOIN dtc_bill_runs br ON br.id = b.run_id
                      WHERE br.status <> 'draft'
                        AND b.segments @> jsonb_build_array(jsonb_build_object('termsId', t.id::text))) AS "usedInBills"
        FROM dtc_route_terms t
        LEFT JOIN users u ON u.id = t.created_by
       WHERE t.route_id = ${routeId}::uuid
       ORDER BY t.effective_from DESC
    `;
    return {
      data: (rows as any[]).map(r => ({ ...mapTerms(r), createdByName: r.createdByName, usedInBills: r.usedInBills })),
    };
  });

  // One route's billing record: the route, its terms (current / upcoming /
  // every version) and its last 12 bills.
  dtcRoute(app, "get", "/api/v1/dtc/route-terms/:routeId", "dtc.view", async (request) => {
    const { routeId } = parseWith(z.object({ routeId: z.string().uuid() }), request.params);
    const today = istToday();
    const [route] = await pgClient`
      SELECT r.id, r.code, r.name, r.contractor_id AS "contractorId", c.name AS "contractorName",
             c.phone AS "contractorPhone", c.vehicle_number AS "contractorVehicle"
        FROM routes r LEFT JOIN contractors c ON c.id = r.contractor_id AND c.deleted_at IS NULL
       WHERE r.id = ${routeId}::uuid AND r.deleted_at IS NULL
    ` as any[];
    if (!route) throw new HttpError(404, "Not found", "Route not found.");
    const versions = await pgClient`
      SELECT t.*, u.name AS "createdByName",
             EXISTS (SELECT 1 FROM dtc_bills b JOIN dtc_bill_runs br ON br.id = b.run_id
                      WHERE br.status <> 'draft'
                        AND b.segments @> jsonb_build_array(jsonb_build_object('termsId', t.id::text))) AS "usedInBills"
        FROM dtc_route_terms t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.route_id = ${routeId}::uuid
       ORDER BY t.effective_from DESC
    ` as any[];
    const history = versions.map(r => ({ ...mapTerms(r), createdByName: r.createdByName, usedInBills: r.usedInBills }));
    const bills = await pgClient`
      SELECT b.id, to_char(r.bill_month, 'YYYY-MM') AS month, r.status AS "runStatus", b.contractor_name AS "contractorName",
             b.billing_type AS "billingType", b.days, b.qty_litres::float8 AS qty, b.gross_amount::float8 AS gross,
             b.total_earnings::float8 AS "totalEarnings", b.total_deductions::float8 AS "totalDeductions",
             b.net_amount::float8 AS net, b.cost_per_litre::float8 AS "costPerLitre"
        FROM dtc_bills b JOIN dtc_bill_runs r ON r.id = b.run_id
       WHERE b.route_id = ${routeId}::uuid
       ORDER BY r.bill_month DESC LIMIT 12
    `;
    return {
      today, route,
      current: history.find(h => h.effectiveFrom! <= today) ?? null,
      upcoming: [...history].reverse().find(h => h.effectiveFrom! > today) ?? null,
      history, bills,
    };
  });

  dtcRoute(app, "post", "/api/v1/dtc/route-terms", "dtc.setup", async (request, reply) => {
    const body = parseWith(z.object({
      routeId: z.string().uuid(),
      effectiveFrom: isoDate,
      active: z.boolean().default(true),
      billingType: z.enum(["km", "trip", "litre"]),
      rate: money,
      kmPerDay: money.default(0),
      vehicleCapacityMt: z.number().min(0).max(100).optional().nullable(),
      vehicleNumber: optText,
      agreementNo: optText,
      contractStart: optDate,
      contractEnd: optDate,
      insulated: z.boolean().default(false),
      cashCollection: z.boolean().default(false),
      notes: optText,
    }), request.body);
    if (body.active) {
      if (!(body.rate > 0)) throw new HttpError(400, "Validation Error", "Enter the rate.");
      if (body.billingType === "km" && !(body.kmPerDay > 0)) {
        throw new HttpError(400, "Validation Error", "KM basis needs the km per day.");
      }
    }
    if (body.contractStart && body.contractEnd && body.contractEnd < body.contractStart) {
      throw new HttpError(400, "Validation Error", "Contract end is before contract start.");
    }
    const { userId } = requestAdmin(request);

    const row = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [route] = await tx`SELECT id FROM routes WHERE id = ${body.routeId}::uuid AND deleted_at IS NULL`;
      if (!route) throw new HttpError(404, "Not found", "Route not found.");
      // Replacing a version already used by a submitted / approved bill would
      // rewrite history; add a new version from a later date instead.
      const [used] = await tx`
        SELECT 1 FROM dtc_route_terms t
         WHERE t.route_id = ${body.routeId}::uuid AND t.effective_from = ${body.effectiveFrom}::date
           AND EXISTS (SELECT 1 FROM dtc_bills b JOIN dtc_bill_runs br ON br.id = b.run_id
                        WHERE br.status <> 'draft'
                          AND b.segments @> jsonb_build_array(jsonb_build_object('termsId', t.id::text)))
      `;
      if (used) {
        throw new HttpError(409, "Already billed",
          "Bills already sent for approval use the terms from this date. Add a new version from a later date instead.");
      }
      const [r] = await tx`
        INSERT INTO dtc_route_terms (
          route_id, effective_from, active, billing_type, rate, km_per_day, vehicle_capacity_mt,
          vehicle_number, agreement_no, contract_start, contract_end, insulated, cash_collection,
          notes, created_by
        ) VALUES (
          ${body.routeId}::uuid, ${body.effectiveFrom}::date, ${body.active}, ${body.billingType},
          ${String(body.rate)}::numeric, ${String(body.billingType === "km" ? body.kmPerDay : 0)}::numeric,
          ${body.vehicleCapacityMt ?? null}::numeric, ${body.vehicleNumber}, ${body.agreementNo},
          ${body.contractStart ?? null}::date, ${body.contractEnd ?? null}::date,
          ${body.insulated}, ${body.cashCollection}, ${body.notes}, ${userId}::uuid
        )
        ON CONFLICT (route_id, effective_from) DO UPDATE SET
          active = EXCLUDED.active, billing_type = EXCLUDED.billing_type, rate = EXCLUDED.rate,
          km_per_day = EXCLUDED.km_per_day, vehicle_capacity_mt = EXCLUDED.vehicle_capacity_mt,
          vehicle_number = EXCLUDED.vehicle_number, agreement_no = EXCLUDED.agreement_no,
          contract_start = EXCLUDED.contract_start, contract_end = EXCLUDED.contract_end,
          insulated = EXCLUDED.insulated, cash_collection = EXCLUDED.cash_collection,
          notes = EXCLUDED.notes, created_by = EXCLUDED.created_by, updated_at = now()
        RETURNING id
      `;
      await syncRouteMaster(tx, body.routeId);
      return r;
    });
    return reply.status(201).send({ message: "Route billing terms saved", id: (row as any).id });
  });

  dtcRoute(app, "delete", "/api/v1/dtc/route-terms/:id", "dtc.setup", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [t] = await tx`SELECT route_id FROM dtc_route_terms WHERE id = ${id}::uuid FOR UPDATE` as any[];
      if (!t) throw new HttpError(404, "Not found", "Terms version not found.");
      const [used] = await tx`
        SELECT 1 FROM dtc_bills b JOIN dtc_bill_runs br ON br.id = b.run_id
         WHERE br.status <> 'draft'
           AND b.segments @> jsonb_build_array(jsonb_build_object('termsId', ${id}::text))
         LIMIT 1
      `;
      if (used) throw new HttpError(409, "Already billed", "This version is used by bills already sent for approval.");
      await tx`DELETE FROM dtc_route_terms WHERE id = ${id}::uuid`;
      await syncRouteMaster(tx, t.route_id);
    });
    return { message: "Terms version deleted" };
  });

  // ── Crate rates ──
  dtcRoute(app, "get", "/api/v1/dtc/crate-rates", "dtc.view", async () => {
    const rows = await pgClient`
      SELECT cr.id, cr.effective_from::text AS "effectiveFrom", cr.rate::float8 AS rate, cr.notes,
             cr.created_at AS "createdAt", u.name AS "createdByName"
        FROM dtc_crate_rates cr LEFT JOIN users u ON u.id = cr.created_by
       ORDER BY cr.effective_from DESC
    `;
    return { today: istToday(), data: rows };
  });

  dtcRoute(app, "post", "/api/v1/dtc/crate-rates", "dtc.setup", async (request, reply) => {
    const body = parseWith(z.object({
      effectiveFrom: isoDate, rate: z.number().positive().max(100000), notes: optText,
    }), request.body);
    const { userId } = requestAdmin(request);
    await pgClient`
      INSERT INTO dtc_crate_rates (effective_from, rate, notes, created_by)
      VALUES (${body.effectiveFrom}::date, ${body.rate.toFixed(2)}::numeric, ${body.notes}, ${userId}::uuid)
      ON CONFLICT (effective_from) DO UPDATE SET rate = EXCLUDED.rate, notes = EXCLUDED.notes,
        created_by = EXCLUDED.created_by
    `;
    return reply.status(201).send({ message: "Crate rate saved" });
  });

  dtcRoute(app, "delete", "/api/v1/dtc/crate-rates/:id", "dtc.setup", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    await pgClient`DELETE FROM dtc_crate_rates WHERE id = ${id}::uuid`;
    return { message: "Crate rate deleted" };
  });

  // ── Recurring monthly charges (GPS rent, …) ──
  dtcRoute(app, "get", "/api/v1/dtc/charges", "dtc.view", async () => {
    const rows = await pgClient`
      SELECT ch.id, ch.route_id AS "routeId", r.code AS "routeCode", r.name AS "routeName",
             ch.head, ch.description, ch.monthly_amount::float8 AS "monthlyAmount",
             to_char(ch.from_month, 'YYYY-MM') AS "fromMonth", to_char(ch.to_month, 'YYYY-MM') AS "toMonth",
             ch.active, ch.created_at AS "createdAt",
             EXISTS (SELECT 1 FROM dtc_bill_lines l WHERE l.source_ref = ch.id) AS used
        FROM dtc_recurring_charges ch JOIN routes r ON r.id = ch.route_id
       ORDER BY ch.active DESC, r.code, ch.head
    `;
    return { data: rows };
  });

  const chargeSchema = z.object({
    routeId: z.string().uuid(),
    head: z.enum(["gps", "other_deduction"]),
    description: z.string().trim().min(2).max(200),
    monthlyAmount: z.number().positive().max(1e7),
    fromMonth: monthParam,
    toMonth: monthParam.optional().nullable(),
    active: z.boolean().default(true),
  }).refine(b => !b.toMonth || b.toMonth >= b.fromMonth, { message: "'To' month is before 'From' month" });

  dtcRoute(app, "post", "/api/v1/dtc/charges", "dtc.setup", async (request, reply) => {
    const body = parseWith(chargeSchema, request.body);
    const { userId } = requestAdmin(request);
    await pgClient`
      INSERT INTO dtc_recurring_charges (route_id, head, description, monthly_amount, from_month, to_month, active, created_by)
      VALUES (${body.routeId}::uuid, ${body.head}, ${body.description}, ${body.monthlyAmount.toFixed(2)}::numeric,
              ${body.fromMonth + "-01"}::date, ${body.toMonth ? body.toMonth + "-01" : null}::date,
              ${body.active}, ${userId}::uuid)
    `;
    return reply.status(201).send({ message: "Charge added" });
  });

  dtcRoute(app, "patch", "/api/v1/dtc/charges/:id", "dtc.setup", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(chargeSchema, request.body);
    const [r] = await pgClient`
      UPDATE dtc_recurring_charges SET
        route_id = ${body.routeId}::uuid, head = ${body.head}, description = ${body.description},
        monthly_amount = ${body.monthlyAmount.toFixed(2)}::numeric,
        from_month = ${body.fromMonth + "-01"}::date, to_month = ${body.toMonth ? body.toMonth + "-01" : null}::date,
        active = ${body.active}, updated_at = now()
      WHERE id = ${id}::uuid RETURNING id
    `;
    if (!r) throw new HttpError(404, "Not found", "Charge not found.");
    return { message: "Charge updated" };
  });

  dtcRoute(app, "delete", "/api/v1/dtc/charges/:id", "dtc.setup", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const [used] = await pgClient`SELECT 1 FROM dtc_bill_lines WHERE source_ref = ${id}::uuid LIMIT 1`;
    if (used) throw new HttpError(409, "In use", "This charge is on bills already. Switch it off instead of deleting it.");
    await pgClient`DELETE FROM dtc_recurring_charges WHERE id = ${id}::uuid`;
    return { message: "Charge deleted" };
  });

  // ── Security deposits ──
  dtcRoute(app, "get", "/api/v1/dtc/deposits", "dtc.view", async () => {
    const rows = await pgClient`
      SELECT d.id, d.contractor_id AS "contractorId", c.code AS "contractorCode", c.name AS "contractorName",
             d.target_amount::float8 AS "targetAmount", d.monthly_instalment::float8 AS "monthlyInstalment",
             d.opening_collected::float8 AS "openingCollected", d.status,
             d.refunded_amount::float8 AS "refundedAmount", d.refunded_on::text AS "refundedOn",
             d.refund_reference AS "refundReference", d.notes,
             COALESCE((SELECT SUM(l.amount) FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id
                        JOIN dtc_bill_runs r ON r.id = b.run_id
                       WHERE l.head = 'security_deposit' AND b.contractor_id = d.contractor_id
                         AND r.status = 'approved'), 0)::float8 AS "collectedApproved",
             COALESCE((SELECT SUM(l.amount) FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id
                        JOIN dtc_bill_runs r ON r.id = b.run_id
                       WHERE l.head = 'security_deposit' AND b.contractor_id = d.contractor_id
                         AND r.status <> 'approved'), 0)::float8 AS "collectedPending"
        FROM dtc_security_deposits d JOIN contractors c ON c.id = d.contractor_id
       ORDER BY d.status, c.name
    `;
    return {
      data: (rows as any[]).map(r => {
        const collected = round2(r.openingCollected + r.collectedApproved);
        return { ...r, collected, balanceDue: round2(Math.max(0, r.targetAmount - collected)) };
      }),
    };
  });

  // One contractor's deposit: the plan (or null) and every instalment taken.
  dtcRoute(app, "get", "/api/v1/dtc/deposits/contractor/:contractorId", "dtc.view", async (request) => {
    const { contractorId } = parseWith(z.object({ contractorId: z.string().uuid() }), request.params);
    const [contractor] = await pgClient`
      SELECT id, code, name, phone FROM contractors WHERE id = ${contractorId}::uuid
    ` as any[];
    if (!contractor) throw new HttpError(404, "Not found", "Contractor not found.");
    const [plan] = await pgClient`
      SELECT id, target_amount::float8 AS "targetAmount", monthly_instalment::float8 AS "monthlyInstalment",
             opening_collected::float8 AS "openingCollected", status, refunded_amount::float8 AS "refundedAmount",
             refunded_on::text AS "refundedOn", refund_reference AS "refundReference", notes,
             created_at AS "createdAt", updated_at AS "updatedAt"
        FROM dtc_security_deposits WHERE contractor_id = ${contractorId}::uuid
    ` as any[];
    const collections = await pgClient`
      SELECT l.id, to_char(r.bill_month, 'YYYY-MM') AS month, r.status AS "runStatus",
             b.route_code AS "routeCode", b.route_name AS "routeName", l.amount::float8 AS amount,
             l.source, l.remarks
        FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id JOIN dtc_bill_runs r ON r.id = b.run_id
       WHERE l.head = 'security_deposit' AND b.contractor_id = ${contractorId}::uuid
       ORDER BY r.bill_month DESC
    ` as any[];
    const approved = round2(collections.filter(c => c.runStatus === "approved").reduce((s, c) => s + c.amount, 0));
    const pending = round2(collections.filter(c => c.runStatus !== "approved").reduce((s, c) => s + c.amount, 0));
    const collected = round2((plan?.openingCollected ?? 0) + approved);
    return {
      contractor, plan: plan ?? null, collections,
      collected, collectedPending: pending,
      balanceDue: plan ? round2(Math.max(0, plan.targetAmount - collected)) : 0,
    };
  });

  dtcRoute(app, "post", "/api/v1/dtc/deposits", "dtc.setup", async (request, reply) => {
    const body = parseWith(z.object({
      contractorId: z.string().uuid(),
      targetAmount: z.number().positive().max(1e9),
      monthlyInstalment: z.number().positive().max(1e9),
      openingCollected: money.default(0),
      status: z.enum(["active", "paused", "closed"]).default("active"),
      notes: optText,
    }), request.body);
    const { userId } = requestAdmin(request);
    await pgClient`
      INSERT INTO dtc_security_deposits (contractor_id, target_amount, monthly_instalment, opening_collected, status, notes, created_by)
      VALUES (${body.contractorId}::uuid, ${body.targetAmount.toFixed(2)}::numeric, ${body.monthlyInstalment.toFixed(2)}::numeric,
              ${body.openingCollected.toFixed(2)}::numeric, ${body.status}, ${body.notes}, ${userId}::uuid)
      ON CONFLICT (contractor_id) DO UPDATE SET
        target_amount = EXCLUDED.target_amount, monthly_instalment = EXCLUDED.monthly_instalment,
        opening_collected = EXCLUDED.opening_collected, status = EXCLUDED.status, notes = EXCLUDED.notes,
        updated_at = now()
    `;
    return reply.status(201).send({ message: "Security deposit plan saved" });
  });

  dtcRoute(app, "post", "/api/v1/dtc/deposits/:id/refund", "dtc.pay", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(z.object({
      amount: z.number().positive().max(1e9), refundedOn: isoDate, reference: optText,
    }), request.body);
    const [r] = await pgClient`
      UPDATE dtc_security_deposits SET
        refunded_amount = ${body.amount.toFixed(2)}::numeric, refunded_on = ${body.refundedOn}::date,
        refund_reference = ${body.reference}, status = 'closed', updated_at = now()
      WHERE id = ${id}::uuid RETURNING id
    `;
    if (!r) throw new HttpError(404, "Not found", "Deposit plan not found.");
    return { message: "Refund recorded and plan closed" };
  });
}
