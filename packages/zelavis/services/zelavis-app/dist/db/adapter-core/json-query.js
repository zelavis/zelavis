const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function quoteJsonPath(path) {
    // Accept both `foo.bar` and `$.foo.bar`.
    const trimmed = path.replace(/^\$\.?/, "").trim();
    if (!trimmed) {
        return "$";
    }
    const parts = trimmed.split(".");
    for (const part of parts) {
        if (!PATH_SEGMENT.test(part)) {
            throw new Error(`Invalid JSON path segment "${part}" in "${path}". ` +
                "Segments must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
        }
    }
    return `$.${parts.join(".")}`;
}
function jsonExtract(path) {
    return `json_extract(data_json, '${quoteJsonPath(path)}')`;
}
const COMPARISON_OPERATORS = {
    eq: "=",
    ne: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
};
function normalizeBindValue(value) {
    // SQLite has no native boolean — store as 1/0 to match `json_extract` output.
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (value === null) {
        return null;
    }
    if (typeof value === "number" || typeof value === "string") {
        return value;
    }
    // Arrays/objects fall back to JSON text comparison; this matches the
    // previous in-memory `compareValues` behavior which sorted by JSON text.
    return JSON.stringify(value);
}
export function buildDocumentQueryFragment(where, orderBy) {
    const clauses = [];
    const params = [];
    for (const filter of where) {
        const op = filter.op ?? "eq";
        const extract = jsonExtract(filter.path);
        if (op === "in") {
            if (!Array.isArray(filter.value) || filter.value.length === 0) {
                // An empty `in` set never matches; force a false clause.
                clauses.push("1 = 0");
                continue;
            }
            const placeholders = filter.value.map(() => "?").join(", ");
            clauses.push(`${extract} IN (${placeholders})`);
            for (const value of filter.value) {
                params.push(normalizeBindValue(value));
            }
            continue;
        }
        if (Array.isArray(filter.value)) {
            // Comparison operators against an array never matched in the legacy
            // in-memory path — preserve that semantics here.
            clauses.push("1 = 0");
            continue;
        }
        const sqlOp = COMPARISON_OPERATORS[op];
        if (!sqlOp) {
            throw new Error(`Unsupported filter operator: ${op}`);
        }
        clauses.push(`${extract} ${sqlOp} ?`);
        params.push(normalizeBindValue(filter.value));
    }
    const whereSql = clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
    let orderSql = "";
    if (orderBy.length > 0) {
        const orderClauses = orderBy.map((order) => {
            const direction = (order.direction ?? "asc").toUpperCase();
            return `${jsonExtract(order.path)} ${direction === "DESC" ? "DESC" : "ASC"}`;
        });
        orderSql = ` ORDER BY ${orderClauses.join(", ")}`;
    }
    return { whereSql, whereParams: params, orderSql };
}
