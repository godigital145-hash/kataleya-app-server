import { Hono, type Context } from "hono";
import type { Env, Variables } from "../types";
import { buildModels, isSyncableTable } from "../models";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function bad(c: Ctx, msg: string, code = 400) {
    return c.json({ error: msg }, code as any);
}

function genId(prefix = "srv"): string {
    return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function nowISO(): string {
    return new Date().toISOString();
}

// D1 ne sait binder que des scalaires (string/number/null/ArrayBuffer).
// Les clients envoient des champs comme technicienIds: [] (vrai tableau JS).
// On sérialise donc tout tableau/objet en JSON string avant écriture,
// et on supprime les undefined (non bindables non plus).
function normalizeForD1(
    body: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (value !== null && typeof value === "object") {
            out[key] = JSON.stringify(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

async function logJournal(
    c: Ctx,
    operation: "create" | "update" | "delete",
    table_name: string,
    id_element: string,
    data: unknown | null,
): Promise<string> {
    const { SyncJournal } = buildModels(c.env.DB);
    const id = genId();
    const clientId = c.req.header("X-Client-ID") || "unknown";
    const userId = c.get("userId") || "unknown";
    await SyncJournal.create({
        id,
        operation,
        id_element,
        table_name,
        timestamp: nowISO(),
        client_id: clientId,
        user_id: userId,
        data: data ? JSON.stringify(data) : null,
    });
    return id;
}

// ─── GET /journal?since=<ISO> ────────────────────────────────────────
app.get("/journal", async (c) => {
    const since = c.req.query("since") || "";
    const clientId = c.req.header("X-Client-ID") || "";
    const { orm } = buildModels(c.env.DB);

    const sql = since
        ? `SELECT id, operation, id_element, table_name, timestamp, client_id FROM sync_journal
           WHERE timestamp > ? AND client_id != ? ORDER BY timestamp ASC LIMIT 1000`
        : `SELECT id, operation, id_element, table_name, timestamp, client_id FROM sync_journal
           WHERE client_id != ? ORDER BY timestamp ASC LIMIT 1000`;
    const params = since ? [since, clientId] : [clientId];

    const rows = await orm.query<any>(sql, params);
    return c.json({
        journal: rows.map((r) => ({
            id: r.id,
            operation: r.operation,
            id_element: r.id_element,
            table_name: r.table_name,
            timestamp: r.timestamp,
        })),
        serverTime: nowISO(),
    });
});

// ─── GET /api/sync/:table/:id ────────────────────────────────────────
app.get("/api/sync/:table/:id", async (c) => {
    const table = c.req.param("table");
    const id = c.req.param("id");
    if (!isSyncableTable(table)) return bad(c, "table inconnue", 404);
    const models = buildModels(c.env.DB) as any;
    const row = await models[table].findById(id);
    if (!row) return bad(c, "introuvable", 404);
    return c.json(row);
});

// ─── POST /:table  (create-or-update) ────────────────────────────────
// Idempotent : si la ligne existe déjà, on patche les colonnes présentes
// dans le body ; sinon on insère.
app.post("/:table", async (c) => {
    const table = c.req.param("table");
    if (!isSyncableTable(table)) return bad(c, "table inconnue", 404);
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || !body.id) return bad(c, "id requis");

    const models = buildModels(c.env.DB) as any;
    const id = String(body.id);
    const normalized = normalizeForD1(body);
    const existing = await models[table].findById(id).catch(() => null);
    try {
        if (existing) {
            const { id: _ignore, ...patch } = normalized;
            await models[table].update(id, patch);
        } else {
            await models[table].upsert({ ...normalized, id });
        }
    } catch (e) {
        console.error(`[sync] POST /${table} échec écriture`, id, errMsg(e));
        return bad(c, `écriture impossible: ${errMsg(e)}`, 422);
    }
    const journalId = await logJournal(c, "create", table, id, body);
    return c.json({ ok: true, journalId });
});

// ─── PUT /:table/:id  (update) ───────────────────────────────────────
// PATCH différentiel : ne modifie QUE les colonnes présentes dans le body.
// Si la ligne n'existe pas encore côté serveur, on upsert avec ce qu'on a
// (le client devrait avoir envoyé le CREATE avant, mais on tolère).
app.put("/:table/:id", async (c) => {
    const table = c.req.param("table");
    const id = c.req.param("id");
    if (!isSyncableTable(table)) return bad(c, "table inconnue", 404);
    const body = await c.req.json<Record<string, unknown>>();
    if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
        return bad(c, "body vide", 422);
    }

    const models = buildModels(c.env.DB) as any;
    const normalized = normalizeForD1(body);
    const existing = await models[table].findById(id).catch(() => null);
    try {
        if (existing) {
            const { id: _ignore, ...patch } = normalized;
            await models[table].update(id, patch);
        } else {
            // PUT idempotent : si la ligne n'existe pas, on l'insère. Si le
            // body est un patch partiel (colonnes NOT NULL manquantes),
            // l'upsert échouera → 422 explicite plutôt qu'un 500 opaque.
            await models[table].upsert({ ...normalized, id });
        }
    } catch (e) {
        console.error(`[sync] PUT /${table}/${id} échec écriture`, errMsg(e), body);
        return bad(c, `écriture impossible: ${errMsg(e)}`, 422);
    }
    const journalId = await logJournal(c, "update", table, id, body);
    return c.json({ ok: true, journalId });
});

// ─── DELETE /:table/:id ──────────────────────────────────────────────
// Idempotent : si la ligne n'existe pas, on swallow l'erreur et on journalise
// quand même pour que les autres clients voient la suppression.
app.delete("/:table/:id", async (c) => {
    const table = c.req.param("table");
    const id = c.req.param("id");
    if (!isSyncableTable(table)) return bad(c, "table inconnue", 404);
    const models = buildModels(c.env.DB) as any;
    await models[table].deleteById(id).catch(() => undefined);
    const journalId = await logJournal(c, "delete", table, id, null);
    return c.json({ ok: true, journalId });
});

// ─── SSE /api/sync/events ────────────────────────────────────────────
// Polling-based stream: vérifie le journal toutes les 3s pendant 25s,
// l'EventSource côté client se reconnectera automatiquement.
app.get("/api/sync/events", async (c) => {
    const clientId = c.req.header("X-Client-ID") || c.req.query("clientId") || "";
    const { orm } = buildModels(c.env.DB);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            let lastTs = nowISO();
            const send = (payload: unknown) => {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
                );
            };
            send({ type: "hello", serverTime: lastTs });

            const start = Date.now();
            while (Date.now() - start < 25_000) {
                await new Promise((r) => setTimeout(r, 3000));
                try {
                    const rows = await orm.query<any>(
                        `SELECT id, operation, id_element, table_name, timestamp, client_id
                         FROM sync_journal
                         WHERE timestamp > ? AND client_id != ?
                         ORDER BY timestamp ASC LIMIT 100`,
                        [lastTs, clientId],
                    );
                    for (const r of rows) {
                        send({
                            type: "journal_update",
                            clientId: r.client_id,
                            entry: {
                                id: r.id,
                                operation: r.operation,
                                id_element: r.id_element,
                                table_name: r.table_name,
                                timestamp: r.timestamp,
                            },
                        });
                        lastTs = r.timestamp;
                    }
                } catch {
                    /* swallow */
                }
            }
            controller.close();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
});

export default app;