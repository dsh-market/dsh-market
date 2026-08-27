# Public plugin update API v1

`dshmarket` exposes a small, versioned, same-origin JSON API for plugin-owned
update surfaces. It lets a plugin show its own update button without spawning a
package manager, copying the Market installation algorithm, or binding to the
Market UI's private response fields.

All responses carry:

```json
{ "schema": "dsh-market/update-api/v1" }
```

Clients must discover the API before enabling mutation controls:

```http
GET /dsh-market/api/v1/capabilities
```

The response names the Market version, profile, runtime (`web` or `desktop`),
supported features, restart owner and endpoint paths. A client must hide its
restart button when `restart.supported` is false. Desktop and supervised hosts
normally delegate restart to their owning shell or operator.

## Check one installed package

```http
GET /dsh-market/api/v1/updates?name=dsh-mcp-connector&force=1
```

The response includes the installed version, target version, source kind and
whether the target is a forward update. Omitting `force=1` allows the Market's
short update-check cache.

## Start and observe an update

Mutation requests require the same-origin protection used by the Market UI.

```http
POST /dsh-market/api/v1/updates
Content-Type: application/json

{ "packageName": "dsh-mcp-connector" }
```

An accepted request returns HTTP `202` immediately with an `operationId`.
Passing `"force": true` opts this one operation out of the registry release-age
wait; clients should offer it only after the normal operation reports
`RELEASE_TOO_FRESH` or `VERSION_UNCHANGED`.

Poll the operation by id:

```http
GET /dsh-market/api/v1/operations?operationId=<id>
```

States are `queued`, `running`, `succeeded`, `failed`, `cancelled` and
`rolled-back`. Running operations include structured package progress when
pnpm provides it. Terminal operations include:

- the before and actually installed versions;
- `refreshRequired` and `restartRequired` outcomes;
- a stable failure code, bounded user-facing message and retryability;
- whether a compatibility rollback is currently available.

Up to 50 operation records live in the current Host process. A boot id is
embedded in every operation id, so a client never mistakes a stale browser
record for a task belonging to the replacement process.

## Roll back

```http
POST /dsh-market/api/v1/rollback
Content-Type: application/json

{ "operationId": "<id>" }
```

Rollback is intentionally capability- and operation-scoped. It is available
only when the Market's compatibility verification retained a recovery point;
a later mutation may supersede it. The normalized result is written back to
the same operation record.

## Restart

```http
POST /dsh-market/api/v1/restart
Content-Type: application/json

{}
```

This preserves the Market's stricter restart guard: direct loopback,
same-origin, no forwarding headers, no package mutation in progress, and a Host
whose lifecycle is not owned by Desktop or a supervisor. Clients must feature
detect it; they must not invent an alternative process-control path.

## Compatibility policy

- New optional response fields may be added within v1.
- Existing v1 fields and meanings are not repurposed.
- A breaking change uses a new path and schema version.
- When discovery is unavailable, plugin UIs should fall back to opening the
  Market rather than calling legacy `/dsh-market/*` mutation routes directly.
