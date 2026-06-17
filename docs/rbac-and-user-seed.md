# User Logins & Role-Based Access (RBAC) Audit

This documents the staff login seed and the result of auditing the backend
RBAC against the union's actual operational roles.

## 1. Staff logins (seed)

Run:

```bash
pnpm --filter @hmu/db seed:users
```

Default password for every account: **`password123`** (override with the
`SEED_USER_PASSWORD` env var). Ask each user to change it after first login.
Logins use **username + password** (see `auth.ts` → `/auth/admin/login`).

| # | Name | Username | System role | Business group |
|---|------|----------|-------------|----------------|
| 1 | Prashant | `prashant` | `manager` | Manager |
| 2 | Ramya | `ramya` | `manager` | Manager |
| 3 | Indent Operator 1 | `indent1` | `call_desk` | Indent |
| 4 | Indent Operator 2 | `indent2` | `call_desk` | Indent |
| 5 | Indent Operator 3 | `indent3` | `call_desk` | Indent |
| 6 | SKA Dairy (FGS) | `fgs_ska` | `dispatch_officer` | FGS |
| 7 | Other Products (FGS) | `fgs_others` | `dispatch_officer` | FGS |
| 8–13 | Route Officer 1–6 | `route1`…`route6` | `officer` | Route officer |
| 14 | Finance Officer 1 | `finance1` | `accountant` | Finance |
| 15 | Finance Officer 2 | `finance2` | `accountant` | Finance |

The seed is idempotent (upsert on username).

## 2. Role → business mapping

The `user_role` enum (`packages/db/src/schema/enums.ts`) maps 1:1 onto the
business groups:

| Business group | System role | Core permissions |
|---|---|---|
| Manager | `manager` | orders, dealers (master), distribution, routes, batches, price chart |
| Indent | `call_desk` | record/edit indents, create orders, view dealers, wallet top-ups |
| FGS | `dispatch_officer` | inventory (stock entry/update), dispatch, batches, route sheets |
| Route officer | `officer` | gate pass, **route sheets**, **dispatch sheets**, direct sales, cash customers, create orders |
| Finance | `accountant` | finance view + manage, **credit limits**, reports |

> The two FGS accounts (SKA Dairy / Other Products) share the same role —
> the product-line split is operational, not a permission difference.

## 3. Issues found & fixed

### 3a. Credit limit is now finance-only ✅ (your explicit requirement)

**Before:** the masters dealer create/PATCH endpoints silently dropped the
`creditLimit` field (it was never persisted), and the Finance → Credit Control
page was read-only. So credit limits were editable by *no one*.

**After:**
- New finance-gated endpoint `PATCH /api/v1/finance/credit-control/:dealerId/limit`
  (`requireRole("finance.manage")` → accountant / super_admin only).
- **New dedicated page: Finance → Credit Limits** (`/finance/credit-limits`) —
  lists dealers with outstanding / available / limit and an inline ✏️ editor on
  the Credit Limit column. Edit affordance is shown only to finance roles; the
  backend enforces `finance.manage` regardless of UI.
- The Masters customer form (both the new/edit form in `CustomersPage` and the
  shared `CustomerForm` component) **no longer has a Credit Limit field at all** —
  it was removed from the form, the zod schema, and the create/update payloads.
  The customer detail view still *displays* the limit read-only.

Files: `apps/api/src/routes/finance-credit-control.ts`,
`apps/web/src/services/api.ts`, `apps/web/src/pages/finance/CreditLimitsPage.tsx` (new),
`apps/web/src/App.tsx`, `apps/web/src/components/AppSidebar.tsx`,
`apps/web/src/pages/masters/CustomersPage.tsx`,
`apps/web/src/components/customers/CustomerForm.tsx`,
`apps/web/src/lib/validations.ts`.

### 3b. User-creation endpoint rejected `officer` / `viewer` ✅

`POST/PATCH /api/v1/users` (`system.ts`) restricted the role enum to 5 roles,
so the 6 route officers (`officer`) could not be created through the admin UI at
all. Added `officer` and `viewer` to both zod enums.

### 3c. Route officers can now run route sheets & dispatch sheets ✅

Per requirement, route officers handle gate pass **and** route sheets **and**
dispatch sheets. `officer` previously had only direct-sales/gate-pass access.
Added `officer` to:

```
distribution.view / distribution.manage   (Dispatch Sheet)
route_sheets.view / route_sheets.manage   (Route Sheet)
```

Gate pass was already covered by `direct_sales.manage`.

File: `apps/api/src/middleware/admin-auth.ts`.

### 3d. Indent staff couldn't record indents ✅

`admin-indents.ts` (admin standing-indent / daily-draft management — the screens
Indent staff live in) gated all writes behind `dealers.manage`, which only
managers have. `call_desk` was locked out of its own core job.

Fixed by introducing dedicated permissions and re-gating that file:

```
indents.view   → super_admin, manager, call_desk, viewer
indents.manage → super_admin, manager, call_desk
```

This deliberately keeps indent recording **separate** from `dealers.manage`, so
Indent staff can place/edit indents without gaining dealer master-data (incl.
credit) write access.

Files: `apps/api/src/middleware/admin-auth.ts`, `apps/api/src/routes/admin-indents.ts`.

## 4. Verified correct (no change needed)

- **Finance** (`accountant`) has `finance.manage` but **not** `dealers.manage` →
  can edit credit limits but not other dealer master fields. ✔
- **Manager** does **not** have `finance.manage` → cannot edit credit limits. ✔
- **FGS** (`dispatch_officer`) has `inventory.update` + dispatch/route-sheet
  manage; no finance/orders write access. ✔
- **Route officer** (`officer`) has `direct_sales.manage`, `cash_customers.manage`,
  `orders.create`; no dealer/finance master write access. ✔

## 5. Known gaps / recommendations (not changed)

1. **Frontend module visibility is not role-gated.** `AppLayout` shows every
   module tab (Finance, Admin, …) to every logged-in user. The API correctly
   returns 403 for unauthorized actions, so this is a UX issue, not a security
   hole — but staff will see modules they can't use. Consider hiding module tabs
   based on `user.role`.
2. **Zone scoping.** All seeded users have `zoneId = null` (access to all zones).
   If FGS/route officers should be limited to a taluka, set `zoneId` per user.
